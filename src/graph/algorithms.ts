import type { ConceptEdge, EdgeKind } from '../domain/types.js';
import { clamp, round } from '../core/mathx.js';

/** Pure graph algorithms over the curriculum. No I/O, fully testable. */

export interface GraphView {
  nodes: string[];
  edges: ConceptEdge[];
}

export class Adjacency {
  readonly out = new Map<string, ConceptEdge[]>();
  readonly in = new Map<string, ConceptEdge[]>();
  readonly nodes: Set<string>;

  constructor(view: GraphView) {
    this.nodes = new Set(view.nodes);
    for (const e of view.edges) {
      this.nodes.add(e.from);
      this.nodes.add(e.to);
      (this.out.get(e.from) ?? this.out.set(e.from, []).get(e.from)!).push(e);
      (this.in.get(e.to) ?? this.in.set(e.to, []).get(e.to)!).push(e);
    }
  }

  outgoing(id: string, kind?: EdgeKind): ConceptEdge[] {
    const all = this.out.get(id) ?? [];
    return kind ? all.filter((e) => e.kind === kind) : all;
  }
  incoming(id: string, kind?: EdgeKind): ConceptEdge[] {
    const all = this.in.get(id) ?? [];
    return kind ? all.filter((e) => e.kind === kind) : all;
  }
  /** Concepts this one needs first. 'A requires B' is stored as B --requires--> A. */
  prerequisites(id: string): string[] {
    return this.incoming(id, 'requires').map((e) => e.from);
  }
  /** Concepts unlocked by knowing this one. */
  unlocks(id: string): string[] {
    return [...new Set([
      ...this.outgoing(id, 'requires').map((e) => e.to),
      ...this.outgoing(id, 'leads_to').map((e) => e.to),
    ])];
  }
  degree(id: string): number {
    return this.outgoing(id).length + this.incoming(id).length;
  }
}

/* ------------------------------ ordering --------------------------------- */

export function topoSort(adj: Adjacency, kinds: EdgeKind[] = ['requires']): { order: string[]; cyclic: string[] } {
  const indeg = new Map<string, number>();
  for (const n of adj.nodes) indeg.set(n, 0);
  for (const n of adj.nodes) {
    for (const e of adj.incoming(n)) {
      if (kinds.includes(e.kind)) indeg.set(n, (indeg.get(n) ?? 0) + 1);
    }
  }
  const queue = [...adj.nodes].filter((n) => (indeg.get(n) ?? 0) === 0).sort();
  const order: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const e of adj.outgoing(n)) {
      if (!kinds.includes(e.kind)) continue;
      const d = (indeg.get(e.to) ?? 0) - 1;
      indeg.set(e.to, d);
      if (d === 0) queue.push(e.to);
    }
  }
  const cyclic = [...adj.nodes].filter((n) => !order.includes(n));
  return { order, cyclic };
}

/** All simple cycles (up to a cap) in the prerequisite relation. */
export function findCycles(adj: Adjacency, kinds: EdgeKind[] = ['requires'], maxCycles = 25): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const dfs = (n: string): void => {
    if (cycles.length >= maxCycles) return;
    state.set(n, 1);
    stack.push(n);
    for (const e of adj.outgoing(n)) {
      if (!kinds.includes(e.kind)) continue;
      const s = state.get(e.to) ?? 0;
      if (s === 1) {
        const at = stack.indexOf(e.to);
        if (at >= 0) cycles.push([...stack.slice(at), e.to]);
      } else if (s === 0) dfs(e.to);
    }
    stack.pop();
    state.set(n, 2);
  };

  for (const n of [...adj.nodes].sort()) if ((state.get(n) ?? 0) === 0) dfs(n);
  return cycles;
}

/* ----------------------------- reachability ------------------------------ */

