import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { validate } from './core.routes.js';
import { ALL_MODALITIES, ALL_NEEDS, type AccessNeed, type Modality, type Subject } from '../../domain/types.js';
import { transform } from '../../accessibility/transformer.js';
import { analyzeReadability, rankSentences } from '../../accessibility/readability.js';
import { simplify } from '../../accessibility/simplify.js';
import { buildRenderPlan, COLOR_PROFILES, contrastRatio } from '../../accessibility/dyslexia.js';
import { buildAudioScript, toWebVtt } from '../../accessibility/ssml.js';
import { decodeSupport, decodingReport } from '../../accessibility/phonics.js';
import { resolveSpec } from '../../accessibility/profiles.js';
import { runLab, describeLabs, getLab, labDefaults, labsForConcept } from '../../engines/sim/lab.js';
import { renderSvg } from '../../engines/animation/svg.js';
import { badRequest, notFound } from '../../core/errors.js';
import { jobs } from '../../core/jobs.js';

const needs = z.array(z.enum(ALL_NEEDS as [AccessNeed, ...AccessNeed[]])).optional();
const modality = z.enum(ALL_MODALITIES as [Modality, ...Modality[]]).optional();

export async function learningRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  /* ============================== curriculum ============================= */

  app.get('/v1/concepts', async (req) => {
    const q = req.query as { subject?: string; grade?: string; q?: string; limit?: string; offset?: string };
    const concepts = ctx.repos.concepts.list({
      subject: q.subject,
      grade: q.grade ? Number(q.grade) : undefined,
      q: q.q,
      limit: Math.min(Number(q.limit ?? 50), 200),
      offset: Number(q.offset ?? 0),
    });
    return { concepts, total: ctx.repos.concepts.count() };
  });

  app.get('/v1/concepts/:id', async (req) => {
    const { id } = req.params as { id: string };
    return ctx.graph.detail(id);
  });

  app.post('/v1/concepts', async (req, reply) => {
    const body = validate(z.object({
      label: z.string().min(2).max(120),
      slug: z.string().optional(),
      description: z.string().max(2000).optional(),
      subject: z.string().optional(),
      gradeMin: z.number().int().min(0).max(13).optional(),
      gradeMax: z.number().int().min(0).max(13).optional(),
      difficulty: z.number().min(0).max(1).optional(),
      tags: z.array(z.string()).optional(),
    }), req.body);
    reply.status(201);
    return ctx.graph.createConcept(body as never);
  });

  app.post('/v1/concepts/:id/links', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = validate(z.object({
      to: z.string().min(1),
      kind: z.enum(['requires', 'leads_to', 'related', 'generalizes', 'contrasts_with', 'applies_to']),
      weight: z.number().min(0).max(5).optional(),
      rationale: z.string().max(400).optional(),
    }), req.body);
    reply.status(201);
    return ctx.graph.link(id, body.to, body.kind, body.weight ?? 1, body.rationale);
  });

  /* ================================ graph =============================== */

  app.get('/v1/graph', async (req) => {
    const q = req.query as { subject?: string; learnerId?: string };
    return ctx.graph.export({ subject: q.subject as Subject | undefined, learnerId: q.learnerId });
  });

  app.get('/v1/graph/health', async () => ctx.graph.health());

  app.get('/v1/graph/ordering', async () => {
    const { order, cyclic } = ctx.graph.ordering();
    return { order: order.map((c) => ({ id: c.id, slug: c.slug, label: c.label, subject: c.subject })), cyclic };
  });

  app.get('/v1/graph/central', async (req) => {
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 15), 50);
    const pr = [...ctx.graph.centrality().entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    return {
      loadBearing: pr.map(([id, score]) => {
        const c = ctx.repos.concepts.get(id);
        return { id, slug: c?.slug, label: c?.label, subject: c?.subject, centrality: score };
      }).filter((x) => x.label),
      bottlenecks: ctx.graph.bottlenecks(limit).map((b) => ({
        id: b.concept.id, slug: b.concept.slug, label: b.concept.label, betweenness: b.betweenness,
      })),
    };
  });

  app.get('/v1/graph/path', async (req) => {
    const q = req.query as { from?: string; to?: string };
    if (!q.from || !q.to) throw badRequest('from and to are required');
    const r = ctx.graph.path(q.from, q.to);
    if (!r) return { found: false, path: [], cost: null };
    return {
      found: true,
      cost: r.cost,
      path: r.path.map((c) => ({ id: c.id, slug: c.slug, label: c.label, difficulty: c.difficulty })),
    };
  });

  app.get('/v1/concepts/:id/prerequisites', async (req) => {
    const { id } = req.params as { id: string };
    return {
      upstream: ctx.graph.prerequisiteClosure(id).map((x) => ({
        depth: x.depth, id: x.concept.id, slug: x.concept.slug, label: x.concept.label,
      })),
      downstream: ctx.graph.downstream(id).map((x) => ({
        depth: x.depth, id: x.concept.id, slug: x.concept.slug, label: x.concept.label,
      })),
    };
  });

  /* ================================ learners ============================= */

  app.post('/v1/learners', async (req, reply) => {
    const body = validate(z.object({
      name: z.string().min(1).max(80),
      grade: z.number().int().min(0).max(13).optional(),
      needs,
      locale: z.string().max(10).optional(),
      interests: z.array(z.string().max(40)).max(10).optional(),
      readingLevel: z.number().min(0).max(13).optional(),
    }), req.body);
    reply.status(201);
    const learner = ctx.twin.create(body);
    return { learner, spec: ctx.twin.spec(learner.id) };
  });

  app.get('/v1/learners', async (req) => {
    const q = req.query as { limit?: string; offset?: string };
    return { learners: ctx.repos.learners.list(Math.min(Number(q.limit ?? 50), 200), Number(q.offset ?? 0)) };
  });

  app.get('/v1/learners/:id', async (req) => {
    const { id } = req.params as { id: string };
    return { learner: ctx.repos.learners.require(id), spec: ctx.twin.spec(id) };
  });

  app.patch('/v1/learners/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = validate(z.object({
      name: z.string().min(1).max(80).optional(),
      grade: z.number().int().min(0).max(13).optional(),
      needs,
      readingLevel: z.number().min(0).max(13).optional(),
      profile: z.record(z.string(), z.unknown()).optional(),
    }), req.body);
    return ctx.repos.learners.update(id, body as never);
  });

  /** The whole digital twin: what is known, how firmly, in which form, under what load. */
  app.get('/v1/learners/:id/twin', async (req) => {
    const { id } = req.params as { id: string };
    return ctx.twin.snapshot(id);
  });

  app.get('/v1/learners/:id/mastery', async (req) => {
    const { id } = req.params as { id: string };
    return { mastery: ctx.twin.masteryViews(id) };
  });

  app.get('/v1/learners/:id/frontier', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { subject?: string; limit?: string };
    return {
      frontier: ctx.graph.frontier(id, {
        subject: q.subject as Subject | undefined,
        limit: Math.min(Number(q.limit ?? 10), 40),
      }).map((f) => ({
        conceptId: f.conceptId, slug: f.concept.slug, label: f.concept.label,
        readiness: f.readiness, gradeFit: f.gradeFit, unlocks: f.unlocks, score: f.score,
      })),
    };
  });

  /** The prerequisite trace: find the root cause, not the symptom. */
  app.get('/v1/learners/:id/gaps/:conceptId', async (req) => {
    const { id, conceptId } = req.params as { id: string; conceptId: string };
    const trace = ctx.graph.traceGaps(id, conceptId);
    return {
      target: trace.target,
      ready: trace.ready,
      explanation: trace.explanation,
      gaps: trace.gapConcepts.map((g) => ({
        conceptId: g.concept.id, slug: g.concept.slug, label: g.concept.label,
        mastery: g.mastery, depth: g.depth, blocking: g.blocking,
      })),
      repairRoute: trace.routeConcepts.map((c) => ({ id: c.id, slug: c.slug, label: c.label })),
    };
  });

  app.get('/v1/learners/:id/plan', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { goal?: string; maxItems?: string };
    if (!q.goal) throw badRequest('goal is required (a concept id or slug)');
    const plan = ctx.graph.plan(id, [q.goal], Math.min(Number(q.maxItems ?? 20), 60));
    return {
      route: plan.order.map((c) => ({ id: c.id, slug: c.slug, label: c.label, difficulty: c.difficulty })),
      alreadyKnown: plan.alreadyKnown.map((c) => ({ id: c.id, slug: c.slug, label: c.label })),
    };
  });

  app.get('/v1/learners/:id/review', async (req) => {
    const { id } = req.params as { id: string };
    return {
      due: ctx.twin.dueForReview(id, 20),
      decayed: ctx.twin.decayedConcepts(id, 20).map((d) => ({
        ...d, label: ctx.repos.concepts.get(d.conceptId)?.label,
      })),
    };
  });

  app.get('/v1/learners/:id/modality', async (req) => {
    const { id } = req.params as { id: string };
    return ctx.twin.chooseModality(id, { seed: `api:${Date.now()}` });
  });

  app.get('/v1/learners/:id/patterns', async (req) => {
    const { id } = req.params as { id: string };
    return ctx.twin.errorPatterns(id);
  });

  app.get('/v1/learners/:id/timeline', async (req) => {
    const { id } = req.params as { id: string };
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 60), 300);
    return { timeline: ctx.twin.timeline(id, limit) };
  });

  app.post('/v1/learners/:id/snapshots', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { label?: string };
    reply.status(201);
    return ctx.twin.saveSnapshot(id, body.label);
  });

  app.get('/v1/learners/:id/snapshots', async (req) => {
    const { id } = req.params as { id: string };
    return { snapshots: ctx.twin.snapshotHistory(id) };
  });

  /* ============================== sessions =============================== */

  app.post('/v1/sessions', async (req, reply) => {
    const body = validate(z.object({
      learnerId: z.string().min(1),
      goal: z.string().optional(),
      maxItems: z.number().int().min(1).max(60).optional(),
    }), req.body);
    reply.status(201);
    return ctx.sessions.start(body.learnerId, { goalSlug: body.goal, maxItems: body.maxItems });
  });

  /** The adaptation loop: decide, then deliver. */
  app.post('/v1/sessions/:id/next', async (req) => {
    const { id } = req.params as { id: string };
    return ctx.sessions.next(id);
  });

  /** The decision without the delivery - for inspecting the policy. */
  app.get('/v1/sessions/:id/decision', async (req) => {
    const { id } = req.params as { id: string };
    const d = ctx.sessions.decide(id);
    return {
      chosen: d.chosen,
      runnersUp: d.runnersUp,
      considered: d.considered,
      narrative: d.narrative,
    };
  });

  app.post('/v1/sessions/:id/answer', async (req) => {
    const { id } = req.params as { id: string };
    const body = validate(z.object({
      itemId: z.string().optional(),
      conceptId: z.string().optional(),
      raw: z.string().max(4000),
      correct: z.boolean().optional(),
      latencyMs: z.number().int().min(0).max(3_600_000).optional(),
      hintsUsed: z.number().int().min(0).max(20).optional(),
      attempts: z.number().int().min(1).max(50).optional(),
      modality,
      selfReportedClarity: z.number().min(0).max(1).optional(),
      abandoned: z.boolean().optional(),
    }), req.body);

    // The caller may report correctness, or let the grader decide.
    let correct = body.correct;
    let grading;
    if (correct === undefined && body.itemId) {
      grading = ctx.assessment.gradeAnswer(body.itemId, body.raw);
      correct = grading.correct;
    }
    if (correct === undefined) throw badRequest('either correct, or an itemId to grade against, is required');

    const result = await ctx.sessions.answer(id, { ...body, correct });
    return { ...result, grading: grading ? { ...grading, item: undefined } : undefined };
  });

  app.get('/v1/sessions/:id', async (req) => {
    const { id } = req.params as { id: string };
    return ctx.repos.sessions.require(id);
  });

  app.get('/v1/sessions/:id/summary', async (req) => {
    const { id } = req.params as { id: string };
    return ctx.sessions.summary(id);
  });

  /** Why the system did what it did, step by step. */
  app.get('/v1/sessions/:id/trace', async (req) => {
    const { id } = req.params as { id: string };
    return ctx.sessions.trace(id);
  });

  app.post('/v1/sessions/:id/end', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { reason?: string };
    return ctx.sessions.end(id, body.reason ?? 'completed');
  });

  app.get('/v1/learners/:id/sessions', async (req) => {
    const { id } = req.params as { id: string };
    return { sessions: ctx.repos.sessions.forLearner(id, 30) };
  });

  /* ============================ accessibility ============================ */

  /** THE UNIVERSAL ACCESSIBILITY TRANSFORMER, exposed directly. */
  app.post('/v1/accessibility/transform', async (req) => {
    const body = validate(z.object({
      text: z.string().min(1).max(60_000),
      title: z.string().max(200).optional(),
      grade: z.number().int().min(1).max(13).optional(),
      needs,
      keepTerms: z.array(z.string().max(60)).max(60).optional(),
      learnerId: z.string().optional(),
      /** Omit the heavy render plan when only the text variants are wanted. */
      compact: z.boolean().optional(),
    }), req.body);

    const learner = body.learnerId ? ctx.repos.learners.get(body.learnerId) : undefined;
    const result = transform({
      text: body.text,
      title: body.title,
      grade: body.grade ?? learner?.grade,
      needs: body.needs ?? learner?.needs,
      keepTerms: body.keepTerms,
    });

    if (!body.compact) return result;
    return {
      spec: result.spec,
      source: result.source,
      variants: result.variants,
      glossary: result.glossary,
      gains: result.gains,
      recommendedModalities: result.recommendedModalities,
      appliedTransforms: result.appliedTransforms,
      estimatedMinutes: result.estimatedMinutes,
      audio: { ssml: result.audio.script.ssml, totalMs: result.audio.script.totalMs },
    };
  });

  app.post('/v1/accessibility/analyze', async (req) => {
    const body = validate(z.object({
      text: z.string().min(1).max(60_000),
      grade: z.number().int().min(1).max(13).optional(),
    }), req.body);
    const grade = body.grade ?? 6;
    return {
      readability: analyzeReadability(body.text, grade),
      hardestSentences: rankSentences(body.text, grade)
        .sort((a, b) => b.difficulty - a.difficulty).slice(0, 10),
      decoding: decodingReport(body.text, 8),
    };
  });

  app.post('/v1/accessibility/simplify', async (req) => {
    const body = validate(z.object({
      text: z.string().min(1).max(60_000),
      targetGrade: z.number().int().min(1).max(13).optional(),
      keepTerms: z.array(z.string()).max(60).optional(),
    }), req.body);
    return simplify(body.text, { targetGrade: body.targetGrade, keepTerms: body.keepTerms });
  });

  app.post('/v1/accessibility/render-plan', async (req) => {
    const body = validate(z.object({
      text: z.string().min(1).max(40_000),
      grade: z.number().int().min(1).max(13).optional(),
      needs,
      colorProfile: z.string().optional(),
    }), req.body);
    const spec = resolveSpec(body.needs ?? [], body.grade ?? 6);
    return buildRenderPlan(body.text, {
      grade: spec.targetGrade,
      severity: spec.severity,
      colorProfile: body.colorProfile ?? spec.colorProfile,
      maxChunkWords: spec.maxChunkWords,
    });
  });

  app.post('/v1/accessibility/speech', async (req) => {
    const body = validate(z.object({
      text: z.string().min(1).max(40_000),
      grade: z.number().int().min(1).max(13).optional(),
      rate: z.number().min(0.4).max(1.6).optional(),
      emphasizeTerms: z.array(z.string()).max(40).optional(),
      spellOutHardWords: z.boolean().optional(),
    }), req.body);
    const script = buildAudioScript(body.text, {
      grade: body.grade, rate: body.rate,
      emphasizeTerms: body.emphasizeTerms,
      spellOutHardWords: body.spellOutHardWords,
    });
    return { ...script, vtt: toWebVtt(script) };
  });

  app.get('/v1/accessibility/palettes', async () => ({
    palettes: Object.entries(COLOR_PROFILES).map(([name, p]) => ({
      ...p,
      name,
      contrastRatio: contrastRatio(p.background, p.foreground),
      wcag: contrastRatio(p.background, p.foreground) >= 7 ? 'AAA'
        : contrastRatio(p.background, p.foreground) >= 4.5 ? 'AA' : 'fail',
    })),
  }));

  app.get('/v1/accessibility/decode/:word', async (req) => {
    const { word } = req.params as { word: string };
    return decodeSupport(word);
  });

  /* ================================ visuals ============================== */

  /** Build an animation for any concept or topic. */
  app.post('/v1/visuals', async (req) => {
    const body = validate(z.object({
      conceptId: z.string().optional(),
      conceptSlug: z.string().optional(),
      topic: z.string().max(200).optional(),
      description: z.string().max(8000).optional(),
      learnerId: z.string().optional(),
      grade: z.number().int().min(1).max(13).optional(),
      needs,
      misconception: z.string().max(400).optional(),
      mode: z.enum(['auto', 'model', 'curated']).optional(),
      /** Return only metadata and the still frame, not the full animation. */
      compact: z.boolean().optional(),
    }), req.body);

    if (!body.conceptId && !body.conceptSlug && !body.topic) {
      throw badRequest('one of conceptId, conceptSlug or topic is required');
    }
    const asset = await ctx.visual.build(body);
    if (!body.compact) return asset;
    const { svg, scene, ...rest } = asset;
    void svg; void scene;
    return rest;
  });

  /** The raw SVG, directly renderable in an <img> or <object>. */
  app.get('/v1/visuals/:conceptSlug.svg', async (req, reply) => {
    const { conceptSlug } = req.params as { conceptSlug: string };
    const q = req.query as { learnerId?: string; grade?: string; still?: string; captions?: string };
    const asset = await ctx.visual.build({
      conceptSlug,
      learnerId: q.learnerId,
      grade: q.grade ? Number(q.grade) : undefined,
    });
    reply.header('content-type', 'image/svg+xml; charset=utf-8');
    reply.header('cache-control', 'public, max-age=300');
    return q.still === 'true' ? asset.stillSvg : asset.svg;
  });

  /** Render a client-supplied scene. Lets a frontend tweak and re-render. */
  app.post('/v1/visuals/render', async (req, reply) => {
    const body = req.body as { scene?: unknown; showCaptions?: boolean; reduceMotion?: boolean; frozenAt?: number };
    if (!body?.scene) throw badRequest('scene is required');
    reply.header('content-type', 'image/svg+xml; charset=utf-8');
    return renderSvg(body.scene as never, {
      showCaptions: body.showCaptions,
      reduceMotion: body.reduceMotion,
      frozenAt: body.frozenAt,
    });
  });

  /* ================================= labs ================================ */

  app.get('/v1/labs', async (req) => {
    const q = req.query as { conceptSlug?: string };
    const labs = q.conceptSlug ? labsForConcept(q.conceptSlug) : null;
    return { labs: labs ? labs.map((l) => ({ id: l.id, label: l.label, question: l.question, controls: l.controls })) : describeLabs() };
  });

  app.get('/v1/labs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const lab = getLab(id);
    return {
      id: lab.id, label: lab.label, subject: lab.subject, question: lab.question,
      description: lab.description, learningGoal: lab.learningGoal,
      conceptSlugs: lab.conceptSlugs, controls: lab.controls,
      defaults: labDefaults(id),
    };
  });

  app.post('/v1/labs/:id/run', async (req) => {
    const { id } = req.params as { id: string };
    const params = (req.body ?? {}) as Record<string, unknown>;
    return runLab(id, { ...labDefaults(id), ...params });
  });

  /* =============================== assessment ============================= */

  app.get('/v1/concepts/:id/items', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { ensure?: string };
    const items = q.ensure === 'true'
      ? ctx.assessment.ensureItems(id, 3)
      : ctx.repos.items.forConcept(id, 50);
    return { items };
  });

  app.post('/v1/concepts/:id/items/generate', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { count?: number };
    const before = ctx.repos.items.forConcept(id, 100).length;
    const items = ctx.assessment.ensureItems(id, before + Math.min(Number(body.count ?? 3), 10));
    return { created: items.length - before, items: items.slice(before) };
  });

  app.post('/v1/items/:id/grade', async (req) => {
    const { id } = req.params as { id: string };
    const body = validate(z.object({ raw: z.string().max(4000) }), req.body);
    const r = ctx.assessment.gradeAnswer(id, body.raw);
    return { ...r, item: { id: r.item.id, stem: r.item.stem, kind: r.item.kind } };
  });

  app.post('/v1/concepts/:id/explain-back', async (req) => {
    const { id } = req.params as { id: string };
    const body = validate(z.object({ response: z.string().max(8000) }), req.body);
    return ctx.assessment.gradeExplanation(id, body.response);
  });

  app.get('/v1/assessment/bank', async (req) => {
    const q = req.query as { subject?: string };
    return ctx.assessment.bankReport(q.subject);
  });

  app.post('/v1/assessment/recalibrate', async (req) => {
    const body = (req.body ?? {}) as { minResponses?: number };
    return ctx.assessment.recalibrate({ minResponses: body.minResponses ?? 12 });
  });

  /* ============================= misconceptions ========================== */

  app.get('/v1/misconceptions', async (req) => {
    const q = req.query as { subject?: string; conceptId?: string };
    return { misconceptions: ctx.misconceptions.catalogue(q) };
  });

  app.post('/v1/misconceptions/diagnose', async (req) => {
    const body = validate(z.object({
      learnerAnswer: z.string().max(4000),
      stem: z.string().max(4000).optional(),
      correctAnswer: z.string().max(1000).optional(),
      itemId: z.string().optional(),
      conceptId: z.string().optional(),
      learnerId: z.string().optional(),
      choiceKey: z.string().max(20).optional(),
      allowModel: z.boolean().optional(),
    }), req.body);
    return ctx.misconceptions.diagnose(body);
  });

  app.get('/v1/misconceptions/:code/remediation', async (req) => {
    const { code } = req.params as { code: string };
    const q = req.query as { grade?: string; modality?: string };
    return ctx.misconceptions.buildRemediation(code, {
      grade: q.grade ? Number(q.grade) : undefined,
      modality: q.modality as Modality | undefined,
    });
  });

  app.get('/v1/learners/:id/misconceptions', async (req) => {
    const { id } = req.params as { id: string };
    return { misconceptions: ctx.twin.activeMisconceptions(id) };
  });

  /* =============================== ingestion ============================= */

  app.post('/v1/ingest', async (req) => {
    const body = validate(z.object({
      content: z.string().min(1).max(2_000_000),
      kind: z.enum(['auto', 'text', 'markdown', 'html', 'pdf', 'csv', 'image', 'audio', 'video', 'url']).optional(),
      title: z.string().max(200).optional(),
      subject: z.string().optional(),
      grade: z.number().int().min(1).max(13).optional(),
      linkToGraph: z.boolean().optional(),
      generateItems: z.boolean().optional(),
      previewNeeds: needs,
      useModel: z.boolean().optional(),
      /** Run in the background and return a job id. */
      async: z.boolean().optional(),
    }), req.body);

    const payload = { ...body, subject: body.subject as Subject | undefined };
    if (body.async) {
      const job = jobs.enqueue('ingest', payload, { priority: 3 });
      return { jobId: job.id, status: job.status, poll: `/v1/jobs/${job.id}` };
    }
    return ctx.ingestion.ingest(payload);
  });

  app.get('/v1/documents', async (req) => {
    const q = req.query as { limit?: string };
    return {
      documents: ctx.db.all(
        'SELECT id, title, source_kind, subject, grade, word_count, readability, created_at FROM documents ORDER BY created_at DESC LIMIT ?',
        [Math.min(Number(q.limit ?? 50), 200)],
      ),
    };
  });

  app.get('/v1/documents/:id', async (req) => {
    const { id } = req.params as { id: string };
    const doc = ctx.db.one('SELECT * FROM documents WHERE id=?', [id]);
    if (!doc) throw notFound('document', id);
    return {
      document: doc,
      chunks: ctx.db.all('SELECT id, idx, kind, heading, text, word_count, readability, difficulty FROM doc_chunks WHERE document_id=? ORDER BY idx', [id]),
    };
  });
}
