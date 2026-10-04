import { clamp, round } from '../core/mathx.js';

/** Bayesian Knowledge Tracing.
 *
 *  Four parameters per concept:
 *    pInit  - prior probability the learner already knows it
 *    pLearn - probability of learning it from one opportunity
 *    pSlip  - probability of answering wrong while knowing it
 *    pGuess - probability of answering right without knowing it
 *
 *  The posterior update is exact Bayes; the transition then adds the chance of
 *  having learned during the attempt. */
export interface BktParams { pInit: number; pLearn: number; pSlip: number; pGuess: number; }

export const DEFAULT_BKT: BktParams = { pInit: 0.15, pLearn: 0.18, pSlip: 0.1, pGuess: 0.22 };

/** Parameters shift with item format and support used: a guessed MCQ carries
 *  less evidence than a constructed response. */
export function paramsFor(opts: {
  base?: Partial<BktParams>;
  choices?: number;
  hintsUsed?: number;
  difficulty?: number;      // IRT-style b, roughly -3..3
  conceptDifficulty?: number;
}): BktParams {
  const b = { ...DEFAULT_BKT, ...(opts.base ?? {}) };
  const guessFloor = opts.choices && opts.choices > 1 ? 1 / opts.choices : 0.08;
  const hintPenalty = clamp((opts.hintsUsed ?? 0) * 0.12, 0, 0.35);
  const hard = clamp((opts.conceptDifficulty ?? 0.5), 0, 1);
  return {
    pInit: clamp(b.pInit * (1.2 - hard), 0.02, 0.6),
    // Harder concepts are learned more slowly per opportunity.
    pLearn: clamp(b.pLearn * (1.25 - hard * 0.6), 0.03, 0.5),
    // A hinted correct answer is weaker evidence of knowing.
    pSlip: clamp(b.pSlip + hard * 0.08, 0.02, 0.4),
    pGuess: clamp(Math.max(b.pGuess, guessFloor) + hintPenalty, 0.02, 0.6),
  };
}

export interface BktStep {
  before: number;
  posterior: number;    // P(knew it | this observation)
  after: number;        // P(knows it now), including learning during the attempt
  evidence: number;     // how much this observation moved the belief
  params: BktParams;
}

export function bktUpdate(pKnownBefore: number, correct: boolean, params: BktParams = DEFAULT_BKT): BktStep {
  const p = clamp(pKnownBefore, 0.001, 0.999);
  const { pLearn, pSlip, pGuess } = params;

  const pCorrectIfKnown = 1 - pSlip;
  const pCorrectIfNot = pGuess;

  const likelihood = correct
    ? p * pCorrectIfKnown + (1 - p) * pCorrectIfNot
    : p * pSlip + (1 - p) * (1 - pGuess);

  const posterior = likelihood <= 0
    ? p
    : correct
      ? (p * pCorrectIfKnown) / likelihood
      : (p * pSlip) / likelihood;

  const after = clamp(posterior + (1 - posterior) * pLearn, 0.001, 0.999);
  return {
    before: round(p, 4),
    posterior: round(clamp(posterior), 4),
    after: round(after, 4),
    evidence: round(after - p, 4),
    params,
  };
}

/** Predicted probability of a correct answer, given current belief. */
export function bktPredict(pKnown: number, params: BktParams = DEFAULT_BKT): number {
  return round(clamp(pKnown) * (1 - params.pSlip) + (1 - clamp(pKnown)) * params.pGuess, 4);
}

/** Replay a response history from the prior - used for audit and "what if" views. */
export function bktReplay(
  history: { correct: boolean; params?: BktParams }[],
  params: BktParams = DEFAULT_BKT,
): { trajectory: number[]; final: number; steps: BktStep[] } {
  let p = params.pInit;
  const trajectory = [round(p, 4)];
  const steps: BktStep[] = [];
  for (const h of history) {
    const step = bktUpdate(p, h.correct, h.params ?? params);
    steps.push(step);
    p = step.after;
    trajectory.push(step.after);
  }
  return { trajectory, final: round(p, 4), steps };
}

/** How many more correct answers until mastery, at the current learning rate. */
export function opportunitiesToMastery(
  pKnown: number,
  target: number,
  params: BktParams = DEFAULT_BKT,
  cap = 30,
): number {
  let p = clamp(pKnown);
  for (let i = 1; i <= cap; i++) {
    p = bktUpdate(p, true, params).after;
    if (p >= target) return i;
  }
  return cap;
}

/** Fit pSlip/pGuess/pLearn to observed responses by coarse grid search.
 *  Small data, so a grid beats EM here and never diverges. */
export function fitBkt(
  observations: boolean[],
  grid = { slip: [0.05, 0.1, 0.2, 0.3], guess: [0.1, 0.2, 0.3, 0.4], learn: [0.05, 0.1, 0.2, 0.35] },
): { params: BktParams; logLikelihood: number } {
  let best: BktParams = DEFAULT_BKT;
  let bestLl = -Infinity;
  for (const pSlip of grid.slip) {
    for (const pGuess of grid.guess) {
      for (const pLearn of grid.learn) {
        const params: BktParams = { pInit: DEFAULT_BKT.pInit, pLearn, pSlip, pGuess };
        let p = params.pInit;
        let ll = 0;
        for (const correct of observations) {
          const pc = p * (1 - pSlip) + (1 - p) * pGuess;
          ll += Math.log(Math.max(1e-9, correct ? pc : 1 - pc));
          p = bktUpdate(p, correct, params).after;
        }
        if (ll > bestLl) { bestLl = ll; best = params; }
      }
    }
  }
  return { params: best, logLikelihood: round(bestLl, 4) };
}
