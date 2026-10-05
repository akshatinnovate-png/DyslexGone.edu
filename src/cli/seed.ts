import { buildContext, shutdown } from '../api/context.js';
import { seedCurriculum } from '../graph/service.js';
import { logger } from '../core/logger.js';

/** Seeds the curriculum and fills every item bank. Idempotent. */
async function main(): Promise<void> {
  const ctx = buildContext({ seed: false, startJobs: false });
  const report = seedCurriculum(ctx.repos, ctx.graph);
  const backfilled = ctx.assessment.backfill(3);
  const health = ctx.graph.health();

  process.stdout.write([
    '',
    `  concepts        ${report.concepts} new, ${report.skipped.length} already present`,
    `  links           ${report.edges}`,
    `  misconceptions  ${report.misconceptions}`,
    `  seed items      ${report.items}`,
    `  generated items ${backfilled.reduce((a, b) => a + b.created, 0)} across ${backfilled.length} concepts`,
    `  grade fixes     ${report.gradeAdjustments.length}`,
    `  graph           ${health.nodes} nodes, ${health.edges} edges, ${health.cycles.length} cycles, ${health.components} component(s)`,
    '',
  ].join('\n'));

  if (report.warnings.length) logger.warn('seed warnings', { warnings: report.warnings.slice(0, 5) });
  shutdown();
  process.exit(health.cycles.length ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`seed failed: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
