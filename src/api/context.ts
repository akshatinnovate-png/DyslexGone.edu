import { getDb, type Db } from '../db/sqlite.js';
import { makeRepos, type Repos } from '../db/repos.js';
import { GraphService, seedCurriculum } from '../graph/service.js';
import { TwinService } from '../twin/service.js';
import { MisconceptionEngine } from '../misconception/engine.js';
import { VisualEngine } from '../engines/visual.engine.js';
import { AssessmentService } from '../assessment/service.js';
import { SessionEngine } from '../orchestrator/session.js';
import { IngestionPipeline } from '../ingestion/pipeline.js';
import { router, type ModelRouter } from '../llm/router.js';
import { bus } from '../core/events.js';
import { jobs, scheduler } from '../core/jobs.js';
import { metrics } from '../core/metrics.js';
import { logger } from '../core/logger.js';
import { config } from '../core/config.js';

/** One assembled system. Everything is constructed once and shared, so the
 *  twin, the graph and the session engine all see the same state. */
export interface AppContext {
  db: Db;
  repos: Repos;
  graph: GraphService;
  twin: TwinService;
  misconceptions: MisconceptionEngine;
  visual: VisualEngine;
  assessment: AssessmentService;
  sessions: SessionEngine;
  ingestion: IngestionPipeline;
  router: ModelRouter;
  startedAt: string;
}

export interface BuildOptions {
  db?: Db;
  seed?: boolean;
  backfillItems?: boolean;
  startJobs?: boolean;
}

export function buildContext(opts: BuildOptions = {}): AppContext {
  const db = opts.db ?? getDb();
  const repos = makeRepos(db);
  router.attachDb(db);

  const graph = new GraphService(repos);
  const twin = new TwinService(repos, graph);
  const misconceptions = new MisconceptionEngine(repos, router);
  const visual = new VisualEngine(repos, router);
  const assessment = new AssessmentService(repos);
  const sessions = new SessionEngine(repos, graph, twin, misconceptions, visual, assessment);
  const ingestion = new IngestionPipeline(repos, graph, assessment, router);

  if (opts.seed !== false && repos.concepts.count() === 0) {
    seedCurriculum(repos, graph);
  }
  if (opts.backfillItems) {
    const filled = assessment.backfill(2);
    if (filled.length) logger.info('item bank backfilled', { concepts: filled.length });
  }

  const ctx: AppContext = {
    db, repos, graph, twin, misconceptions, visual, assessment, sessions, ingestion,
    router, startedAt: new Date().toISOString(),
  };

  wireEventMetrics();
  if (opts.startJobs !== false && config.features.jobs) startBackgroundWork(ctx);
  return ctx;
}

/** Domain events drive the metrics, so instrumentation never has to be
 *  threaded through business logic by hand. */
function wireEventMetrics(): void {
  bus.onAny((e) => {
    metrics.counter('lumen_events_total', 'domain events emitted').inc({ name: e.name });
  });
  bus.on('misconception.detected', (e) => {
    metrics.counter('lumen_misconceptions_detected_total').inc({ concept: e.payload.conceptId || 'unknown' });
  });
  bus.on('learner.frustration.detected', (e) => {
    metrics.counter('lumen_friction_interventions_total').inc({ signals: String(e.payload.signals.length) });
  });
  bus.on('prereq.gap.found', (e) => {
    metrics.counter('lumen_prereq_gaps_total').inc({ gaps: String(e.payload.gapConceptIds.length) });
  });
}

function startBackgroundWork(ctx: AppContext): void {
  jobs.register('ingest', async (payload: Parameters<IngestionPipeline['ingest']>[0], { progress }) => {
    progress(0.1, 'extracting');
    const report = await ctx.ingestion.ingest(payload);
    progress(1, 'done');
    return report;
  });

  jobs.register('backfill_items', async (payload: { minimum?: number }) =>
    ctx.assessment.backfill(payload.minimum ?? 3));

  jobs.register('recalibrate_items', async (payload: { minResponses?: number }) =>
    ctx.assessment.recalibrate({ minResponses: payload.minResponses ?? 12 }));

  jobs.register('build_visual', async (payload: Parameters<VisualEngine['build']>[0]) =>
    ctx.visual.build(payload));

  jobs.start();

  // Recalibrating from real responses keeps the bank honest as evidence grows.
  scheduler.every('recalibrate', 6 * 60 * 60 * 1000, () => {
    const r = ctx.assessment.recalibrate({ minResponses: 15 });
    if (r.recalibrated.length) logger.info('items recalibrated', { count: r.recalibrated.length });
  });

  // Decay sweep: surface knowledge that has faded without waiting for a session.
  scheduler.every('decay_sweep', 60 * 60 * 1000, () => {
    let flagged = 0;
    for (const l of ctx.repos.learners.list(500)) {
      flagged += ctx.twin.decayedConcepts(l.id, 5).length;
    }
    metrics.gauge('lumen_decayed_concepts').set(flagged);
  });

  scheduler.start();
}

export function shutdown(): void {
  jobs.stop();
  scheduler.stop();
}
