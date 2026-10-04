import { clamp, round } from '../core/mathx.js';
import { DAY } from '../core/clock.js';

/** Spaced repetition on an FSRS-style three-component memory model:
 *    stability  - how many days until retention falls to the target
 *    difficulty - how resistant this concept is to becoming stable (1..10)
 *    retention  - the forgetting curve evaluated at an elapsed time
 *
 *  Knowledge Recovery Mode uses this to notice that a concept a learner needs
 *  *today* was learned months ago and has decayed. */

export type Rating = 'again' | 'hard' | 'good' | 'easy';

export interface MemoryState {
  stability: number;      // days
  difficulty: number;     // 1..10
  reps: number;
  lapses: number;
  lastReviewMs: number | null;
}

export interface SchedulingDecision {
  state: MemoryState;
  intervalDays: number;
  dueAtMs: number;
  retentionAtReview: number;
  rating: Rating;
  explanation: string;
}

const DECAY = -0.5;
const FACTOR = 19 / 81;

/** Power-law forgetting curve: R(t) = (1 + F * t/S)^D */
export function retention(stability: number, elapsedDays: number): number {
  if (stability <= 0) return 0;
  if (elapsedDays <= 0) return 1;
  return round(clamp((1 + FACTOR * (elapsedDays / stability)) ** DECAY), 4);
}

/** Days until retention drops to the requested level. */
export function intervalForRetention(stability: number, desired = 0.9): number {
  const r = clamp(desired, 0.5, 0.99);
  return round((stability / FACTOR) * (r ** (1 / DECAY) - 1), 3);
}

const W = {
  initStability: [0.4, 1.2, 3.2, 15.7],   // again / hard / good / easy
  initDifficulty: 5.0,
  difficultyDelta: 1.1,
  difficultyMeanReversion: 0.08,
  stabilityGain: 1.35,
  stabilityPenalty: 0.24,
  hardPenalty: 0.82,
  easyBonus: 1.3,
};

export function initialState(rating: Rating, conceptDifficulty = 0.5): MemoryState {
  const idx = { again: 0, hard: 1, good: 2, easy: 3 }[rating];
  return {
    stability: round(Math.max(0.1, W.initStability[idx] * (1.3 - conceptDifficulty)), 3),
    difficulty: round(clamp(W.initDifficulty + (conceptDifficulty - 0.5) * 4 - (idx - 2) * W.difficultyDelta, 1, 10), 3),
    reps: 1,
    lapses: rating === 'again' ? 1 : 0,
    lastReviewMs: Date.now(),
  };
}

