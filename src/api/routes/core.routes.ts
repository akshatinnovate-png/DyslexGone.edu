import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { config } from '../../core/config.js';
import { metrics } from '../../core/metrics.js';
import { bus } from '../../core/events.js';
import { jobs, scheduler } from '../../core/jobs.js';
import { deterministic } from '../../llm/providers/deterministic.js';
import { listAnimations } from '../../engines/animation/library.js';
import { authorCapabilities } from '../../engines/animation/author.js';
import { describeLabs } from '../../engines/sim/lab.js';
import { ALL_MODALITIES, ALL_NEEDS } from '../../domain/types.js';
import { NEED_POLICIES } from '../../accessibility/profiles.js';
import { mintApiKey } from '../plugins/guards.js';
import { badRequest } from '../../core/errors.js';

const parse = <T>(schema: z.ZodType<T>, data: unknown): T => {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest('Request body failed validation', r.error.issues.map((i) => ({
      path: i.path.join('.') || '(root)', message: i.message,
    })));
  }
  return r.data;
};

export const validate = parse;

export async function coreRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/', async () => ({
    name: 'LUMEN OS',
    tagline: 'An adaptive accessibility operating system for education.',
    version: '0.1.0',
    docs: '/v1/openapi.json',
    health: '/health',
    startedAt: ctx.startedAt,
  }));

  /* -------------------------------- health ------------------------------- */

  app.get('/health', async () => {
    const dbOk = (() => {
      try { ctx.repos.concepts.count(); return true; } catch { return false; }
    })();
    return {
      status: dbOk ? 'ok' : 'degraded',
      uptimeSec: Math.round(process.uptime()),
      startedAt: ctx.startedAt,
      checks: {
        database: dbOk ? 'ok' : 'failing',
        curriculum: ctx.repos.concepts.count() > 0 ? 'seeded' : 'empty',
        models: ctx.router.hasHostedModel() ? 'hosted model available' : 'offline engine only',
      },
    };
  });

  app.get('/health/deep', async () => {
    const health = ctx.graph.health();
    return {
      status: health.warnings.length ? 'warning' : 'ok',
      database: { tables: ctx.db.tables().length, counts: ctx.db.stats() },
      graph: {
        nodes: health.nodes, edges: health.edges, cycles: health.cycles.length,
        orphans: health.orphans.length, components: health.components, warnings: health.warnings,
      },
      models: ctx.router.stats(),
      jobs: jobs.stats(),
      scheduledTasks: scheduler.list(),
      events: bus.stats(),
      memoryMb: Math.round(process.memoryUsage().heapUsed / 1048576),
    };
  });

  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', 'text/plain; version=0.0.4');
    return metrics.renderProm();
  });

  app.get('/v1/metrics.json', async () => metrics.snapshot());

  /* ----------------------------- capabilities ---------------------------- */

  app.get('/v1/capabilities', async () => ({
    modalities: ALL_MODALITIES,
    accessNeeds: ALL_NEEDS.map((n) => ({
      need: n,
      label: NEED_POLICIES[n].label,
      gradeOffset: NEED_POLICIES[n].gradeOffset,
      guidance: NEED_POLICIES[n].notes,
      blocks: NEED_POLICIES[n].modalityBlock,
    })),
    animation: { ...authorCapabilities(), curated: listAnimations() },
    labs: describeLabs().map((l) => ({ id: l.id, label: l.label, subject: l.subject, question: l.question })),
    models: {
      mode: config.llm.mode,
      hostedAvailable: ctx.router.hasHostedModel(),
      providers: ctx.router.stats().providers,
      offlinePurposes: deterministic.registered(),
    },
    pedagogy: {
      masteryThreshold: config.pedagogy.masteryThreshold,
      strugglingThreshold: config.pedagogy.strugglingThreshold,
      cognitiveLoadCeiling: config.pedagogy.cognitiveLoadCeiling,
    },
  }));

  /* -------------------------------- events ------------------------------- */

  app.get('/v1/events/recent', async (req) => {
    const q = req.query as { limit?: string; name?: string };
    return {
      events: bus.recent(Math.min(Number(q.limit ?? 50), 200), q.name as never),
      counts: bus.stats(),
    };
  });

  /** Live event stream. Everything the OS does, as it happens. */
  app.get('/v1/events/stream', async (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write(`: connected to LUMEN OS event stream\n\n`);

    const controller = new AbortController();
    const keepAlive = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => { controller.abort(); clearInterval(keepAlive); });

    const filter = (req.query as { name?: string }).name;
    try {
      for await (const evt of bus.stream(controller.signal)) {
        if (filter && evt.name !== filter) continue;
        reply.raw.write(`event: ${evt.name}\nid: ${evt.id}\ndata: ${JSON.stringify(evt)}\n\n`);
      }
    } catch { /* client disconnected */ } finally {
      clearInterval(keepAlive);
      reply.raw.end();
    }
    return reply;
  });

  /* --------------------------------- jobs -------------------------------- */

  app.get('/v1/jobs', async (req) => {
    const q = req.query as { kind?: string; status?: string; limit?: string };
    return {
      jobs: jobs.list({
        kind: q.kind,
        status: q.status as never,
        limit: Math.min(Number(q.limit ?? 50), 200),
      }).map((j) => ({
        id: j.id, kind: j.kind, status: j.status, attempts: j.attempts,
        progress: j.progress, note: j.progressNote, error: j.error,
        createdAt: new Date(j.createdAt).toISOString(),
        ms: j.finishedAt && j.startedAt ? j.finishedAt - j.startedAt : undefined,
      })),
      stats: jobs.stats(),
    };
  });

  app.get('/v1/jobs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const job = jobs.get(id);
    if (!job) throw badRequest(`No job with id ${id}`);
    return job;
  });

  /* ------------------------------- api keys ------------------------------ */

  app.post('/v1/admin/keys', async (req, reply) => {
    const body = parse(z.object({
      name: z.string().min(1).max(80),
      scopes: z.array(z.string()).optional(),
    }), req.body);
    const key = mintApiKey(ctx.db, body.name, body.scopes ?? ['*']);
    reply.status(201);
    return {
      ...key,
      warning: 'This is the only time the key is shown. Store it now.',
    };
  });

  app.get('/v1/admin/keys', async () => ({
    keys: ctx.db.all('SELECT id, name, prefix, scopes, created_at, last_used_at, revoked FROM api_keys ORDER BY created_at DESC'),
  }));

  app.delete('/v1/admin/keys/:id', async (req) => {
    const { id } = req.params as { id: string };
    const changes = ctx.db.run('UPDATE api_keys SET revoked=1 WHERE id=?', [id]).changes;
    return { revoked: changes > 0 };
  });

  app.get('/v1/admin/audit', async (req) => {
    const q = req.query as { limit?: string };
    return {
      entries: ctx.db.all(
        'SELECT * FROM audit_log ORDER BY at DESC LIMIT ?',
        [Math.min(Number(q.limit ?? 100), 500)],
      ),
    };
  });

  app.get('/v1/admin/llm-calls', async (req) => {
    const q = req.query as { limit?: string };
    const rows = ctx.db.all<{ cost_usd: number; tokens_in: number; tokens_out: number }>(
      'SELECT * FROM llm_calls ORDER BY at DESC LIMIT ?',
      [Math.min(Number(q.limit ?? 100), 500)],
    );
    return {
      calls: rows,
      totals: {
        calls: rows.length,
        costUsd: Math.round(rows.reduce((a, r) => a + Number(r.cost_usd), 0) * 1e6) / 1e6,
        tokensIn: rows.reduce((a, r) => a + Number(r.tokens_in), 0),
        tokensOut: rows.reduce((a, r) => a + Number(r.tokens_out), 0),
      },
      router: ctx.router.stats(),
    };
  });
}
