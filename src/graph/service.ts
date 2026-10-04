import type { Repos } from '../db/repos.js';
import type { Concept, ConceptEdge, EdgeKind, Subject } from '../domain/types.js';
import {
  Adjacency, ancestors, betweenness, components, descendants, findCycles, graphHealth,
  pageRank, planCurriculum, propagateMastery, shortestPath, topoSort, traceGaps, zpdFrontier,
  type GapTrace, type GraphHealth,
} from './algorithms.js';
import { SEED_CONCEPTS, SEED_ITEMS, SEED_MISCONCEPTIONS } from './seed.js';
import { LruCache } from '../core/cache.js';
import { bus } from '../core/events.js';
import { logger } from '../core/logger.js';
import { config } from '../core/config.js';
import { hyphenate } from '../core/textkit.js';
import { round } from '../core/mathx.js';
import { notFound, unprocessable } from '../core/errors.js';

/** EDGE DIRECTION CONVENTION
 *  A 'requires' edge points from the prerequisite to the thing it unlocks:
 *      counting --requires--> place-value
 *  reads as "place-value requires counting". Every algorithm here assumes it. */

export interface ConceptDetail extends Concept {
  prerequisites: Concept[];
  unlocks: Concept[];
  related: Concept[];
  contrasts: Concept[];
  terms: { term: string; definition: string; kidDefinition: string; syllables: string; importance: number }[];
  misconceptions: { id: string; code: string; label: string; severity: string }[];
  itemCount: number;
  centrality: number;
  depth: number;
}

export class GraphService {
  private adjCache = new LruCache<Adjacency>(4, 15_000);
  private metricCache = new LruCache<Map<string, number>>(8, 60_000);

  constructor(private repos: Repos) {}

  invalidate(): void {
    this.adjCache.clear();
    this.metricCache.clear();
  }

  adjacency(): Adjacency {
    const hit = this.adjCache.get('main');
    if (hit) return hit;
    const nodes = this.repos.concepts.all().map((c) => c.id);
    const edges = this.repos.edges.all();
    const adj = new Adjacency({ nodes, edges });
    this.adjCache.set('main', adj);
    return adj;
  }

  /* ------------------------------- writes -------------------------------- */

  createConcept(input: Partial<Concept> & { label: string }): Concept {
    const c = this.repos.concepts.create(input);
    this.invalidate();
    bus.emit('concept.created', { conceptId: c.id, label: c.label });
    return c;
  }

  link(fromSlugOrId: string, toSlugOrId: string, kind: EdgeKind, weight = 1, rationale?: string): ConceptEdge {
    const from = this.resolve(fromSlugOrId);
    const to = this.resolve(toSlugOrId);
    if (from.id === to.id) throw unprocessable('a concept cannot link to itself');

    const edge = this.repos.edges.link(from.id, to.id, kind, weight, rationale);
    this.invalidate();

    if (kind === 'requires') {
      const cycles = findCycles(this.adjacency());
      if (cycles.length) {
        this.repos.edges.unlink(from.id, to.id, kind);
        this.invalidate();
        throw unprocessable(
          `that prerequisite would create a cycle: ${cycles[0].map((idv) => this.repos.concepts.get(idv)?.label ?? idv).join(' -> ')}`,
          { cycle: cycles[0] },
        );
      }
    }
    bus.emit('graph.edge.created', { from: from.id, to: to.id, kind });
    return edge;
  }

  unlink(from: string, to: string, kind?: EdgeKind): number {
    const n = this.repos.edges.unlink(this.resolve(from).id, this.resolve(to).id, kind);
    this.invalidate();
    return n;
  }

  resolve(slugOrId: string): Concept {
    const byId = this.repos.concepts.get(slugOrId);
    if (byId) return byId;
    const bySlug = this.repos.concepts.bySlug(slugOrId);
    if (bySlug) return bySlug;
    throw notFound('concept', slugOrId);
  }

  tryResolve(slugOrId: string): Concept | undefined {
    return this.repos.concepts.get(slugOrId) ?? this.repos.concepts.bySlug(slugOrId);
  }

