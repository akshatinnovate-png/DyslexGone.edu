import { clamp, newtonSolve, round } from '../core/mathx.js';

/** Item Response Theory: the 3-parameter logistic model.
 *
 *  BKT asks "does this learner know concept X". IRT asks "how hard an item can
 *  this learner handle, on one scale shared by every item in the bank". That
 *  shared scale is what makes adaptive testing possible: pick the item whose
 *  answer tells you the most, not the next one on the list. */

export interface IrtItem {
  id: string;
  /** discrimination - how sharply the item separates ability levels */
  a: number;
  /** difficulty - the ability at which P(correct) is halfway up */
  b: number;
  /** guessing - the floor for a learner who knows nothing */
  c: number;
}

export interface IrtResponse { item: IrtItem; correct: boolean; }

const D = 1.702;   // scaling constant that makes logistic ≈ normal ogive

/** P(correct | ability) for the 3PL model. */
export function probability(theta: number, item: IrtItem): number {
  const c = clamp(item.c, 0, 0.5);
  const z = D * item.a * (theta - item.b);
  return round(c + (1 - c) * (1 / (1 + Math.exp(-z))), 6);
}

/** Fisher information: how much this item would tell us about THIS learner. */
export function information(theta: number, item: IrtItem): number {
  const p = probability(theta, item);
  const c = clamp(item.c, 0, 0.5);
  if (p <= c + 1e-9 || p >= 1 - 1e-9) return 0;
  const q = 1 - p;
  const num = (D * item.a) ** 2 * q * (p - c) ** 2;
  const den = p * (1 - c) ** 2;
  return round(num / Math.max(1e-12, den), 6);
}

/** Maximum-likelihood ability estimate with a weak prior (so an all-correct or
 *  all-wrong run does not run off to infinity). */
export function estimateAbility(
  responses: IrtResponse[],
  opts: { prior?: { mean: number; sd: number }; start?: number } = {},
): { theta: number; se: number; converged: boolean; responses: number } {
  const prior = opts.prior ?? { mean: 0, sd: 1.5 };
  if (!responses.length) {
    return { theta: prior.mean, se: prior.sd, converged: false, responses: 0 };
  }

  // d/dtheta of the log-likelihood. For the 3PL this reduces to
  //   D * a * (u - P) * (P - c) / (P * (1 - c))
  // after substituting sigma = (P - c) / (1 - c).
  const dLogL = (theta: number): number => {
    let s = -(theta - prior.mean) / (prior.sd * prior.sd);
    for (const { item, correct } of responses) {
      const p = probability(theta, item);
      const c = clamp(item.c, 0, 0.5);
      const u = correct ? 1 : 0;
      s += (D * item.a * (u - p) * (p - c)) / Math.max(1e-9, p * (1 - c));
    }
    return s;
  };

  const d2LogL = (theta: number): number => {
    let s = -1 / (prior.sd * prior.sd);
    for (const { item } of responses) s -= information(theta, item);
    return s;
  };

  const theta = newtonSolve(dLogL, d2LogL, opts.start ?? 0, { lo: -4, hi: 4, tol: 1e-5, maxIter: 60 });
  const info = responses.reduce((a, r) => a + information(theta, r.item), 0) + 1 / (prior.sd * prior.sd);
  return {
    theta: round(theta, 4),
    se: round(1 / Math.sqrt(Math.max(1e-9, info)), 4),
    converged: Math.abs(dLogL(theta)) < 1e-3,
    responses: responses.length,
  };
}

/** Expected a-posteriori estimate by numeric quadrature - more stable than MLE
 *  on short tests, which is most of what a classroom actually runs. */
export function estimateAbilityEap(
  responses: IrtResponse[],
  opts: { prior?: { mean: number; sd: number }; points?: number } = {},
): { theta: number; se: number; posterior: { theta: number; density: number }[] } {
  const prior = opts.prior ?? { mean: 0, sd: 1.2 };
  const points = opts.points ?? 61;
  const lo = -4;
  const hi = 4;
  const step = (hi - lo) / (points - 1);

  const grid: { theta: number; density: number }[] = [];
  let norm = 0;
  for (let i = 0; i < points; i++) {
    const theta = lo + i * step;
    const priorD = Math.exp(-((theta - prior.mean) ** 2) / (2 * prior.sd ** 2));
    let like = priorD;
    for (const { item, correct } of responses) {
      const p = probability(theta, item);
      like *= correct ? p : 1 - p;
    }
    grid.push({ theta, density: like });
    norm += like * step;
  }
  if (norm <= 0) return { theta: prior.mean, se: prior.sd, posterior: [] };

  const posterior = grid.map((g) => ({ theta: round(g.theta, 3), density: round(g.density / norm, 8) }));
  const mean = posterior.reduce((a, g) => a + g.theta * g.density * step, 0);
  const variance = posterior.reduce((a, g) => a + (g.theta - mean) ** 2 * g.density * step, 0);
  return { theta: round(mean, 4), se: round(Math.sqrt(Math.max(0, variance)), 4), posterior };
}

