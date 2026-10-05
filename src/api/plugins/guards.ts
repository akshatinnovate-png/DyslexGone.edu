import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../../core/config.js';
import { AppError } from '../../core/errors.js';
import { TokenBucket } from '../../core/ratelimit.js';
import { metrics } from '../../core/metrics.js';
import { id as newId, canonicalJson } from '../../core/ids.js';
import type { Db } from '../../db/sqlite.js';
import { logger } from '../../core/logger.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor: { id: string; name: string; scopes: string[] };
  }
}

const limiter = TokenBucket.perWindow(config.rateLimit.max, config.rateLimit.windowMs, config.rateLimit.burst);

export const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex');

export function mintApiKey(db: Db, name: string, scopes: string[] = ['*']): { id: string; key: string; prefix: string } {
  const secret = randomBytes(24).toString('base64url');
  const key = `lumen_${secret}`;
  const id = newId('key');
  db.insert('api_keys', {
    id, name, hash: hashKey(key), prefix: key.slice(0, 12), scopes,
    rate_limit: null, created_at: new Date().toISOString(), last_used_at: null, revoked: 0,
  });
  return { id, key, prefix: key.slice(0, 12) };
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function registerGuards(app: FastifyInstance, db: Db): void {
  /* ------------------------------ identity ------------------------------ */
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    req.actor = { id: 'anonymous', name: 'anonymous', scopes: ['*'] };

    const open = req.url.startsWith('/health') || req.url.startsWith('/v1/openapi')
      || req.url === '/' || req.url.startsWith('/metrics');
    if (!config.auth.enabled || open) return;

    const raw = (req.headers['x-api-key'] as string)
      ?? (req.headers.authorization as string)?.replace(/^Bearer\s+/i, '');
    if (!raw) {
      throw new AppError('unauthorized', 'An API key is required. Send it as X-API-Key or Authorization: Bearer.');
    }

    if (config.auth.rootKey && constantTimeEqual(raw, config.auth.rootKey)) {
      req.actor = { id: 'root', name: 'root', scopes: ['*'] };
      return;
    }

    const row = db.one<{ id: string; name: string; scopes: string; revoked: number }>(
      'SELECT id, name, scopes, revoked FROM api_keys WHERE hash=?', [hashKey(raw)],
    );
    if (!row || row.revoked) throw new AppError('unauthorized', 'That API key is not valid.');

    db.run('UPDATE api_keys SET last_used_at=? WHERE id=?', [new Date().toISOString(), row.id]);
    req.actor = {
      id: row.id,
      name: row.name,
      scopes: JSON.parse(row.scopes || '["*"]') as string[],
    };
    void reply;
  });

  /* ----------------------------- rate limit ----------------------------- */
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!config.rateLimit.enabled) return;
    if (req.url.startsWith('/health') || req.url.startsWith('/metrics')) return;

    const key = req.actor.id !== 'anonymous'
      ? `k:${req.actor.id}`
      : `ip:${req.ip}`;
    // Generation is expensive; charge it more than a read.
    const cost = /\/(lesson|visual|ingest|session\/[^/]+\/next|forge)/.test(req.url) ? 5 : 1;
    const decision = limiter.take(key, cost);

    reply.header('x-ratelimit-limit', String(decision.limit));
    reply.header('x-ratelimit-remaining', String(decision.remaining));
    if (!decision.allowed) {
      reply.header('retry-after', String(Math.ceil(decision.retryAfterMs / 1000)));
      metrics.counter('lumen_rate_limited_total').inc({ actor: req.actor.id });
      throw new AppError('rate_limited', 'Too many requests. Slow down and try again shortly.', {
        details: { retryAfterMs: decision.retryAfterMs },
      });
    }
  });

  /* ---------------------------- idempotency ----------------------------- */
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const key = req.headers['idempotency-key'] as string | undefined;
    if (!key || req.method !== 'POST') return;

    const stored = db.one<{ status: number; response: string; route: string }>(
      'SELECT status, response, route FROM idempotency WHERE key=?', [key],
    );
    if (stored) {
      if (stored.route !== req.url) {
        throw new AppError('conflict', 'This idempotency key was already used on a different route.');
      }
      reply.header('idempotent-replay', 'true');
      reply.header('content-type', 'application/json; charset=utf-8');
      // Returning the sent reply stops the lifecycle: the handler never runs,
      // so a retried create cannot create a second record.
      await reply.status(stored.status).send(stored.response);
      return reply;
    }
    (req as FastifyRequest & { idempotencyKey?: string }).idempotencyKey = key;
  });

  /* -------------------------- audit + persistence ------------------------ */
  app.addHook('onSend', async (req, reply, payload) => {
    const key = (req as FastifyRequest & { idempotencyKey?: string }).idempotencyKey;
    if (key && reply.statusCode < 400 && typeof payload === 'string') {
      try {
        db.run(
          'INSERT OR IGNORE INTO idempotency (key, route, status, response, at) VALUES (?,?,?,?,?)',
          [key, req.url, reply.statusCode, payload, new Date().toISOString()],
        );
      } catch (e) {
        logger.debug('failed to store idempotent response', { err: String(e) });
      }
    }
    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    const ms = Math.round(reply.elapsedTime);
    metrics.histogram('lumen_http_duration_ms').observe(ms, {
      method: req.method,
      route: (req.routeOptions?.url ?? req.url).split('?')[0],
      status: String(reply.statusCode),
    });
    metrics.counter('lumen_http_requests_total').inc({
      method: req.method, status: String(reply.statusCode),
    });

    // Writes are audited; reads are not, to keep the log readable.
    if (req.method === 'GET' || req.url.startsWith('/health') || req.url.startsWith('/metrics')) return;
    try {
      db.insert('audit_log', {
        id: newId('aud'),
        at: new Date().toISOString(),
        actor: req.actor?.name ?? 'anonymous',
        action: `${req.method} ${(req.routeOptions?.url ?? req.url).split('?')[0]}`,
        target: (req.params as Record<string, string> | undefined)?.id ?? null,
        status: reply.statusCode,
        ms,
        ip: req.ip,
        meta: { requestId: req.id, query: req.query ?? {} },
      });
    } catch (e) {
      logger.debug('audit write failed', { err: String(e) });
    }
  });
}

export { canonicalJson };