  /* -------------------------------- reads -------------------------------- */

  detail(slugOrId: string): ConceptDetail {
    const c = this.resolve(slugOrId);
    const adj = this.adjacency();
    const pr = this.centrality();
    const get = (idv: string) => this.repos.concepts.get(idv);
    const anc = ancestors(adj, c.id, 12);

    return {
      ...c,
      prerequisites: adj.prerequisites(c.id).map(get).filter(Boolean) as Concept[],
      unlocks: adj.unlocks(c.id).map(get).filter(Boolean) as Concept[],
      related: adj.outgoing(c.id, 'related').map((e) => get(e.to)).filter(Boolean) as Concept[],
      contrasts: [
        ...adj.outgoing(c.id, 'contrasts_with').map((e) => get(e.to)),
        ...adj.incoming(c.id, 'contrasts_with').map((e) => get(e.from)),
      ].filter(Boolean) as Concept[],
      terms: this.repos.terms.forConcept(c.id),
      misconceptions: this.repos.misconceptions.forConcept(c.id)
        .map((m) => ({ id: m.id, code: m.code, label: m.label, severity: m.severity })),
      itemCount: this.repos.items.forConcept(c.id).length,
      centrality: pr.get(c.id) ?? 0,
      depth: anc.size ? Math.max(...anc.values()) : 0,
    };
  }

  centrality(): Map<string, number> {
    const hit = this.metricCache.get('pagerank');
    if (hit) return hit;
    const pr = pageRank(this.adjacency());
    this.metricCache.set('pagerank', pr);
    return pr;
  }

  bottlenecks(limit = 10): { concept: Concept; betweenness: number }[] {
    let bw = this.metricCache.get('betweenness');
    if (!bw) {
      bw = betweenness(this.adjacency());
      this.metricCache.set('betweenness', bw);
    }
    return [...bw.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([idv, v]) => ({ concept: this.repos.concepts.get(idv)!, betweenness: v }))
      .filter((x) => x.concept);
  }

  ordering(): { order: Concept[]; cyclic: string[] } {
    const { order, cyclic } = topoSort(this.adjacency());
    return { order: order.map((idv) => this.repos.concepts.get(idv)!).filter(Boolean), cyclic };
  }

  path(from: string, to: string): { path: Concept[]; cost: number } | null {
    const r = shortestPath(this.adjacency(), this.resolve(from).id, this.resolve(to).id);
    if (!r) return null;
    return { path: r.path.map((idv) => this.repos.concepts.get(idv)!).filter(Boolean), cost: r.cost };
  }

  prerequisiteClosure(slugOrId: string, maxDepth = 8): { concept: Concept; depth: number }[] {
    const c = this.resolve(slugOrId);
    return [...ancestors(this.adjacency(), c.id, maxDepth).entries()]
      .map(([idv, depth]) => ({ concept: this.repos.concepts.get(idv)!, depth }))
      .filter((x) => x.concept)
      .sort((a, b) => b.depth - a.depth);
  }

  downstream(slugOrId: string, maxDepth = 8): { concept: Concept; depth: number }[] {
    const c = this.resolve(slugOrId);
    return [...descendants(this.adjacency(), c.id, maxDepth).entries()]
      .map(([idv, depth]) => ({ concept: this.repos.concepts.get(idv)!, depth }))
      .filter((x) => x.concept)
      .sort((a, b) => a.depth - b.depth);
  }

  /** Mastery lookup for a learner, with graph-propagated beliefs for unseen concepts. */
  masteryLookup(learnerId: string, opts: { propagate?: boolean } = {}): (conceptId: string) => number {
    const records = this.repos.mastery.forLearner(learnerId);
    const observed = new Map(records.filter((r) => r.attempts > 0).map((r) => [r.conceptId, r.pKnown]));
    const direct = new Map(records.map((r) => [r.conceptId, r.pKnown]));
    if (opts.propagate === false) return (idv) => direct.get(idv) ?? 0.15;
    const belief = propagateMastery(this.adjacency(), observed);
    return (idv) => direct.get(idv) ?? belief.get(idv) ?? 0.15;
  }

