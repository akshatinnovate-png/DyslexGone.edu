/** Dependency-free metrics registry with Prometheus text export. */
type Labels = Record<string, string | number>;

const fmtLabels = (l?: Labels): string => {
  if (!l || !Object.keys(l).length) return '';
  const inner = Object.entries(l).sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`).join(',');
  return `{${inner}}`;
};

class Counter {
  private values = new Map<string, number>();
  constructor(readonly name: string, readonly help: string) {}
  inc(labels?: Labels, by = 1): void {
    const k = fmtLabels(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  get(labels?: Labels): number { return this.values.get(fmtLabels(labels)) ?? 0; }
  total(): number { return [...this.values.values()].reduce((a, b) => a + b, 0); }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [k, v] of this.values) lines.push(`${this.name}${k} ${v}`);
    return lines.join('\n');
  }
  snapshot(): Record<string, number> { return Object.fromEntries(this.values); }
}

class Gauge {
  private values = new Map<string, number>();
  constructor(readonly name: string, readonly help: string) {}
  set(v: number, labels?: Labels): void { this.values.set(fmtLabels(labels), v); }
  add(v: number, labels?: Labels): void {
    const k = fmtLabels(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + v);
  }
  get(labels?: Labels): number { return this.values.get(fmtLabels(labels)) ?? 0; }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const [k, v] of this.values) lines.push(`${this.name}${k} ${v}`);
    return lines.join('\n');
  }
  snapshot(): Record<string, number> { return Object.fromEntries(this.values); }
}

const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000];

class Histogram {
  private series = new Map<string, { counts: number[]; sum: number; n: number; samples: number[] }>();
  constructor(readonly name: string, readonly help: string, readonly buckets: number[] = BUCKETS) {}
  observe(v: number, labels?: Labels): void {
    const k = fmtLabels(labels);
    const s = this.series.get(k) ?? { counts: new Array<number>(this.buckets.length + 1).fill(0), sum: 0, n: 0, samples: [] as number[] };
    let i = this.buckets.findIndex((b) => v <= b);
    if (i < 0) i = this.buckets.length;
    s.counts[i]++;
    s.sum += v;
    s.n++;
    s.samples.push(v);
    if (s.samples.length > 500) s.samples.shift();
    this.series.set(k, s);
  }
  quantile(q: number, labels?: Labels): number {
    const s = this.series.get(fmtLabels(labels));
    if (!s || !s.samples.length) return 0;
    const sorted = [...s.samples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, s] of this.series) {
      const base = k ? k.slice(0, -1) : '{';
      let cum = 0;
      this.buckets.forEach((b, i) => {
        cum += s.counts[i];
        lines.push(`${this.name}_bucket${base}${k ? ',' : ''}le="${b}"} ${cum}`);
      });
      cum += s.counts[this.buckets.length];
      lines.push(`${this.name}_bucket${base}${k ? ',' : ''}le="+Inf"} ${cum}`);
      lines.push(`${this.name}_sum${k} ${s.sum}`);
      lines.push(`${this.name}_count${k} ${s.n}`);
    }
    return lines.join('\n');
  }
  snapshot(): Record<string, { count: number; mean: number; p50: number; p95: number }> {
    const out: Record<string, { count: number; mean: number; p50: number; p95: number }> = {};
    for (const [k, s] of this.series) {
      const sorted = [...s.samples].sort((a, b) => a - b);
      out[k || 'default'] = {
        count: s.n,
        mean: s.n ? Math.round((s.sum / s.n) * 100) / 100 : 0,
        p50: sorted[Math.floor(0.5 * sorted.length)] ?? 0,
        p95: sorted[Math.floor(0.95 * sorted.length)] ?? 0,
      };
    }
    return out;
  }
}

class Registry {
  private counters = new Map<string, Counter>();
  private gauges = new Map<string, Gauge>();
  private histograms = new Map<string, Histogram>();

  counter(name: string, help = name): Counter {
    let c = this.counters.get(name);
    if (!c) { c = new Counter(name, help); this.counters.set(name, c); }
    return c;
  }
  gauge(name: string, help = name): Gauge {
    let g = this.gauges.get(name);
    if (!g) { g = new Gauge(name, help); this.gauges.set(name, g); }
    return g;
  }
  histogram(name: string, help = name, buckets?: number[]): Histogram {
    let h = this.histograms.get(name);
    if (!h) { h = new Histogram(name, help, buckets); this.histograms.set(name, h); }
    return h;
  }
  renderProm(): string {
    return [
      ...[...this.counters.values()].map((c) => c.render()),
      ...[...this.gauges.values()].map((g) => g.render()),
      ...[...this.histograms.values()].map((h) => h.render()),
    ].join('\n\n') + '\n';
  }
  snapshot() {
    return {
      counters: Object.fromEntries([...this.counters].map(([k, v]) => [k, v.snapshot()])),
      gauges: Object.fromEntries([...this.gauges].map(([k, v]) => [k, v.snapshot()])),
      histograms: Object.fromEntries([...this.histograms].map(([k, v]) => [k, v.snapshot()])),
    };
  }
}

export const metrics = new Registry();

export function timed<T>(hist: string, labels: Labels, fn: () => T): T {
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    metrics.histogram(hist, hist).observe(performance.now() - t0, labels);
  }
}

export async function timedAsync<T>(hist: string, labels: Labels, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    metrics.histogram(hist, hist).observe(performance.now() - t0, labels);
  }
}