export function ancestors(adj: Adjacency, id: string, maxDepth = 8, kinds: EdgeKind[] = ['requires']): Map<string, number> {
  const seen = new Map<string, number>();
  let frontier = [id];
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next: string[] = [];
    for (const n of frontier) {
      for (const e of adj.incoming(n)) {
        if (!kinds.includes(e.kind)) continue;
        if (seen.has(e.from) || e.from === id) continue;
        seen.set(e.from, depth);
        next.push(e.from);
      }
    }
    frontier = next;
  }
  return seen;
}

export function descendants(adj: Adjacency, id: string, maxDepth = 8, kinds: EdgeKind[] = ['requires', 'leads_to']): Map<string, number> {
  const seen = new Map<string, number>();
  let frontier = [id];
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next: string[] = [];
    for (const n of frontier) {
      for (const e of adj.outgoing(n)) {
        if (!kinds.includes(e.kind)) continue;
        if (seen.has(e.to) || e.to === id) continue;
        seen.set(e.to, depth);
        next.push(e.to);
      }
    }
    frontier = next;
  }
  return seen;
}

/** Dijkstra over 1/weight, so a strong edge is a short hop. */
export function shortestPath(adj: Adjacency, from: string, to: string, kinds?: EdgeKind[]): { path: string[]; cost: number } | null {
  if (from === to) return { path: [from], cost: 0 };
  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, string>();
  const visited = new Set<string>();

  for (;;) {
    let best: string | null = null;
    let bestD = Infinity;
    for (const [n, d] of dist) {
      if (!visited.has(n) && d < bestD) { best = n; bestD = d; }
    }
    if (best === null) break;
    if (best === to) break;
    visited.add(best);
    for (const e of adj.outgoing(best)) {
      if (kinds && !kinds.includes(e.kind)) continue;
      const w = 1 / Math.max(0.05, e.weight);
      const nd = bestD + w;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, best);
      }
    }
  }
  if (!dist.has(to)) return null;
  const path = [to];
  let cur = to;
  while (prev.has(cur)) { cur = prev.get(cur)!; path.unshift(cur); }
  return { path, cost: round(dist.get(to)!, 4) };
}

/* ------------------------- pedagogical analysis --------------------------- */

export interface GapTrace {
  target: string;
  ready: boolean;
  /** Concepts to repair, root-cause first. */
  gaps: { conceptId: string; depth: number; mastery: number; blocking: number }[];
  /** Full ordered repair route ending at the target. */
  route: string[];
  explanation: string;
}

/** THE PREREQUISITE TRACE.
 *
 *  A learner fails at ratios. The naive system reteaches ratios. This walks
 *  backwards through the prerequisite closure and finds that division is the
 *  real hole - then returns the repair route root-cause first. */
export function traceGaps(
  adj: Adjacency,
  target: string,
  mastery: (conceptId: string) => number,
  opts: { threshold?: number; maxDepth?: number } = {},
): GapTrace {
  const threshold = opts.threshold ?? 0.7;
  const maxDepth = opts.maxDepth ?? 6;
  const anc = ancestors(adj, target, maxDepth);

  const weak = [...anc.entries()]
    .map(([conceptId, depth]) => ({ conceptId, depth, mastery: round(mastery(conceptId), 3) }))
    .filter((x) => x.mastery < threshold);

  // "blocking" = how much of the weak set sits downstream of this concept.
  const weakIds = new Set(weak.map((w) => w.conceptId));
  const gaps = weak.map((w) => {
    const desc = descendants(adj, w.conceptId, maxDepth, ['requires']);
    const blocks = [...desc.keys()].filter((d) => weakIds.has(d) || d === target).length;
    return { ...w, blocking: blocks };
  }).sort((a, b) =>
    b.depth - a.depth            // deepest root cause first
    || b.blocking - a.blocking   // then whatever unblocks the most
    || a.mastery - b.mastery,
  );

  const targetMastery = mastery(target);
  const ordered = topoSort(adj).order;
  const rank = new Map(ordered.map((idv, i) => [idv, i]));
  const route = [...gaps.map((g) => g.conceptId)]
    .sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
  route.push(target);

  const explanation = gaps.length === 0
    ? `Every prerequisite for this concept is above ${Math.round(threshold * 100)}%. The difficulty is in the concept itself, not the foundation.`
    : `The visible struggle is at the target, but ${gaps.length} upstream concept${gaps.length > 1 ? 's are' : ' is'} weak. `
      + `Deepest root cause: ${gaps[0].conceptId} at ${Math.round(gaps[0].mastery * 100)}% mastery, `
      + `${gaps[0].depth} step${gaps[0].depth > 1 ? 's' : ''} upstream, blocking ${gaps[0].blocking} downstream concept(s). `
      + `Repair that before returning to the target.`;

  return {
    target,
    ready: gaps.length === 0 && targetMastery < threshold,
    gaps,
    route: [...new Set(route)],
    explanation,
  };
}