export function review(
  state: MemoryState,
  rating: Rating,
  opts: { nowMs?: number; desiredRetention?: number; conceptDifficulty?: number } = {},
): SchedulingDecision {
  const now = opts.nowMs ?? Date.now();
  const desired = opts.desiredRetention ?? 0.9;

  if (!state.lastReviewMs || state.reps === 0) {
    const fresh = initialState(rating, opts.conceptDifficulty ?? 0.5);
    const interval = Math.max(0.5, intervalForRetention(fresh.stability, desired));
    return {
      state: { ...fresh, lastReviewMs: now },
      intervalDays: round(interval, 2),
      dueAtMs: now + interval * DAY,
      retentionAtReview: 1,
      rating,
      explanation: `First encounter rated "${rating}": stability starts at ${fresh.stability} days.`,
    };
  }

  const elapsedDays = Math.max(0, (now - state.lastReviewMs) / DAY);
  const r = retention(state.stability, elapsedDays);

  // Difficulty drifts with performance and reverts toward the middle.
  const ratingIdx = { again: 0, hard: 1, good: 2, easy: 3 }[rating];
  let difficulty = state.difficulty - W.difficultyDelta * (ratingIdx - 2);
  difficulty += W.difficultyMeanReversion * (W.initDifficulty - difficulty);
  difficulty = clamp(difficulty, 1, 10);

  let stability: number;
  let lapses = state.lapses;
  if (rating === 'again') {
    // A lapse does not reset to zero: relearning is faster than learning.
    stability = round(Math.max(0.1, state.stability * W.stabilityPenalty * (1 + (1 - r))), 3);
    lapses += 1;
  } else {
    // Retrievability is the lever: a successful recall when you had almost
    // forgotten buys far more stability than an easy one.
    const difficultyFactor = (11 - difficulty) / 9;
    const retrievabilityBonus = 1 + (1 - r) * 1.8;
    const ratingFactor = rating === 'hard' ? W.hardPenalty : rating === 'easy' ? W.easyBonus : 1;
    const gain = 1 + W.stabilityGain * difficultyFactor * retrievabilityBonus * ratingFactor;
    stability = round(state.stability * gain, 3);
  }

  const interval = Math.max(0.5, intervalForRetention(stability, desired));
  return {
    state: {
      stability,
      difficulty: round(difficulty, 3),
      reps: state.reps + 1,
      lapses,
      lastReviewMs: now,
    },
    intervalDays: round(interval, 2),
    dueAtMs: now + interval * DAY,
    retentionAtReview: r,
    rating,
    explanation: rating === 'again'
      ? `Lapse after ${round(elapsedDays, 1)} days (retention had fallen to ${Math.round(r * 100)}%). Stability cut to ${stability} days.`
      : `Recalled at ${Math.round(r * 100)}% retention after ${round(elapsedDays, 1)} days. Stability grew ${round(stability / state.stability, 2)}x to ${stability} days; next review in ${round(interval, 1)} days.`,
  };
}

/** Map a graded response onto a review rating. */
export function ratingFrom(opts: { correct: boolean; latencyMs?: number; hintsUsed?: number; expectedMs?: number }): Rating {
  if (!opts.correct) return 'again';
  if ((opts.hintsUsed ?? 0) > 1) return 'hard';
  const expected = opts.expectedMs ?? 20_000;
  const latency = opts.latencyMs ?? expected;
  if ((opts.hintsUsed ?? 0) === 1) return 'hard';
  if (latency < expected * 0.45) return 'easy';
  if (latency > expected * 1.8) return 'hard';
  return 'good';
}

/** KNOWLEDGE RECOVERY MODE.
 *  Given the concepts a new lesson depends on, which have decayed enough that
 *  a short refresher should be inserted before teaching anything new? */
export interface RecoveryNeed {
  conceptId: string;
  retention: number;
  daysSince: number;
  urgency: number;
  refresherSeconds: number;
  reason: string;
}

export function recoveryNeeds(
  prerequisites: { conceptId: string; state: MemoryState; importance?: number }[],
  opts: { nowMs?: number; threshold?: number } = {},
): RecoveryNeed[] {
  const now = opts.nowMs ?? Date.now();
  const threshold = opts.threshold ?? 0.75;
  return prerequisites
    .map(({ conceptId, state, importance }) => {
      const daysSince = state.lastReviewMs ? (now - state.lastReviewMs) / DAY : Infinity;
      const r = state.lastReviewMs ? retention(state.stability, daysSince) : 0;
      const imp = importance ?? 1;
      return {
        conceptId,
        retention: round(r, 3),
        daysSince: round(Number.isFinite(daysSince) ? daysSince : -1, 1),
        urgency: round(clamp((threshold - r) / threshold) * imp, 3),
        // A 30-second refresher for a mild dip; longer the further it has fallen.
        refresherSeconds: Math.round(20 + (1 - r) * 100),
        reason: r < 0.4
          ? `Retention has fallen to ${Math.round(r * 100)}% - this needs a real re-teach, not a reminder.`
          : `Retention is ${Math.round(r * 100)}% after ${round(daysSince, 0)} days. A short refresher will restore it.`,
      };
    })
    .filter((n) => n.retention < threshold)
    .sort((a, b) => b.urgency - a.urgency);
}
