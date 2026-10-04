import { id } from './ids.js';
import { logger } from './logger.js';
import { metrics } from './metrics.js';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'dead';

export interface Job<P = unknown, R = unknown> {
  id: string;
  kind: string;
  payload: P;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  priority: number;
  runAt: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: R;
  error?: string;
  progress: number;
  progressNote?: string;
}

export type JobHandler<P = any, R = any> = (
  payload: P,
  ctx: { job: Job<P, R>; progress: (pct: number, note?: string) => void; log: typeof logger },
) => Promise<R>;

/** In-process priority queue with backoff, dead-lettering and progress reporting.
 *  Keeps heavy work (ingestion, lesson forging, batch rendering) off the request path. */
export class JobQueue {
  private jobs = new Map<string, Job>();
  private handlers = new Map<string, JobHandler>();
  private pending: string[] = [];
  private running = new Set<string>();
  private timer?: NodeJS.Timeout;
  private waiters = new Map<string, Array<(j: Job) => void>>();

  constructor(private readonly concurrency = 3, private readonly tickMs = 50) {}

  register<P, R>(kind: string, handler: JobHandler<P, R>): void {
    this.handlers.set(kind, handler as JobHandler);
  }

  enqueue<P>(kind: string, payload: P, opts: { maxAttempts?: number; priority?: number; delayMs?: number } = {}): Job<P> {
    if (!this.handlers.has(kind)) throw new Error(`no handler registered for job kind '${kind}'`);
    const job: Job<P> = {
      id: id('job'), kind, payload, status: 'queued', attempts: 0,
      maxAttempts: opts.maxAttempts ?? 3, priority: opts.priority ?? 5,
      runAt: Date.now() + (opts.delayMs ?? 0), createdAt: Date.now(), progress: 0,
    };
    this.jobs.set(job.id, job as Job);
    this.pending.push(job.id);
    metrics.counter('lumen_jobs_enqueued_total').inc({ kind });
    return job;
  }

  get(jobId: string): Job | undefined { return this.jobs.get(jobId); }

  list(filter: { kind?: string; status?: JobStatus; limit?: number } = {}): Job[] {
    let all = [...this.jobs.values()];
    if (filter.kind) all = all.filter((j) => j.kind === filter.kind);
    if (filter.status) all = all.filter((j) => j.status === filter.status);
    return all.sort((a, b) => b.createdAt - a.createdAt).slice(0, filter.limit ?? 100);
  }

  /** Resolves when the job reaches a terminal state. */
  wait(jobId: string, timeoutMs = 120_000): Promise<Job> {
    const j = this.jobs.get(jobId);
    if (!j) return Promise.reject(new Error(`unknown job ${jobId}`));
    if (j.status === 'done' || j.status === 'failed' || j.status === 'dead') return Promise.resolve(j);
    return new Promise((resolve, reject) => {
      const arr = this.waiters.get(jobId) ?? [];
      arr.push(resolve);
      this.waiters.set(jobId, arr);
      setTimeout(() => reject(new Error(`job ${jobId} wait timed out`)), timeoutMs).unref?.();
    });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  stats() {
    const byStatus: Record<string, number> = {};
    for (const j of this.jobs.values()) byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;
    return { total: this.jobs.size, running: this.running.size, pending: this.pending.length, byStatus };
  }

  private async tick(): Promise<void> {
    if (this.running.size >= this.concurrency || !this.pending.length) return;
    const now = Date.now();
    const ready = this.pending
      .map((jid) => this.jobs.get(jid)!)
      .filter((j) => j && j.runAt <= now && j.status === 'queued')
      .sort((a, b) => a.priority - b.priority || a.runAt - b.runAt);
    const slots = this.concurrency - this.running.size;
    for (const job of ready.slice(0, slots)) {
      this.pending = this.pending.filter((x) => x !== job.id);
      void this.run(job);
    }
  }

  private async run(job: Job): Promise<void> {
    const handler = this.handlers.get(job.kind);
    if (!handler) { job.status = 'dead'; job.error = 'handler missing'; return; }
    this.running.add(job.id);
    job.status = 'running';
    job.attempts++;
    job.startedAt = Date.now();
    const t0 = performance.now();
    try {
      job.result = await handler(job.payload, {
        job,
        progress: (pct, note) => { job.progress = Math.max(0, Math.min(1, pct)); job.progressNote = note; },
        log: logger,
      });
      job.status = 'done';
      job.progress = 1;
      metrics.counter('lumen_jobs_completed_total').inc({ kind: job.kind, outcome: 'done' });
    } catch (e) {
      job.error = e instanceof Error ? e.message : String(e);
      if (job.attempts < job.maxAttempts) {
        job.status = 'queued';
        job.runAt = Date.now() + Math.min(30_000, 500 * 2 ** job.attempts);
        this.pending.push(job.id);
        logger.warn('job retry scheduled', { job: job.id, kind: job.kind, attempt: job.attempts, err: job.error });
      } else {
        job.status = 'dead';
        metrics.counter('lumen_jobs_completed_total').inc({ kind: job.kind, outcome: 'dead' });
        logger.error('job dead-lettered', { job: job.id, kind: job.kind, err: job.error });
      }
    } finally {
      job.finishedAt = Date.now();
      this.running.delete(job.id);
      metrics.histogram('lumen_job_duration_ms').observe(performance.now() - t0, { kind: job.kind });
      if (job.status !== 'queued') {
        for (const w of this.waiters.get(job.id) ?? []) w(job);
        this.waiters.delete(job.id);
      }
    }
  }
}

export interface ScheduledTask {
  name: string;
  everyMs: number;
  fn: () => void | Promise<void>;
  lastRun?: number;
  runs: number;
  failures: number;
}

/** Tiny interval scheduler for decay sweeps, cache sweeps, experiment analysis. */
export class Scheduler {
  private tasks: ScheduledTask[] = [];
  private timer?: NodeJS.Timeout;

  every(name: string, everyMs: number, fn: () => void | Promise<void>): void {
    this.tasks.push({ name, everyMs, fn, runs: 0, failures: 0 });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const t of this.tasks) {
        if ((t.lastRun ?? 0) + t.everyMs > now) continue;
        t.lastRun = now;
        t.runs++;
        try {
          const r = t.fn();
          if (r instanceof Promise) r.catch((e) => { t.failures++; logger.warn('scheduled task failed', { name: t.name, err: String(e) }); });
        } catch (e) {
          t.failures++;
          logger.warn('scheduled task threw', { name: t.name, err: String(e) });
        }
      }
    }, 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  list(): Omit<ScheduledTask, 'fn'>[] {
    return this.tasks.map(({ fn, ...rest }) => { void fn; return rest; });
  }
}

export const jobs = new JobQueue(4);
export const scheduler = new Scheduler();
