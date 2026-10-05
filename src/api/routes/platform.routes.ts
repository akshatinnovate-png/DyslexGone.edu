import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { validate } from './core.routes.js';
import { AgentRuntime } from '../../agents/runtime.js';
import { buildForgeAgents, forgeLesson } from '../../agents/pipeline.js';
import { ExperimentService } from '../../experiments/service.js';
import { verify, redactPii, checkInjection } from '../../safety/verifier.js';
import { ALL_NEEDS, ALL_MODALITIES, type AccessNeed, type Modality } from '../../domain/types.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { id as newId } from '../../core/ids.js';
import { bus } from '../../core/events.js';
import { logger } from '../../core/logger.js';
import { config } from '../../core/config.js';
import { notFound } from '../../core/errors.js';

export async function platformRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const runtime = new AgentRuntime(ctx);
  const experiments = new ExperimentService(ctx.repos);

  /* ================================ agents =============================== */

  /** The lesson forge: seven agents, one blackboard, QA with veto. */
  app.post('/v1/agents/forge', async (req) => {
    const body = validate(z.object({
      conceptId: z.string().optional(),
      conceptSlug: z.string().optional(),
      learnerId: z.string().optional(),
      grade: z.number().int().min(1).max(13).optional(),
      needs: z.array(z.enum(ALL_NEEDS as [AccessNeed, ...AccessNeed[]])).optional(),
      modality: z.enum(ALL_MODALITIES as [Modality, ...Modality[]]).optional(),
      includeVisual: z.boolean().optional(),
      /** Omit the SVG, which dominates the payload. */
      compact: z.boolean().optional(),
    }), req.body);

    const result = await forgeLesson(ctx, body);
    if (!body.compact) return result;
    return {
      ...result,
      output: { ...result.output, visual: result.output.visual ? { ...result.output.visual, svg: undefined } : undefined },
    };
  });

  app.get('/v1/agents', async () => ({
    pipelines: [{
      kind: 'lesson_forge',
      agents: buildForgeAgents().map((a) => ({
        name: a.name, question: a.question, requires: a.requires, provides: a.provides,
      })),
    }],
  }));

  app.get('/v1/agents/runs', async (req) => {
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 30), 100);
    return { runs: runtime.history(limit) };
  });

  app.get('/v1/agents/runs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const run = runtime.get(id);
    if (!run) throw notFound('agent run', id);
    return run;
  });

  /* ================================ safety =============================== */

  /** Would this content be allowed in front of a child, and why? */
  app.post('/v1/safety/verify', async (req) => {
    const body = validate(z.object({
      text: z.string().min(1).max(40_000),
      grade: z.number().int().min(1).max(13).optional(),
      conceptId: z.string().optional(),
      keyTerms: z.array(z.string()).max(40).optional(),
      misconception: z.string().max(400).optional(),
      kind: z.enum(['lesson', 'remediation', 'item', 'narration', 'feedback']).optional(),
    }), req.body);
    return verify({
      text: body.text,
      grade: body.grade ?? 6,
      concept: body.conceptId ? ctx.repos.concepts.get(body.conceptId) : undefined,
      keyTerms: body.keyTerms,
      misconception: body.misconception,
      kind: body.kind,
    });
  });

  app.post('/v1/safety/redact', async (req) => {
    const body = validate(z.object({ text: z.string().max(60_000) }), req.body);
    const pii = redactPii(body.text);
    const injection = checkInjection(pii.text);
    return {
      text: injection.sanitized,
      pii: { redacted: pii.redacted, found: pii.found },
      injection: { suspicious: injection.suspicious, patterns: injection.patterns },
    };
  });

  /* ============================= experiments ============================= */

  app.post('/v1/experiments', async (req, reply) => {
    const body = validate(z.object({
      name: z.string().min(1).max(120),
      hypothesis: z.string().max(500).optional(),
      arms: z.array(z.object({
        key: z.string().min(1).max(40),
        label: z.string().min(1).max(120),
        config: z.record(z.string(), z.unknown()).optional(),
      })).min(2).max(8),
      unit: z.enum(['learner', 'session', 'delivery']).optional(),
      scope: z.enum(['global', 'concept', 'classroom']).optional(),
      scopeRef: z.string().optional(),
      allocation: z.enum(['thompson', 'uniform']).optional(),
    }), req.body);
    reply.status(201);
    return experiments.create({
      ...body,
      arms: body.arms.map((a) => ({ ...a, config: a.config ?? {} })),
    });
  });

  /** Shortcut: compare two ways of explaining the same concept. */
  app.post('/v1/experiments/compare-modalities', async (req, reply) => {
    const body = validate(z.object({
      conceptId: z.string().min(1),
      modalities: z.array(z.enum(ALL_MODALITIES as [Modality, ...Modality[]])).min(2).max(6),
      name: z.string().max(120).optional(),
    }), req.body);
    const concept = ctx.graph.resolve(body.conceptId);
    reply.status(201);
    return experiments.compareModalities(concept.id, body.modalities, body.name ?? `Which explanation works for ${concept.label}?`);
  });

  app.get('/v1/experiments', async (req) => {
    const q = req.query as { status?: 'running' | 'concluded' | 'stopped' };
    return { experiments: experiments.list(q.status) };
  });

  app.get('/v1/experiments/:id', async (req) => {
    const { id } = req.params as { id: string };
    return experiments.report(id);
  });

  app.post('/v1/experiments/:id/assign', async (req) => {
    const { id } = req.params as { id: string };
    const body = validate(z.object({ subjectId: z.string().min(1) }), req.body);
    return experiments.assign(id, body.subjectId);
  });

  app.post('/v1/experiments/:id/observe', async (req) => {
    const { id } = req.params as { id: string };
    const body = validate(z.object({
      subjectId: z.string().min(1),
      reward: z.number().min(0).max(1),
      meta: z.record(z.string(), z.unknown()).optional(),
    }), req.body);
    experiments.observe(id, body.subjectId, body.reward, body.meta ?? {});
    return { recorded: true, report: experiments.report(id) };
  });

  app.post('/v1/experiments/:id/conclude', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { force?: boolean };
    return experiments.conclude(id, body.force === true);
  });

  app.post('/v1/experiments/:id/stop', async (req) => {
    const { id } = req.params as { id: string };
    return experiments.stop(id);
  });

  app.get('/v1/experiments/:id/head-to-head', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { a?: string; b?: string };
    const exp = experiments.get(id);
    return experiments.headToHead(id, q.a ?? exp.arms[0].key, q.b ?? exp.arms[1].key);
  });

  /* =============================== webhooks ============================== */

  /** The Education API: let another platform subscribe to what happens here. */
  app.post('/v1/webhooks', async (req, reply) => {
    const body = validate(z.object({
      url: z.string().url().max(500),
      events: z.array(z.string().max(60)).min(1).max(40),
    }), req.body);

    const secret = `whsec_${newId('s').slice(-24)}`;
    const idv = newId('wh');
    ctx.db.insert('webhooks', {
      id: idv, url: body.url, secret, events: body.events, active: 1,
      failures: 0, last_status: null, last_at: null, created_at: new Date().toISOString(),
    });
    reply.status(201);
    return {
      id: idv, url: body.url, events: body.events, secret,
      signatureHeader: 'x-lumen-signature',
      note: 'Each delivery is signed as HMAC-SHA256 over the raw body using this secret. '
        + 'It is shown once.',
    };
  });

  app.get('/v1/webhooks', async () => ({
    webhooks: ctx.db.all('SELECT id, url, events, active, failures, last_status, last_at, created_at FROM webhooks ORDER BY created_at DESC'),
  }));

  app.delete('/v1/webhooks/:id', async (req) => {
    const { id } = req.params as { id: string };
    return { deleted: ctx.db.run('DELETE FROM webhooks WHERE id=?', [id]).changes > 0 };
  });

  /** Verify a signature we produced - useful when integrating. */
  app.post('/v1/webhooks/verify', async (req) => {
    const body = validate(z.object({
      secret: z.string().min(1),
      payload: z.string().max(200_000),
      signature: z.string().min(1),
    }), req.body);
    const expected = createHmac('sha256', body.secret).update(body.payload).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(body.signature);
    return { valid: a.length === b.length && timingSafeEqual(a, b), expected };
  });

  if (config.features.webhooks) startWebhookDelivery(ctx);
}

