import type { Modality } from '../domain/types.js';
import { betaInterval, betaMean, clamp, round, sampleBeta, seededRng, type Rng } from '../core/mathx.js';

/** Which representation works for THIS learner?
 *
 *  A contextual multi-armed bandit over modalities. Thompson sampling on a Beta
 *  posterior per arm: it explores early, exploits once the evidence is in, and
 *  never permanently writes off a modality the way a greedy rule would. */

export interface Arm {
  modality: Modality;
  alpha: number;        // successes + 1
  beta: number;         // failures + 1
  trials: number;
  rewardSum: number;
}

export interface ArmEstimate {
  modality: Modality;
  mean: number;
  interval: [number, number];
  trials: number;
  /** Posterior sample that drove this round's choice. */
  sample?: number;
  /** Prior nudge from the accessibility profile. */
  contextBoost: number;
  score: number;
  confidence: 'none' | 'weak' | 'moderate' | 'strong';
}

export interface Selection {
  chosen: Modality;
  strategy: 'thompson' | 'ucb' | 'forced_exploration' | 'context_only';
  estimates: ArmEstimate[];
  explanation: string;
}

const confidenceFor = (trials: number): ArmEstimate['confidence'] =>
  trials === 0 ? 'none' : trials < 3 ? 'weak' : trials < 10 ? 'moderate' : 'strong';

export function armEstimates(
  arms: Arm[],
  contextWeights: Partial<Record<Modality, number>> = {},
): ArmEstimate[] {
  return arms.map((a) => {
    const boost = contextWeights[a.modality] ?? 0;
    const mean = betaMean(a.alpha, a.beta);
    return {
      modality: a.modality,
      mean: round(mean, 4),
      interval: betaInterval(a.alpha, a.beta).map((v) => round(v, 3)) as [number, number],
      trials: a.trials,
      contextBoost: round(boost, 3),
      score: round(clamp(mean + boost * 0.4), 4),
      confidence: confidenceFor(a.trials),
    };
  });
}

/** Thompson sampling with an accessibility prior folded in.
 *
 *  The access profile is not a tiebreaker bolted on afterwards - it enters as a
 *  pseudo-count prior, so a learner who needs audio starts with audio ahead,
 *  and real evidence can still overturn it. */
export function selectModality(
  arms: Arm[],
  opts: {
    contextWeights?: Partial<Record<Modality, number>>;
    blocked?: Modality[];
    exclude?: Modality[];
    rng?: Rng;
    seed?: string;
    minTrialsBeforeExploit?: number;
    strategy?: 'thompson' | 'ucb';
  } = {},
): Selection {
  const rng = opts.rng ?? seededRng(opts.seed ?? String(Date.now()));
  const blocked = new Set([...(opts.blocked ?? []), ...(opts.exclude ?? [])]);
  const pool = arms.filter((a) => !blocked.has(a.modality));
  const context = opts.contextWeights ?? {};

  if (!pool.length) {
    const fallback = arms[0]?.modality ?? 'text';
    return {
      chosen: fallback,
      strategy: 'context_only',
      estimates: armEstimates(arms, context),
      explanation: 'Every modality was blocked by the access profile; falling back to the first available.',
    };
  }

  const totalTrials = pool.reduce((a, b) => a + b.trials, 0);
  const untried = pool.filter((a) => a.trials === 0);

  // Cold start: try each modality once, highest context prior first, so the
  // profile decides the order of exploration rather than being ignored.
  if (untried.length && totalTrials < (opts.minTrialsBeforeExploit ?? pool.length)) {
    const chosen = untried
      .sort((a, b) => (context[b.modality] ?? 0) - (context[a.modality] ?? 0))[0];
    return {
      chosen: chosen.modality,
      strategy: 'forced_exploration',
      estimates: armEstimates(pool, context),
      explanation: `No evidence yet for ${chosen.modality}. Trying it first because the access profile favours it (prior ${round(context[chosen.modality] ?? 0, 2)}).`,
    };
  }

  if (opts.strategy === 'ucb') {
    const estimates = armEstimates(pool, context).map((e) => {
      const bonus = e.trials === 0 ? 2 : Math.sqrt((2 * Math.log(Math.max(2, totalTrials))) / e.trials);
      return { ...e, score: round(clamp(e.mean + e.contextBoost * 0.4 + bonus * 0.3), 4) };
    }).sort((a, b) => b.score - a.score);
    return {
      chosen: estimates[0].modality,
      strategy: 'ucb',
      estimates,
      explanation: `UCB chose ${estimates[0].modality}: mean reward ${estimates[0].mean} over ${estimates[0].trials} trials, plus an exploration bonus.`,
    };
  }

  const sampled = pool.map((a) => {
    const boost = context[a.modality] ?? 0;
    // Context enters as pseudo-counts, not as a post-hoc bonus.
    const alpha = a.alpha + boost * 2.5;
    const beta = a.beta + Math.max(0, -boost) * 2.5;
    const sample = sampleBeta(rng, Math.max(0.05, alpha), Math.max(0.05, beta));
    return { arm: a, sample, boost };
  }).sort((a, b) => b.sample - a.sample);

  const winner = sampled[0];
  const estimates = armEstimates(pool, context)
    .map((e) => ({ ...e, sample: round(sampled.find((s) => s.arm.modality === e.modality)?.sample ?? 0, 4) }))
    .sort((a, b) => (b.sample ?? 0) - (a.sample ?? 0));

  const runnerUp = estimates[1];
  return {
    chosen: winner.arm.modality,
    strategy: 'thompson',
    estimates,
    explanation:
      `Thompson sampling drew ${round(winner.sample, 3)} for ${winner.arm.modality} `
      + `(posterior mean ${round(betaMean(winner.arm.alpha, winner.arm.beta), 3)} from ${winner.arm.trials} trials`
      + `${winner.boost ? `, access prior +${round(winner.boost, 2)}` : ''})`
      + (runnerUp ? `, beating ${runnerUp.modality} at ${round(runnerUp.sample ?? 0, 3)}.` : '.'),
  };
}