  /** THE GAP TRACE - the system's single most important diagnostic. */
  traceGaps(learnerId: string, targetSlugOrId: string, threshold = config.pedagogy.masteryThreshold): GapTrace & {
    gapConcepts: { concept: Concept; depth: number; mastery: number; blocking: number }[];
    routeConcepts: Concept[];
  } {
    const target = this.resolve(targetSlugOrId);
    const mastery = this.masteryLookup(learnerId);
    const trace = traceGaps(this.adjacency(), target.id, mastery, {
      threshold, maxDepth: config.pedagogy.maxPrereqTraceDepth,
    });

    if (trace.gaps.length) {
      bus.emit('prereq.gap.found', {
        learnerId, targetConceptId: target.id, gapConceptIds: trace.gaps.map((g) => g.conceptId),
      });
    }

    const label = (idv: string) => this.repos.concepts.get(idv);
    const gapConcepts = trace.gaps
      .map((g) => ({ ...g, concept: label(g.conceptId)! }))
      .filter((g) => g.concept);
    return {
      ...trace,
      explanation: trace.gaps.length
        ? trace.explanation.replace(trace.gaps[0].conceptId, label(trace.gaps[0].conceptId)?.label ?? trace.gaps[0].conceptId)
        : trace.explanation,
      gapConcepts,
      routeConcepts: trace.route.map(label).filter(Boolean) as Concept[],
    };
  }

