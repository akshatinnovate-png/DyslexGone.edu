import { AppError } from './errors.js';

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitOptions {
  failureThreshold?: number;
  successThreshold?: number;
  openMs?: number;
  name?: string;
}

/** Protects upstream model providers: fails fast while they're unhealthy. */
export class CircuitBreaker {
  private failures = 0;
  private successes = 0;
  private openedAt = 0;
  private _state: CircuitState = 'closed';
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly openMs: number;
  readonly name: string;

  constructor(opts: CircuitOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.successThreshold = opts.successThreshold ?? 2;
    this.openMs = opts.openMs ?? 20_000;
    this.name = opts.name ?? 'circuit';
  }

  get state(): CircuitState {
    if (this._state === 'open' && Date.now() - this.openedAt >= this.openMs) this._state = 'half_open';
    return this._state;
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      throw new AppError('upstream_failed', `${this.name} circuit is open`, { retryable: true });
    }
    try {
      const out = await fn();
      this.onSuccess();
      return out;
    } catch (e) {
      this.onFailure();
      throw e;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    if (this._state === 'half_open') {
      this.successes++;
      if (this.successes >= this.successThreshold) { this._state = 'closed'; this.successes = 0; }
    }
  }

  private onFailure(): void {
    this.successes = 0;
    this.failures++;
    if (this.failures >= this.failureThreshold || this._state === 'half_open') {
      this._state = 'open';
      this.openedAt = Date.now();
    }
  }

  snapshot() {
    return { name: this.name, state: this.state, failures: this.failures, successes: this.successes };
  }
}

export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  maxMs?: number;
  jitter?: boolean;
  retryOn?: (e: unknown) => boolean;
  onRetry?: (attempt: number, e: unknown, delayMs: number) => void;
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  const base = opts.baseMs ?? 350;
  const max = opts.maxMs ?? 8000;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastError = e;
      const retryable = opts.retryOn ? opts.retryOn(e) : true;
      if (!retryable || attempt === retries) break;
      const expo = Math.min(max, base * 2 ** attempt);
      const delay = opts.jitter === false ? expo : Math.floor(expo * (0.6 + Math.random() * 0.8));
      opts.onRetry?.(attempt + 1, e, delay);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

export async function withTimeout<T>(p: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AppError('timeout', `${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Bounded-concurrency map, preserving input order. */
export async function pMap<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
