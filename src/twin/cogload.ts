import type { CognitiveLoadEstimate, FrictionSignal, ResponseRecord } from '../domain/types.js';
import { clamp, mean, median, round, stdev } from '../core/mathx.js';

/** Cognitive load and learning friction, inferred from interaction only.
 *
 *  NOT emotion detection and NOT a diagnosis. These are behavioural signals -
 *  retries, pauses, abandonment, hint dependence - that say "this explanation
 *  is not landing". The system responds to friction, it does not label the
 *  child. Every signal carries its own evidence string so a teacher can audit
 *  exactly why the system changed course. */

export interface LoadInputs {
  recent: ResponseRecord[];
  /** Intrinsic difficulty of what is being taught, 0..1. */
  contentDifficulty: number;
  /** New terms introduced in the current segment. */
  novelTerms?: number;
  /** Words on screen in the current segment. */
  segmentWords?: number;
  /** Seconds since the session started. */
  sessionSeconds?: number;
  /** Learner's typical response time, for personal comparison. */
  baselineLatencyMs?: number;
  /** Working-memory support need raises sensitivity to element interactivity. */
  workingMemorySupport?: boolean;
}

export function estimateLoad(input: LoadInputs): CognitiveLoadEstimate {
  const recent = input.recent.slice(0, 10);
  const contributors: Record<string, number> = {};

  // Intrinsic: the material itself.
  contributors.intrinsic = round(clamp(input.contentDifficulty) * 0.3, 3);

  // Extraneous: how the material is presented right now.
  const words = input.segmentWords ?? 0;
  contributors.presentation = round(clamp(words / 220) * 0.12, 3);
  contributors.novelty = round(clamp((input.novelTerms ?? 0) / 6) * 0.14, 3);

  // Performance evidence.
  const latencies = recent.map((r) => r.latencyMs).filter((l) => l > 0);
  const baseline = input.baselineLatencyMs ?? (latencies.length ? median(latencies) : 20_000);
  const latencyRatio = latencies.length ? mean(latencies) / Math.max(1000, baseline) : 1;
  contributors.hesitation = round(clamp((latencyRatio - 1) / 1.6) * 0.14, 3);

  const errorRate = recent.length ? recent.filter((r) => !r.correct).length / recent.length : 0;
  contributors.errors = round(clamp(errorRate / 0.65) * 0.18, 3);

  const hintRate = recent.length ? mean(recent.map((r) => Math.min(3, r.hintsUsed))) / 3 : 0;
  contributors.hintReliance = round(clamp(hintRate) * 0.1, 3);

  const retryRate = recent.length ? mean(recent.map((r) => Math.min(4, r.attempts - 1))) / 4 : 0;
  contributors.retries = round(clamp(retryRate) * 0.1, 3);

  // Fatigue: long sessions raise effective load even on easy content.
  const minutes = (input.sessionSeconds ?? 0) / 60;
  contributors.fatigue = round(clamp(Math.max(0, minutes - 12) / 25) * 0.12, 3);

  if (input.workingMemorySupport) {
    contributors.elementInteractivity = round(clamp((input.novelTerms ?? 0) / 3) * 0.1, 3);
  }

  const load = round(clamp(Object.values(contributors).reduce((a, b) => a + b, 0)), 3);

  // Confidence grows with evidence; a cold start is a guess and says so.
  const confidence = round(clamp(0.25 + Math.min(recent.length, 8) / 12), 3);

  let recommendation: CognitiveLoadEstimate['recommendation'] = 'continue';
  if (load > 0.85) recommendation = 'break';
  else if (errorRate >= 0.6 && recent.length >= 3) recommendation = 'repair_prereq';
  else if (load > 0.7 && contributors.presentation + contributors.novelty > 0.16) recommendation = 'simplify';
  else if (load > 0.65) recommendation = 'switch_modality';

  return { load, contributors, recommendation, confidence };
}