  /** What this learner is ready to learn right now. */
  frontier(learnerId: string, opts: { subject?: Subject; limit?: number } = {}) {
    const mastery = this.masteryLookup(learnerId);
    const learner = this.repos.learners.require(learnerId);
    const raw = zpdFrontier(this.adjacency(), mastery, {
      known: config.pedagogy.masteryThreshold * 0.85,
      limit: (opts.limit ?? 10) * 3,
    });
    return raw
      .map((r) => ({ ...r, concept: this.repos.concepts.get(r.conceptId)! }))
      .filter((r) => r.concept)
      .filter((r) => !opts.subject || r.concept.subject === opts.subject)
      // Keep it grade-appropriate: a 6th grader should not be offered calculus.
      .filter((r) => r.concept.gradeMin <= learner.grade + 2)
      .map((r) => ({
        conceptId: r.conceptId,
        concept: r.concept,
        readiness: r.readiness,
        unlocks: r.unlocks,
        prereqMastery: r.prereqMastery,
        gradeFit: round(1 - Math.min(1, Math.abs(((r.concept.gradeMin + r.concept.gradeMax) / 2) - learner.grade) / 6), 3),
      }))
      .map((r) => ({ ...r, score: round(r.readiness * 0.7 + r.gradeFit * 0.3, 3) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit ?? 10);
  }

  plan(learnerId: string, goals: string[], maxItems = 25) {
    const ids = goals.map((g) => this.resolve(g).id);
    const { order, skipped } = planCurriculum(this.adjacency(), ids, this.masteryLookup(learnerId), {
      threshold: config.pedagogy.masteryThreshold, maxItems,
    });
    return {
      order: order.map((idv) => this.repos.concepts.get(idv)!).filter(Boolean),
      alreadyKnown: skipped.map((idv) => this.repos.concepts.get(idv)!).filter(Boolean),
    };
  }

  health(): GraphHealth & { clusters: { size: number; subjects: string[] }[] } {
    const adj = this.adjacency();
    const difficulty = (idv: string) => this.repos.concepts.get(idv)?.difficulty ?? 0.5;
    const gradeMin = (idv: string) => this.repos.concepts.get(idv)?.gradeMin ?? 0;
    const h = graphHealth(adj, difficulty, gradeMin);
    const clusters = components(adj).slice(0, 10).map((comp) => ({
      size: comp.length,
      subjects: [...new Set(comp.map((idv) => this.repos.concepts.get(idv)?.subject ?? 'unknown'))],
    }));
    return { ...h, clusters };
  }

  /** Graph shaped for a visualiser: nodes with position hints by depth/subject. */
  export(opts: { subject?: Subject; learnerId?: string } = {}) {
    const adj = this.adjacency();
    const pr = this.centrality();
    const mastery = opts.learnerId ? this.masteryLookup(opts.learnerId) : null;
    const concepts = opts.subject
      ? this.repos.concepts.list({ subject: opts.subject, limit: 1000 })
      : this.repos.concepts.all();
    const keep = new Set(concepts.map((c) => c.id));

    const nodes = concepts.map((c) => {
      const anc = ancestors(adj, c.id, 14);
      return {
        id: c.id,
        slug: c.slug,
        label: c.label,
        subject: c.subject,
        grade: [c.gradeMin, c.gradeMax] as [number, number],
        difficulty: c.difficulty,
        depth: anc.size ? Math.max(...anc.values()) : 0,
        centrality: pr.get(c.id) ?? 0,
        unlocks: adj.unlocks(c.id).length,
        prerequisites: adj.prerequisites(c.id).length,
        ...(mastery ? { mastery: round(mastery(c.id), 3) } : {}),
      };
    });

    const edges = this.repos.edges.all()
      .filter((e) => keep.has(e.from) && keep.has(e.to))
      .map((e) => ({ from: e.from, to: e.to, kind: e.kind, weight: e.weight, rationale: e.rationale }));

    return { nodes, edges, stats: { nodes: nodes.length, edges: edges.length } };
  }
}

/* ================================ seeding ================================ */

export interface SeedReport {
  gradeAdjustments: { slug: string; from: number; to: number; because: string }[];
  concepts: number;
  edges: number;
  terms: number;
  misconceptions: number;
  items: number;
  skipped: string[];
  warnings: string[];
}

/** Idempotent: safe to run on every boot. */
export function seedCurriculum(repos: Repos, graph: GraphService): SeedReport {
  const report: SeedReport = {
    gradeAdjustments: [], concepts: 0, edges: 0, terms: 0, misconceptions: 0, items: 0, skipped: [], warnings: [],
  };
  const bySlug = new Map<string, string>();

  repos.db.tx(() => {
    for (const s of SEED_CONCEPTS) {
      const existing = repos.concepts.bySlug(s.slug);
      if (existing) {
        bySlug.set(s.slug, existing.id);
        report.skipped.push(s.slug);
      } else {
        const c = repos.concepts.create({
          slug: s.slug, label: s.label, description: s.description, subject: s.subject,
          gradeMin: s.grades[0], gradeMax: s.grades[1], difficulty: s.difficulty,
          bloom: s.bloom ?? 'understand', tags: s.tags ?? [], standards: s.standards ?? [],
          meta: { seeded: true },
        });
        bySlug.set(s.slug, c.id);
        report.concepts++;
      }

      for (const [term, definition] of s.terms ?? []) {
        repos.terms.put(bySlug.get(s.slug)!, {
          term, definition, kidDefinition: definition,
          syllables: hyphenate(term).join('-'), importance: 0.9,
        });
        report.terms++;
      }
    }

    const edge = (from: string, to: string, kind: EdgeKind, weight: number, why: string) => {
      const f = bySlug.get(from), t = bySlug.get(to);
      if (!f || !t) { report.warnings.push(`edge skipped, unknown slug: ${from} -> ${to}`); return; }
      repos.edges.link(f, t, kind, weight, why);
      report.edges++;
    };

    for (const s of SEED_CONCEPTS) {
      for (const p of s.requires ?? []) edge(p, s.slug, 'requires', 1, `${s.label} builds directly on ${p}`);
      for (const n of s.leadsTo ?? []) edge(s.slug, n, 'leads_to', 0.8, `${s.label} is the natural step before ${n}`);
      for (const r of s.relatedTo ?? []) edge(s.slug, r, 'related', 0.5, 'lateral connection');
      for (const c of s.contrastsWith ?? []) {
        if (c !== s.slug) edge(s.slug, c, 'contrasts_with', 0.6, 'commonly confused pair');
      }
      for (const a of s.appliesTo ?? []) edge(s.slug, a, 'applies_to', 0.7, `${s.label} is a tool used by ${a}`);
    }

    for (const m of SEED_MISCONCEPTIONS) {
      const conceptId = bySlug.get(m.concept) ?? null;
      if (!conceptId) { report.warnings.push(`misconception ${m.code} references unknown concept ${m.concept}`); continue; }
      repos.misconceptions.upsert({
        conceptId, code: m.code, label: m.label, description: m.description, subject: m.subject,
        severity: m.severity, detector: m.detector,
        signature: { conceptSlug: m.concept, wrong: m.wrong ?? null, right: m.right ?? null },
        remediation: {
          strategy: m.strategy,
          steps: m.steps,
          modality: m.subject === 'math' ? 'manipulative' : 'animation',
          ...(m.wrong && m.right ? { contrastPair: { wrong: m.wrong, right: m.right } } : {}),
          ...(m.prereqCheck ? { prerequisiteCheck: m.prereqCheck } : {}),
          practiceSpec: { count: 3, kind: 'targeted', focus: m.code },
        },
      });
      report.misconceptions++;
    }

    for (const it of SEED_ITEMS) {
      const conceptId = bySlug.get(it.concept);
      if (!conceptId) { report.warnings.push(`item references unknown concept ${it.concept}`); continue; }
      if (repos.db.count('SELECT COUNT(*) FROM items WHERE concept_id=? AND stem=?', [conceptId, it.stem])) continue;
      const misconceptionMap: Record<string, string> = {};
      for (const ch of it.choices ?? []) if (ch.misconceptionCode) misconceptionMap[ch.key] = ch.misconceptionCode;
      repos.items.create({
        conceptId, kind: it.kind, stem: it.stem,
        choices: (it.choices ?? []).map((c) => ({ key: c.key, text: c.text, misconceptionCode: c.misconceptionCode })),
        answer: { value: it.answer },
        rubric: {}, difficulty: it.difficulty, discrimination: it.discrimination ?? 1.2,
        guessing: it.kind === 'mcq' ? 1 / Math.max(2, (it.choices ?? []).length) : 0,
        misconceptionMap, bloom: it.bloom ?? 'apply', pCorrect: null,
        accessibility: {}, meta: { seeded: true },
      });
      report.items++;
    }
  });

  graph.invalidate();
  report.gradeAdjustments = normalizeGradeSequencing(repos, graph);

  graph.invalidate();
  logger.info('curriculum seeded', {
    concepts: report.concepts, edges: report.edges, misconceptions: report.misconceptions,
    items: report.items, reused: report.skipped.length, gradeAdjustments: report.gradeAdjustments.length,
  });
  return report;
}

/** A concept can never be introduced earlier than its own prerequisites.
 *
 *  Curriculum authors routinely declare a dependency that breaks their own
 *  grade banding (photosynthesis at grade 5 "requires" chemical reactions at
 *  grade 6). Rather than silently shipping an impossible sequence, push each
 *  concept's entry grade forward through the prerequisite order until the whole
 *  graph is walkable - and report every change. */
export function normalizeGradeSequencing(
  repos: Repos,
  graph: GraphService,
): { slug: string; from: number; to: number; because: string }[] {
  const adj = graph.adjacency();
  const { order } = topoSort(adj);
  const changes: { slug: string; from: number; to: number; because: string }[] = [];

  repos.db.tx(() => {
    for (const id of order) {
      const c = repos.concepts.get(id);
      if (!c) continue;
      const prereqs = adj.prerequisites(id)
        .map((p) => repos.concepts.get(p))
        .filter(Boolean) as Concept[];
      if (!prereqs.length) continue;

      const latest = prereqs.reduce((a, b) => (b.gradeMin > a.gradeMin ? b : a));
      if (latest.gradeMin <= c.gradeMin) continue;

      repos.concepts.update(id, {
        gradeMin: latest.gradeMin,
        gradeMax: Math.max(c.gradeMax, latest.gradeMin),
      });
      changes.push({
        slug: c.slug,
        from: c.gradeMin,
        to: latest.gradeMin,
        because: `prerequisite '${latest.slug}' is not introduced until grade ${latest.gradeMin}`,
      });
    }
  });
  return changes;
}
