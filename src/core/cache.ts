/** LRU + TTL cache with stats. Used for LLM responses, graph queries, renders. */
export interface CacheStats { hits: number; misses: number; evictions: number; size: number; }

interface Entry<V> { value: V; expires: number; }

export class LruCache<V> {
  private map = new Map<string, Entry<V>>();
  private hits = 0; private misses = 0; private evictions = 0;

  constructor(private readonly maxSize = 1000, private readonly ttlMs = 0) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) { this.misses++; return undefined; }
    if (e.expires && e.expires < Date.now()) { this.map.delete(key); this.misses++; return undefined; }
    this.map.delete(key);
    this.map.set(key, e);
    this.hits++;
    return e.value;
  }

  has(key: string): boolean { return this.get(key) !== undefined; }

  set(key: string, value: V, ttlMs?: number): void {
    const ttl = ttlMs ?? this.ttlMs;
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expires: ttl > 0 ? Date.now() + ttl : 0 });
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
      this.evictions++;
    }
  }

  async wrap(key: string, fn: () => Promise<V>, ttlMs?: number): Promise<{ value: V; cached: boolean }> {
    const hit = this.get(key);
    if (hit !== undefined) return { value: hit, cached: true };
    const value = await fn();
    this.set(key, value, ttlMs);
    return { value, cached: false };
  }

  delete(key: string): boolean { return this.map.delete(key); }
  clear(): void { this.map.clear(); }
  get stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, evictions: this.evictions, size: this.map.size };
  }
}

/** Collapses concurrent identical requests into one in-flight promise. */
export class SingleFlight<V> {
  private inflight = new Map<string, Promise<V>>();
  run(key: string, fn: () => Promise<V>): Promise<V> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
  get size(): number { return this.inflight.size; }
}