/** Pick the item that tells us the most, with exposure control so the bank is
 *  not burned through by always serving the same few items. */
export function selectNextItem(
  theta: number,
  candidates: IrtItem[],
  opts: {
    exclude?: Set<string>;
    exposure?: Map<string, number>;
    randomesque?: number;     // pick at random from the top N
    seedIndex?: number;
    targetInfo?: number;
  } = {},
): { item: IrtItem; information: number; reason: string } | null {
  const pool = candidates.filter((c) => !opts.exclude?.has(c.id));
  if (!pool.length) return null;

  const scored = pool.map((item) => {
    const info = information(theta, item);
    const exposure = opts.exposure?.get(item.id) ?? 0;
    // Discount over-exposed items so the bank stays usable across a cohort.
    const penalty = 1 / (1 + exposure * 0.08);
    return { item, info, score: info * penalty, exposure };
  }).sort((a, b) => b.score - a.score);

  const top = scored.slice(0, Math.max(1, opts.randomesque ?? 3));
  const chosen = top[(opts.seedIndex ?? 0) % top.length];

  return {
    item: chosen.item,
    information: round(chosen.info, 5),
    reason: `At ability ${round(theta, 2)} this item carries ${round(chosen.info, 3)} information `
      + `(difficulty ${round(chosen.item.b, 2)}, discrimination ${round(chosen.item.a, 2)}). `
      + `Predicted chance of success: ${Math.round(probability(theta, chosen.item) * 100)}% - `
      + `near the 50-60% sweet spot where an answer is most informative.`,
  };
}

export interface AdaptiveStopRule {
  maxItems?: number;
  minItems?: number;
  targetSe?: number;
  maxSeconds?: number;
}

export function shouldStop(
  state: { responses: number; se: number; elapsedSec?: number },
  rule: AdaptiveStopRule = {},
): { stop: boolean; reason: string } {
  const minItems = rule.minItems ?? 4;
  const maxItems = rule.maxItems ?? 20;
  const targetSe = rule.targetSe ?? 0.32;

  if (state.responses < minItems) {
    return { stop: false, reason: `only ${state.responses} of a minimum ${minItems} items answered` };
  }
  if (state.se <= targetSe) {
    return { stop: true, reason: `measurement is precise enough (standard error ${round(state.se, 3)} ≤ ${targetSe})` };
  }
  if (state.responses >= maxItems) {
    return { stop: true, reason: `reached the ${maxItems}-item ceiling; stopping rather than tiring the learner out` };
  }
  if (rule.maxSeconds && (state.elapsedSec ?? 0) >= rule.maxSeconds) {
    return { stop: true, reason: `time limit of ${rule.maxSeconds}s reached` };
  }
  return { stop: false, reason: `standard error is ${round(state.se, 3)}, still above the ${targetSe} target` };
}

/** Calibrate difficulty and discrimination from observed responses.
 *  Joint maximum likelihood over a coarse grid: small data, stable answers. */
export function calibrateItem(
  observations: { theta: number; correct: boolean }[],
  opts: { guessing?: number } = {},
): { a: number; b: number; c: number; n: number; logLikelihood: number } | null {
  if (observations.length < 5) return null;
  const c = opts.guessing ?? 0;
  let best = { a: 1, b: 0, logL: -Infinity };

  for (let a = 0.4; a <= 2.6; a += 0.2) {
    for (let b = -3; b <= 3; b += 0.2) {
      let ll = 0;
      for (const o of observations) {
        const p = probability(o.theta, { id: 'x', a, b, c });
        ll += Math.log(Math.max(1e-9, o.correct ? p : 1 - p));
      }
      if (ll > best.logL) best = { a, b, logL: ll };
    }
  }
  return { a: round(best.a, 3), b: round(best.b, 3), c, n: observations.length, logLikelihood: round(best.logL, 4) };
}

/** Human-readable band for an ability estimate. */
export function abilityBand(theta: number, se: number): { band: string; description: string; confidence: string } {
  const band = theta < -1.5 ? 'well below' : theta < -0.5 ? 'below' : theta <= 0.5 ? 'at' : theta <= 1.5 ? 'above' : 'well above';
  const confidence = se <= 0.25 ? 'high' : se <= 0.45 ? 'moderate' : 'low';
  return {
    band,
    description: `${band} the expected level for this material`,
    confidence: `${confidence} confidence (standard error ${round(se, 2)}; ability is roughly ${round(theta - 1.96 * se, 2)} to ${round(theta + 1.96 * se, 2)})`,
  };
}
