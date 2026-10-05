import Fastify, { type FastifyInstance } from 'fastify';
import { buildContext, shutdown, type AppContext, type BuildOptions } from './context.js';
import { registerErrorHandling } from './plugins/errors.js';
import { registerGuards } from './plugins/guards.js';
import { coreRoutes } from './routes/core.routes.js';
import { learningRoutes } from './routes/learning.routes.js';
import { teachingRoutes } from './routes/teaching.routes.js';
import { platformRoutes } from './routes/platform.routes.js';
import { buildOpenApi } from './openapi.js';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

export interface Server {
  app: FastifyInstance;
  ctx: AppContext;
  listen(): Promise<string>;
  close(): Promise<void>;
}

export async function createServer(opts: BuildOptions = {}): Promise<Server> {
  const ctx = buildContext(opts);

  const app = Fastify({
    logger: false,                      // we have our own structured logger
    bodyLimit: config.server.bodyLimitBytes,
    trustProxy: config.server.trustProxy,
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
    disableRequestLogging: true,
    ajv: { customOptions: { removeAdditional: 'all', coerceTypes: 'array' } },
  });

  registerErrorHandling(app);
  registerGuards(app, ctx.db);

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
    // Local-first by default: a teacher running this on a laptop should not
    // have to fight CORS to point a frontend at it.
    reply.header('access-control-allow-origin', '*');
    reply.header('access-control-allow-headers', 'content-type,x-api-key,authorization,idempotency-key');
    reply.header('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') {
      reply.status(204).send();
    }
  });

  await app.register(async (instance) => coreRoutes(instance, ctx));
  await app.register(async (instance) => learningRoutes(instance, ctx));
  await app.register(async (instance) => teachingRoutes(instance, ctx));
  await app.register(async (instance) => platformRoutes(instance, ctx));

  if (config.features.openapi) {
    const spec = buildOpenApi(app);
    app.get('/v1/openapi.json', async () => spec());
  }

  return {
    app,
    ctx,
    async listen() {
      const address = await app.listen({ host: config.server.host, port: config.server.port });
      logger.info('LUMEN OS listening', {
        address,
        concepts: ctx.repos.concepts.count(),
        models: ctx.router.hasHostedModel() ? 'hosted + offline' : 'offline engine only',
        auth: config.auth.enabled ? 'enabled' : 'open (development)',
      });
      return address;
    },
    async close() {
      shutdown();
      await app.close();
    },
  };
}