/** Behavioural friction patterns, each with the evidence that triggered it. */
export function detectFriction(
  recent: ResponseRecord[],
  opts: { baselineLatencyMs?: number; explanationSwitches?: number; abandonedCount?: number } = {},
): FrictionSignal[] {
  const out: FrictionSignal[] = [];
  if (!recent.length) return out;

  const latencies = recent.map((r) => r.latencyMs).filter((l) => l > 0);
  const baseline = opts.baselineLatencyMs ?? (latencies.length ? median(latencies) : 20_000);

  // Retry storm: the same item hammered repeatedly.
  const heavyRetries = recent.filter((r) => r.attempts >= 3);
  if (heavyRetries.length >= 2) {
    out.push({
      kind: 'retry_storm',
      strength: round(clamp(heavyRetries.length / 4), 3),
      evidence: `${heavyRetries.length} items attempted 3+ times (max ${Math.max(...heavyRetries.map((r) => r.attempts))} attempts).`,
    });
  }

  // Error streak: consecutive wrong answers.
  let streak = 0;
  let maxStreak = 0;
  for (const r of [...recent].reverse()) {
    if (!r.correct) { streak++; maxStreak = Math.max(maxStreak, streak); } else streak = 0;
  }
  if (maxStreak >= 3) {
    out.push({
      kind: 'error_streak',
      strength: round(clamp(maxStreak / 5), 3),
      evidence: `${maxStreak} wrong answers in a row - the current approach is not working.`,
    });
  }

  // Long pause: a response far slower than this learner's own baseline.
  const slow = latencies.filter((l) => l > baseline * 3 && l > 25_000);
  if (slow.length) {
    out.push({
      kind: 'long_pause',
      strength: round(clamp(slow.length / 3), 3),
      evidence: `${slow.length} response(s) took over 3x this learner's typical ${Math.round(baseline / 1000)}s.`,
    });
  }

  // Hint dependence: correct, but only with help.
  const hinted = recent.filter((r) => r.correct && r.hintsUsed >= 2);
  if (hinted.length >= 2) {
    out.push({
      kind: 'hint_dependence',
      strength: round(clamp(hinted.length / recent.length / 0.5), 3),
      evidence: `${hinted.length} of ${recent.length} correct answers needed 2+ hints - mastery is not independent yet.`,
    });
  }

  // Explanation churn: asking for the idea again and again.
  if ((opts.explanationSwitches ?? 0) >= 3) {
    out.push({
      kind: 'explanation_churn',
      strength: round(clamp((opts.explanationSwitches ?? 0) / 5), 3),
      evidence: `${opts.explanationSwitches} explanation re-requests for the same concept.`,
    });
  }

  // Abandonment.
  if ((opts.abandonedCount ?? 0) >= 1) {
    out.push({
      kind: 'abandon',
      strength: round(clamp((opts.abandonedCount ?? 0) / 2), 3),
      evidence: `${opts.abandonedCount} item(s) left without an answer.`,
    });
  }

  // Speed running: answering faster than reading would allow.
  const tooFast = recent.filter((r) => r.latencyMs > 0 && r.latencyMs < 2500 && !r.correct);
  if (tooFast.length >= 3) {
    out.push({
      kind: 'speed_run',
      strength: round(clamp(tooFast.length / 5), 3),
      evidence: `${tooFast.length} wrong answers in under 2.5s each - clicking, not reading.`,
    });
  }

  return out.sort((a, b) => b.strength - a.strength);
}

export interface FrictionVerdict {
  score: number;
  signals: FrictionSignal[];
  intervene: boolean;
  action: 'none' | 'offer_break' | 'switch_modality' | 'simplify' | 'repair_prereq' | 'slow_down' | 'encourage_care';
  message: string;
}

/** Turn signals into one decision, with the words to say to the learner. */
export function frictionVerdict(signalsIn: FrictionSignal[], load: CognitiveLoadEstimate): FrictionVerdict {
  // Load alone can justify an intervention. Name it as a signal so the verdict
  // is never "intervene, reason unknown".
  const signals = [...signalsIn];
  if (!signals.length && load.recommendation !== 'continue') {
    const top = Object.entries(load.contributors).sort((a, b) => b[1] - a[1])[0];
    signals.push({
      kind: load.recommendation === 'repair_prereq' ? 'error_streak' : 'explanation_churn',
      strength: round(clamp(load.load), 3),
      evidence: `cognitive load ${load.load} (largest contributor: ${top?.[0] ?? 'unknown'} at ${top?.[1] ?? 0})`,
    });
  }

  const score = round(clamp(
    signals.reduce((a, s) => a + s.strength, 0) / Math.max(2, signals.length + 1) + load.load * 0.3,
  ), 3);

  const has = (k: FrictionSignal['kind']) => signals.find((s) => s.kind === k);
  let action: FrictionVerdict['action'] = 'none';
  let message = 'Pace looks good - keep going.';

  if (has('speed_run')) {
    action = 'encourage_care';
    message = 'Those went by fast. Let us slow down and read each one together.';
  } else if (has('error_streak') || load.recommendation === 'repair_prereq') {
    action = 'repair_prereq';
    message = 'This is not a you problem - something earlier is missing. Let us go back and fix that first.';
  } else if (has('explanation_churn') || load.recommendation === 'switch_modality') {
    action = 'switch_modality';
    message = 'This explanation is not landing. Let us try it a completely different way.';
  } else if (has('retry_storm')) {
    action = 'simplify';
    message = 'Let us break this into smaller steps.';
  } else if (score > 0.75 || load.load > 0.85) {
    action = 'offer_break';
    message = 'You have been working hard. Take two minutes - the progress is saved.';
  } else if (has('long_pause') || has('hint_dependence')) {
    action = 'slow_down';
    message = 'No rush at all. Want to see one worked through first?';
  }

  return { score, signals, intervene: action !== 'none', action, message };
}

/** Rolling latency baseline per learner, robust to outliers. */
export function latencyBaseline(responses: ResponseRecord[]): { median: number; stdev: number; n: number } {
  const l = responses.map((r) => r.latencyMs).filter((x) => x > 500 && x < 600_000);
  return { median: Math.round(median(l)), stdev: Math.round(stdev(l)), n: l.length };
}
