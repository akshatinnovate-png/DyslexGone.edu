/** Numerics + statistics used across the twin, IRT, bandits and experiments. */

export const clamp = (x: number, lo = 0, hi = 1): number => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * clamp(t);
export const round = (x: number, dp = 4): number => {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
};

export const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
export const mean = (xs: readonly number[]): number => (xs.length ? sum(xs) / xs.length : 0);

export function variance(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1);
}
export const stdev = (xs: readonly number[]): number => Math.sqrt(variance(xs));

export function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function percentile(xs: readonly number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = clamp(p, 0, 1) * (s.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

export const logistic = (x: number): number => 1 / (1 + Math.exp(-x));
export const logit = (p: number): number => {
  const q = clamp(p, 1e-9, 1 - 1e-9);
  return Math.log(q / (1 - q));
};

export function softmax(xs: readonly number[], temperature = 1): number[] {
  if (!xs.length) return [];
  const t = Math.max(1e-6, temperature);
  const m = Math.max(...xs);
  const e = xs.map((x) => Math.exp((x - m) / t));
  const z = sum(e) || 1;
  return e.map((v) => v / z);
}

export function entropy(ps: readonly number[]): number {
  return -sum(ps.filter((p) => p > 0).map((p) => p * Math.log2(p)));
}

export function klDivergence(p: readonly number[], q: readonly number[]): number {
  let d = 0;
  for (let i = 0; i < p.length; i++) {
    const pi = p[i], qi = q[i] ?? 1e-12;
    if (pi > 0) d += pi * Math.log(pi / Math.max(qi, 1e-12));
  }
  return d;
}

/* ------------------------------- error fn ------------------------------- */

export function erf(x: number): number {
  // Abramowitz & Stegun 7.1.26, |error| < 1.5e-7
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return s * (1 - poly * Math.exp(-a * a));
}

export const normalCdf = (x: number, mu = 0, sigma = 1): number => 0.5 * (1 + erf((x - mu) / (sigma * Math.SQRT2)));

export function normalPpf(p: number): number {
  // Acklam's inverse normal CDF approximation.
  const q = clamp(p, 1e-12, 1 - 1e-12);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425, pHigh = 1 - pLow;
  if (q < pLow) {
    const u = Math.sqrt(-2 * Math.log(q));
    return (((((c[0] * u + c[1]) * u + c[2]) * u + c[3]) * u + c[4]) * u + c[5]) /
      ((((d[0] * u + d[1]) * u + d[2]) * u + d[3]) * u + 1);
  }
  if (q > pHigh) {
    const u = Math.sqrt(-2 * Math.log(1 - q));
    return -(((((c[0] * u + c[1]) * u + c[2]) * u + c[3]) * u + c[4]) * u + c[5]) /
      ((((d[0] * u + d[1]) * u + d[2]) * u + d[3]) * u + 1);
  }
  const u = q - 0.5, r = u * u;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * u /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/* --------------------------------- RNG ---------------------------------- */

export type Rng = () => number;

/** mulberry32 - small, fast, seedable. Deterministic demos depend on this. */
export function seededRng(seed: number | string): Rng {
  let a = typeof seed === 'number' ? seed >>> 0 : hashStringToInt(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStringToInt(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function sampleNormal(rng: Rng, mu = 0, sigma = 1): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Marsaglia-Tsang gamma sampler (shape >= 0). */
export function sampleGamma(rng: Rng, shape: number, scale = 1): number {
  if (shape <= 0) return 0;
  if (shape < 1) return sampleGamma(rng, shape + 1, scale) * Math.pow(rng(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = sampleNormal(rng);
    const v = 1 + c * x;
    if (v <= 0) continue;
    const v3 = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4) return d * v3 * scale;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v3 + Math.log(v3))) return d * v3 * scale;
  }
}

export function sampleBeta(rng: Rng, alpha: number, beta: number): number {
  const x = sampleGamma(rng, Math.max(alpha, 1e-6));
  const y = sampleGamma(rng, Math.max(beta, 1e-6));
  return x + y === 0 ? 0.5 : x / (x + y);
}

export const betaMean = (a: number, b: number): number => a / Math.max(a + b, 1e-9);
export function betaStd(a: number, b: number): number {
  const n = a + b;
  return Math.sqrt((a * b) / (n * n * (n + 1)));
}
/** Normal-approximation credible interval for a Beta posterior. */
export function betaInterval(a: number, b: number, level = 0.95): [number, number] {
  const m = betaMean(a, b), s = betaStd(a, b);
  const z = normalPpf(1 - (1 - level) / 2);
  return [clamp(m - z * s), clamp(m + z * s)];
}

/** P(theta_a > theta_b) for two Beta posteriors, by Monte Carlo. */
export function betaProbGreater(a1: number, b1: number, a2: number, b2: number, draws = 4000, seed = 7): number {
  const rng = seededRng(seed);
  let wins = 0;
  for (let i = 0; i < draws; i++) if (sampleBeta(rng, a1, b1) > sampleBeta(rng, a2, b2)) wins++;
  return wins / draws;
}

export function shuffle<T>(xs: readonly T[], rng: Rng): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function weightedChoice<T>(items: readonly T[], weights: readonly number[], rng: Rng): T {
  const total = sum(weights.map((w) => Math.max(0, w)));
  if (total <= 0) return items[Math.floor(rng() * items.length)];
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= Math.max(0, weights[i]);
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/* ------------------------------- vectors -------------------------------- */

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

export function euclidean(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) s += ((a[i] ?? 0) - (b[i] ?? 0)) ** 2;
  return Math.sqrt(s);
}

/** k-means++ seeding, Lloyd iterations. Used by the classroom grouper. */
export function kmeans(points: readonly number[][], k: number, opts: { maxIter?: number; seed?: number | string } = {}):
  { centroids: number[][]; assignments: number[]; inertia: number; iterations: number } {
  const n = points.length;
  const kk = Math.max(1, Math.min(k, n));
  if (n === 0) return { centroids: [], assignments: [], inertia: 0, iterations: 0 };
  const rng = seededRng(opts.seed ?? 42);
  const dim = points[0].length;

  const centroids: number[][] = [[...points[Math.floor(rng() * n)]]];
  while (centroids.length < kk) {
    const d2 = points.map((p) => Math.min(...centroids.map((c) => euclidean(p, c) ** 2)));
    centroids.push([...weightedChoice(points as number[][], d2, rng)]);
  }

  let assignments = new Array<number>(n).fill(0);
  let iterations = 0;
  const maxIter = opts.maxIter ?? 60;
  for (; iterations < maxIter; iterations++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = euclidean(points[i], centroids[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (assignments[i] !== best) { assignments[i] = best; moved = true; }
    }
    for (let c = 0; c < centroids.length; c++) {
      const members = points.filter((_, i) => assignments[i] === c);
      if (!members.length) continue;
      for (let d = 0; d < dim; d++) centroids[c][d] = mean(members.map((m) => m[d] ?? 0));
    }
    if (!moved) break;
  }
  const inertia = sum(points.map((p, i) => euclidean(p, centroids[assignments[i]]) ** 2));
  return { centroids, assignments, inertia, iterations };
}

/* ------------------------------- solvers -------------------------------- */

/** 1-D Newton with bisection fallback; used by IRT ability estimation. */
export function newtonSolve(
  f: (x: number) => number,
  df: (x: number) => number,
  x0: number,
  opts: { lo?: number; hi?: number; tol?: number; maxIter?: number } = {},
): number {
  const lo = opts.lo ?? -6, hi = opts.hi ?? 6, tol = opts.tol ?? 1e-6;
  let x = clamp(x0, lo, hi);
  for (let i = 0; i < (opts.maxIter ?? 50); i++) {
    const fx = f(x);
    if (Math.abs(fx) < tol) return x;
    const d = df(x);
    const step = Math.abs(d) < 1e-9 ? 0 : fx / d;
    let next = x - step;
    if (!Number.isFinite(next) || next < lo || next > hi) next = (lo + hi) / 2 + (x - (lo + hi) / 2) * 0.5;
    if (Math.abs(next - x) < tol) return clamp(next, lo, hi);
    x = clamp(next, lo, hi);
  }
  return x;
}

export function linspace(a: number, b: number, n: number): number[] {
  if (n <= 1) return [a];
  const step = (b - a) / (n - 1);
  return Array.from({ length: n }, (_, i) => a + i * step);
}

/** Runge-Kutta 4 for the physics simulators. */
export function rk4(
  f: (t: number, y: readonly number[]) => number[],
  t: number, y: readonly number[], h: number,
): number[] {
  const add = (a: readonly number[], b: readonly number[], s: number) => a.map((v, i) => v + b[i] * s);
  const k1 = f(t, y);
  const k2 = f(t + h / 2, add(y, k1, h / 2));
  const k3 = f(t + h / 2, add(y, k2, h / 2));
  const k4 = f(t + h, add(y, k3, h));
  return y.map((v, i) => v + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
}

/** Gaussian elimination with partial pivoting. Powers the circuit solver. */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}