/** Record how well a delivered modality actually worked, 0..1. */
export function updateArm(arm: Arm, reward: number): Arm {
  const r = clamp(reward);
  return {
    ...arm,
    alpha: round(arm.alpha + r, 4),
    beta: round(arm.beta + (1 - r), 4),
    trials: arm.trials + 1,
    rewardSum: round(arm.rewardSum + r, 4),
  };
}

/** Composite reward for a delivered experience.
 *
 *  Correctness alone would reward easy content. This blends learning gain,
 *  independence, engagement and efficiency, so a modality that produces real
 *  understanding with little hand-holding wins. */
export function computeReward(signals: {
  correct?: boolean;
  masteryGain?: number;        // change in P(known)
  hintsUsed?: number;
  latencyMs?: number;
  expectedMs?: number;
  completed?: boolean;
  selfReportedClarity?: number; // 0..1
  retries?: number;
  abandoned?: boolean;
}): { reward: number; breakdown: Record<string, number> } {
  const breakdown: Record<string, number> = {};

  breakdown.correctness = signals.correct === undefined ? 0.5 : signals.correct ? 1 : 0;
  breakdown.masteryGain = clamp(((signals.masteryGain ?? 0) + 0.15) / 0.45);
  breakdown.independence = clamp(1 - (signals.hintsUsed ?? 0) * 0.3);
  breakdown.completion = signals.abandoned ? 0 : signals.completed === false ? 0.3 : 1;
  breakdown.persistence = clamp(1 - Math.max(0, (signals.retries ?? 0) - 1) * 0.25);

  const expected = signals.expectedMs ?? 45_000;
  const latency = signals.latencyMs ?? expected;
  // Too fast means skimming, too slow means struggling: peak in the middle.
  breakdown.pacing = clamp(1 - Math.abs(Math.log(Math.max(0.05, latency / expected))) / 1.6);

  if (signals.selfReportedClarity !== undefined) {
    breakdown.clarity = clamp(signals.selfReportedClarity);
  }

  const weights: Record<string, number> = {
    correctness: 0.26, masteryGain: 0.26, independence: 0.14,
    completion: 0.12, persistence: 0.07, pacing: 0.08, clarity: 0.07,
  };
  let total = 0;
  let used = 0;
  for (const [k, v] of Object.entries(breakdown)) {
    const w = weights[k] ?? 0;
    total += v * w;
    used += w;
  }
  return {
    reward: round(clamp(used > 0 ? total / used : 0.5), 4),
    breakdown: Object.fromEntries(Object.entries(breakdown).map(([k, v]) => [k, round(v, 3)])),
  };
}

/** Is one modality now provably better than this learner's current default? */
export function hasClearWinner(arms: Arm[], minTrials = 6, minGap = 0.15): { winner: Modality; gap: number } | null {
  const eligible = arms.filter((a) => a.trials >= minTrials);
  if (eligible.length < 2) return null;
  const sorted = eligible
    .map((a) => ({ m: a.modality, lo: betaInterval(a.alpha, a.beta)[0], hi: betaInterval(a.alpha, a.beta)[1], mean: betaMean(a.alpha, a.beta) }))
    .sort((a, b) => b.mean - a.mean);
  const [first, second] = sorted;
  // Require the intervals to separate, not just the means.
  if (first.lo > second.hi && first.mean - second.mean >= minGap) {
    return { winner: first.m, gap: round(first.mean - second.mean, 4) };
  }
  return null;
}
