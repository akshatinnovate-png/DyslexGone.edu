import { clamp, logistic, round } from '../core/mathx.js';

/** Elo rating for learner ability vs item difficulty.
 *
 *  BKT answers "does this learner know concept X". Elo answers "how hard an
 *  item can this learner handle", and it self-calibrates the item bank at the
 *  same time, which BKT cannot do. Running both and cross-checking catches
 *  mis-tagged items. */
export interface EloResult {
  learnerAfter: number;
  itemAfter: number;
  expected: number;
  surprise: number;
  learnerK: number;
  itemK: number;
}

const SCALE = 400;

export function expectedScore(learnerRating: number, itemRating: number): number {
  return round(logistic(((learnerRating - itemRating) * Math.LN10) / SCALE), 4);
}

/** Uncertainty-scaled K: new players and new items move fast, veterans slowly. */
export function adaptiveK(plays: number, base = 40, floor = 8): number {
  return round(Math.max(floor, base / (1 + plays / 12)), 2);
}

export function eloUpdate(
  learnerRating: number,
  itemRating: number,
  correct: boolean,
  opts: { learnerPlays?: number; itemPlays?: number; weight?: number } = {},
): EloResult {
  const expected = expectedScore(learnerRating, itemRating);
  const actual = correct ? 1 : 0;
  const weight = clamp(opts.weight ?? 1, 0.1, 2);
  const learnerK = adaptiveK(opts.learnerPlays ?? 0) * weight;
  const itemK = adaptiveK(opts.itemPlays ?? 0, 24, 4) * weight;
  const delta = actual - expected;
  return {
    learnerAfter: round(learnerRating + learnerK * delta, 2),
    itemAfter: round(itemRating - itemK * delta, 2),
    expected,
    surprise: round(Math.abs(delta), 4),
    learnerK,
    itemK,
  };
}

/** Elo rating <-> IRT theta, so both engines can talk about the same learner. */
export const eloToTheta = (rating: number, mean = 1200): number => round(((rating - mean) * Math.LN10) / SCALE, 4);
export const thetaToElo = (theta: number, mean = 1200): number => round(mean + (theta * SCALE) / Math.LN10, 2);