/** Fire-and-forget delivery with HMAC signing and failure backoff. */
function startWebhookDelivery(ctx: AppContext): void {
  bus.onAny(async (evt) => {
    const hooks = ctx.db.all<{ id: string; url: string; secret: string; events: string; failures: number }>(
      'SELECT id, url, secret, events, failures FROM webhooks WHERE active=1',
    );
    for (const h of hooks) {
      let subscribed: string[] = [];
      try { subscribed = JSON.parse(h.events) as string[]; } catch { continue; }
      if (!subscribed.includes(evt.name) && !subscribed.includes('*')) continue;
      if (h.failures > 10) continue;    // stop hammering a dead endpoint

      const payload = JSON.stringify(evt);
      const signature = createHmac('sha256', h.secret).update(payload).digest('hex');
      try {
        const res = await fetch(h.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-lumen-signature': signature,
            'x-lumen-event': evt.name,
            'x-lumen-delivery': evt.id,
          },
          body: payload,
          signal: AbortSignal.timeout(5000),
        });
        ctx.db.run(
          'UPDATE webhooks SET last_status=?, last_at=?, failures=? WHERE id=?',
          [res.status, new Date().toISOString(), res.ok ? 0 : h.failures + 1, h.id],
        );
      } catch (e) {
        ctx.db.run('UPDATE webhooks SET failures=?, last_at=? WHERE id=?',
          [h.failures + 1, new Date().toISOString(), h.id]);
        logger.debug('webhook delivery failed', { url: h.url, err: String(e) });
      }
    }
  });
}