/** Concepts whose prerequisites are satisfied but which are not yet learned:
 *  the zone of proximal development, computed rather than guessed. */
export function zpdFrontier(
  adj: Adjacency,
  mastery: (conceptId: string) => number,
  opts: { known?: number; learned?: number; limit?: number } = {},
): { conceptId: string; readiness: number; unlocks: number; prereqMastery: number }[] {
  const known = opts.known ?? 0.7;
  const learned = opts.learned ?? 0.85;
  const out: { conceptId: string; readiness: number; unlocks: number; prereqMastery: number }[] = [];

  for (const n of adj.nodes) {
    const m = mastery(n);
    if (m >= learned) continue;
    const prereqs = adj.prerequisites(n);
    const pm = prereqs.length ? prereqs.reduce((a, p) => a + mastery(p), 0) / prereqs.length : 1;
    const allReady = prereqs.every((p) => mastery(p) >= known);
    if (!allReady && prereqs.length) continue;
    // Peak readiness when the learner is partway in - not at 0, not nearly done.
    const sweetSpot = 1 - Math.abs(m - 0.35) / 0.65;
    out.push({
      conceptId: n,
      readiness: round(clamp(0.55 * clamp(sweetSpot) + 0.3 * pm + 0.15 * (1 - m)), 3),
      unlocks: adj.unlocks(n).length,
      prereqMastery: round(pm, 3),
    });
  }
  return out.sort((a, b) => b.readiness - a.readiness || b.unlocks - a.unlocks).slice(0, opts.limit ?? 12);
}

/** PageRank over the prerequisite graph: which concepts are load-bearing. */
export function pageRank(adj: Adjacency, opts: { damping?: number; iterations?: number } = {}): Map<string, number> {
  const d = opts.damping ?? 0.85;
  const iterations = opts.iterations ?? 40;
  const nodes = [...adj.nodes];
  const n = nodes.length || 1;
  let rank = new Map(nodes.map((idv) => [idv, 1 / n]));

  for (let it = 0; it < iterations; it++) {
    const next = new Map(nodes.map((idv) => [idv, (1 - d) / n]));
    let dangling = 0;
    for (const node of nodes) {
      const outs = adj.outgoing(node);
      const r = rank.get(node) ?? 0;
      if (!outs.length) { dangling += r; continue; }
      const totalW = outs.reduce((a, e) => a + Math.max(0.01, e.weight), 0);
      for (const e of outs) {
        next.set(e.to, (next.get(e.to) ?? 0) + d * r * (Math.max(0.01, e.weight) / totalW));
      }
    }
    for (const node of nodes) next.set(node, (next.get(node) ?? 0) + d * dangling / n);
    rank = next;
  }
  return new Map([...rank.entries()].map(([k, v]) => [k, round(v, 6)]));
}

