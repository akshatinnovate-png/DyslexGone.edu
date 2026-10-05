import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError, isAppError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { metrics } from '../../core/metrics.js';

/** One error shape for the whole API, and never a stack trace to a client. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    reply.status(404).send({
      error: {
        code: 'not_found',
        message: `No route for ${req.method} ${req.url}`,
        hint: 'GET /v1/openapi.json lists every available route.',
      },
      requestId: req.id,
    });
  });

  app.setErrorHandler((rawErr, req, reply) => {
    const requestId = req.id;
    const err = rawErr as Error & { statusCode?: number; validation?: unknown };

    if (isAppError(err)) {
      if (err.status >= 500) {
        logger.error('request failed', { requestId, code: err.code, msg: err.message, url: req.url });
      }
      metrics.counter('lumen_api_errors_total').inc({ code: err.code });
      reply.status(err.status).send({ ...err.toJSON(), requestId });
      return;
    }

    // Fastify's own validation errors carry a statusCode.
    const status = err.statusCode ?? 500;
    if (status === 400 && err.validation) {
      metrics.counter('lumen_api_errors_total').inc({ code: 'validation' });
      reply.status(400).send({
        error: { code: 'bad_request', message: err.message, details: err.validation },
        requestId,
      });
      return;
    }

    logger.error('unhandled error', { requestId, url: req.url, msg: err.message, stack: err.stack?.slice(0, 900) });
    metrics.counter('lumen_api_errors_total').inc({ code: 'internal' });
    reply.status(status >= 400 && status < 600 ? status : 500).send({
      error: {
        code: 'internal',
        message: status >= 500 ? 'Something failed on our side. The request id below identifies it in the logs.' : err.message,
      },
      requestId,
    });
  });
}

export { AppError };
