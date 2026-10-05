/** Token-bucket limiter keyed by caller identity. */
export interface RateDecision { allowed: boolean; remaining: number; retryAfterMs: number; limit: number; }

interface Bucket { tokens: number; last: number; }

export class TokenBucket {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
    /** Tokens a brand-new caller starts with. Defaults to a full bucket. */
    private readonly initial = capacity,
  ) {}

  static perWindow(max: number, windowMs: number, burst?: number): TokenBucket {
    // `burst` raises the ceiling above the steady-state rate; it never lowers
    // the starting balance, or the first N requests of every process 429.
    const capacity = Math.max(max, burst ?? max);
    return new TokenBucket(capacity, max / windowMs, capacity);
  }

  take(key: string, cost = 1): RateDecision {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.initial, last: now };
    const elapsed = now - b.last;
    b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerMs);
    b.last = now;
    if (b.tokens >= cost) {
      b.tokens -= cost;
      this.buckets.set(key, b);
      return { allowed: true, remaining: Math.floor(b.tokens), retryAfterMs: 0, limit: this.capacity };
    }
    this.buckets.set(key, b);
    const deficit = cost - b.tokens;
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.ceil(deficit / this.refillPerMs),
      limit: this.capacity,
    };
  }

  reset(key?: string): void {
    if (key) this.buckets.delete(key);
    else this.buckets.clear();
  }

  /** Drop idle buckets so long-lived processes don't leak memory. */
  sweep(idleMs = 10 * 60_000): number {
    const cutoff = Date.now() - idleMs;
    let removed = 0;
    for (const [k, v] of this.buckets) if (v.last < cutoff) { this.buckets.delete(k); removed++; }
    return removed;
  }

  get size(): number { return this.buckets.size; }
}