/** Brandes betweenness: concepts that are bottlenecks between topic clusters. */
export function betweenness(adj: Adjacency): Map<string, number> {
  const nodes = [...adj.nodes];
  const cb = new Map<string, number>(nodes.map((n) => [n, 0]));

  for (const s of nodes) {
    const stack: string[] = [];
    const preds = new Map<string, string[]>(nodes.map((n) => [n, []]));
    const sigma = new Map<string, number>(nodes.map((n) => [n, 0]));
    const dist = new Map<string, number>(nodes.map((n) => [n, -1]));
    sigma.set(s, 1);
    dist.set(s, 0);
    const queue = [s];
    while (queue.length) {
      const v = queue.shift()!;
      stack.push(v);
      for (const e of adj.outgoing(v)) {
        const w = e.to;
        if ((dist.get(w) ?? -1) < 0) { dist.set(w, (dist.get(v) ?? 0) + 1); queue.push(w); }
        if (dist.get(w) === (dist.get(v) ?? 0) + 1) {
          sigma.set(w, (sigma.get(w) ?? 0) + (sigma.get(v) ?? 0));
          preds.get(w)!.push(v);
        }
      }
    }
    const delta = new Map<string, number>(nodes.map((n) => [n, 0]));
    while (stack.length) {
      const w = stack.pop()!;
      for (const v of preds.get(w) ?? []) {
        const c = ((sigma.get(v) ?? 0) / (sigma.get(w) || 1)) * (1 + (delta.get(w) ?? 0));
        delta.set(v, (delta.get(v) ?? 0) + c);
      }
      if (w !== s) cb.set(w, (cb.get(w) ?? 0) + (delta.get(w) ?? 0));
    }
  }
  const scale = nodes.length > 2 ? 1 / ((nodes.length - 1) * (nodes.length - 2)) : 1;
  return new Map([...cb.entries()].map(([k, v]) => [k, round(v * scale, 6)]));
}

/** Weakly-connected components: the natural topic clusters. */
export function components(adj: Adjacency): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const n of [...adj.nodes].sort()) {
    if (seen.has(n)) continue;
    const comp: string[] = [];
    const queue = [n];
    seen.add(n);
    while (queue.length) {
      const c = queue.shift()!;
      comp.push(c);
      for (const e of [...adj.outgoing(c), ...adj.incoming(c)]) {
        const other = e.from === c ? e.to : e.from;
        if (!seen.has(other)) { seen.add(other); queue.push(other); }
      }
    }
    out.push(comp.sort());
  }
  return out.sort((a, b) => b.length - a.length);
}

/** Spread evidence through the graph: knowing a concept is weak evidence that
 *  its prerequisites are known and its successors are not. */
export function propagateMastery(
  adj: Adjacency,
  observed: Map<string, number>,
  opts: { backward?: number; forward?: number; iterations?: number } = {},
): Map<string, number> {
  const back = opts.backward ?? 0.35;
  const fwd = opts.forward ?? 0.18;
  const iterations = opts.iterations ?? 3;
  const belief = new Map(observed);
  const prior = 0.15;
  for (const n of adj.nodes) if (!belief.has(n)) belief.set(n, prior);

  for (let it = 0; it < iterations; it++) {
    const next = new Map(belief);
    for (const n of adj.nodes) {
      if (observed.has(n)) continue;
      const prereqs = adj.prerequisites(n);
      const succs = adj.outgoing(n, 'requires').map((e) => e.to);
      let value = belief.get(n) ?? prior;
      if (succs.length) {
        // Knowing a successor implies the prerequisite is known.
        const evidence = Math.max(...succs.map((s) => belief.get(s) ?? prior));
        value = value + back * (evidence - value) * (evidence > value ? 1 : 0.3);
      }
      if (prereqs.length) {
        const cap = Math.min(...prereqs.map((p) => belief.get(p) ?? prior)) + 0.25;
        if (value > cap) value = value + fwd * (cap - value);
      }
      next.set(n, round(clamp(value), 4));
    }
    for (const [k, v] of next) belief.set(k, v);
  }
  return belief;
}

/* ------------------------------ graph health ------------------------------ */

