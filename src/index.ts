import { createServer } from './api/server.js';
import { logger } from './core/logger.js';
import { config } from './core/config.js';

/** Entry point. Boots the whole OS and keeps it alive. */
async function main(): Promise<void> {
  const banner = [
    '',
    '  LUMEN OS — an adaptive accessibility operating system for education',
    '  Every student receives the same knowledge, in the form their brain can reach.',
    '',
  ].join('\n');
  process.stdout.write(banner);

  const server = await createServer({ backfillItems: true });
  await server.listen();

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal });
    try {
      await server.close();
      process.exit(0);
    } catch (e) {
      logger.error('shutdown failed', { err: String(e) });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { reason: String(reason) });
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception', { err: err.message, stack: err.stack?.slice(0, 500) });
    // An uncaught exception leaves the process in an unknown state; exiting is
    // the only honest response. A supervisor restarts it.
    void shutdown('uncaughtException');
  });

  void config;
}

main().catch((e) => {
  logger.error('failed to start', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
  process.exit(1);
});