export interface GraphHealth {
  nodes: number;
  edges: number;
  edgeKinds: Record<string, number>;
  cycles: string[][];
  orphans: string[];
  roots: string[];
  leaves: number;
  components: number;
  largestComponent: number;
  maxDepth: number;
  avgPrereqs: number;
  /** Prerequisites introduced at a LATER grade than the concept they unlock.
   *  A harder-but-earlier prerequisite is normal (deep idea, shallow
   *  application); a later one is a genuine curriculum ordering bug. */
  sequencingErrors: { from: string; to: string; fromGrade: number; toGrade: number }[];
  warnings: string[];
}

export function graphHealth(
  adj: Adjacency,
  difficulty: (id: string) => number,
  gradeMin: (id: string) => number = () => 0,
): GraphHealth {
  const nodes = [...adj.nodes];
  const edges = nodes.flatMap((n) => adj.outgoing(n));
  const edgeKinds: Record<string, number> = {};
  for (const e of edges) edgeKinds[e.kind] = (edgeKinds[e.kind] ?? 0) + 1;

  const cycles = findCycles(adj);
  const orphans = nodes.filter((n) => adj.degree(n) === 0);
  const roots = nodes.filter((n) => adj.prerequisites(n).length === 0 && adj.outgoing(n).length > 0);
  const leaves = nodes.filter((n) => adj.unlocks(n).length === 0).length;
  const comps = components(adj);

  const depths = nodes.map((n) => {
    const a = ancestors(adj, n, 20);
    return a.size ? Math.max(...a.values()) : 0;
  });

  const inversions: GraphHealth['sequencingErrors'] = [];
  for (const e of edges) {
    if (e.kind !== 'requires') continue;
    const fromGrade = gradeMin(e.from);
    const toGrade = gradeMin(e.to);
    if (fromGrade > toGrade && difficulty(e.from) > difficulty(e.to)) {
      inversions.push({ from: e.from, to: e.to, fromGrade, toGrade });
    }
  }
  void difficulty;

  const warnings: string[] = [];
  if (cycles.length) warnings.push(`${cycles.length} prerequisite cycle(s) - a learner could never start`);
  if (orphans.length) warnings.push(`${orphans.length} concept(s) with no links at all`);
  if (comps.length > 1) warnings.push(`${comps.length} disconnected clusters - no path between them`);
  if (inversions.length) warnings.push(`${inversions.length} edge(s) where the prerequisite is taught later than what it unlocks`);
  if (!roots.length && nodes.length) warnings.push('no entry point: every concept has a prerequisite');

  const prereqCounts = nodes.map((n) => adj.prerequisites(n).length);
  return {
    nodes: nodes.length,
    edges: edges.length,
    edgeKinds,
    cycles,
    orphans,
    roots,
    leaves,
    components: comps.length,
    largestComponent: comps[0]?.length ?? 0,
    maxDepth: depths.length ? Math.max(...depths) : 0,
    avgPrereqs: round(prereqCounts.reduce((a, b) => a + b, 0) / Math.max(1, nodes.length), 2),
    sequencingErrors: inversions,
    warnings,
  };
}

/** Minimal ordered curriculum covering every goal, respecting prerequisites. */
export function planCurriculum(
  adj: Adjacency,
  goals: string[],
  mastery: (id: string) => number,
  opts: { threshold?: number; maxItems?: number } = {},
): { order: string[]; skipped: string[] } {
  const threshold = opts.threshold ?? 0.8;
  const needed = new Set<string>();
  const skipped: string[] = [];

  const visit = (idv: string, depth = 0): void => {
    if (depth > 12 || needed.has(idv)) return;
    if (mastery(idv) >= threshold) { skipped.push(idv); return; }
    for (const p of adj.prerequisites(idv)) visit(p, depth + 1);
    needed.add(idv);
  };
  for (const g of goals) visit(g);

  const rank = new Map(topoSort(adj).order.map((idv, i) => [idv, i]));
  const order = [...needed].sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9));
  return { order: order.slice(0, opts.maxItems ?? 100), skipped: [...new Set(skipped)] };
}
