import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bktUpdate, bktPredict, bktReplay, fitBkt, opportunitiesToMastery, paramsFor } from '../twin/bkt.js';
import { eloUpdate, expectedScore, eloToTheta, thetaToElo } from '../twin/elo.js';
import { initialState, intervalForRetention, ratingFrom, recoveryNeeds, retention, review } from '../twin/fsrs.js';
import { computeReward, hasClearWinner, selectModality, updateArm, type Arm } from '../twin/bandit.js';
import { detectFriction, estimateLoad, frictionVerdict } from '../twin/cogload.js';
import { featuresOf, minePatterns } from '../twin/errorpatterns.js';
import { DAY } from '../core/clock.js';
import type { ItemRecord, ResponseRecord } from '../domain/types.js';

const resp = (over: Partial<ResponseRecord> = {}): ResponseRecord => ({
  id: 'r', learnerId: 'l', itemId: 'i', conceptId: 'c', sessionId: null, raw: 'x',
  correct: true, score: 1, latencyMs: 20_000, hintsUsed: 0, attempts: 1,
  misconceptionId: null, modality: 'text', feedback: {}, at: new Date().toISOString(), ...over,
});

describe('bayesian knowledge tracing', () => {
  test('a correct answer raises belief and a wrong answer lowers the posterior', () => {
    const up = bktUpdate(0.4, true);
    const down = bktUpdate(0.4, false);
    assert.ok(up.after > 0.4, `expected rise, got ${up.after}`);
    assert.ok(down.posterior < 0.4, `expected posterior drop, got ${down.posterior}`);
  });

  test('belief stays inside (0,1) under extreme streaks', () => {
    let p = 0.5;
    for (let i = 0; i < 200; i++) p = bktUpdate(p, true).after;
    assert.ok(p > 0.95 && p < 1, `converged outside range: ${p}`);
    let q = 0.5;
    for (let i = 0; i < 200; i++) q = bktUpdate(q, false).after;
    assert.ok(q > 0 && q < 0.3, `converged outside range: ${q}`);
  });

  test('learning floor means a wrong-answer streak never reaches zero', () => {
    let p = 0.9;
    for (let i = 0; i < 50; i++) p = bktUpdate(p, false).after;
    assert.ok(p > 0.001);
  });

  test('a hinted correct answer moves belief less than an unhinted one', () => {
    const plain = bktUpdate(0.4, true, paramsFor({ choices: 4, hintsUsed: 0 }));
    const hinted = bktUpdate(0.4, true, paramsFor({ choices: 4, hintsUsed: 2 }));
    assert.ok(hinted.evidence < plain.evidence,
      `hinted ${hinted.evidence} should be below unhinted ${plain.evidence}`);
  });

  test('more answer choices lowers the evidential value of being right', () => {
    const two = bktUpdate(0.3, true, paramsFor({ choices: 2 }));
    const eight = bktUpdate(0.3, true, paramsFor({ choices: 8 }));
    assert.ok(eight.evidence > two.evidence);
  });

  test('prediction sits between guess rate and 1 - slip', () => {
    const params = paramsFor({ choices: 4 });
    assert.ok(bktPredict(0, params) >= params.pGuess - 1e-9);
    assert.ok(bktPredict(1, params) <= 1 - params.pSlip + 1e-9);
  });

  test('replay is deterministic and monotone for an all-correct history', () => {
    const r = bktReplay(Array.from({ length: 6 }, () => ({ correct: true })));
    for (let i = 1; i < r.trajectory.length; i++) {
      assert.ok(r.trajectory[i] >= r.trajectory[i - 1]);
    }
    assert.equal(r.trajectory.length, 7);
  });

  test('parameter fitting prefers a low slip rate for a consistently correct learner', () => {
    const fit = fitBkt(Array.from({ length: 12 }, () => true));
    assert.ok(fit.params.pSlip <= 0.1, `slip too high: ${fit.params.pSlip}`);
    assert.ok(Number.isFinite(fit.logLikelihood));
  });

  test('opportunities-to-mastery shrinks as belief rises', () => {
    assert.ok(opportunitiesToMastery(0.2, 0.8) > opportunitiesToMastery(0.6, 0.8));
    assert.equal(opportunitiesToMastery(0.95, 0.8), 1);
  });
});

describe('elo', () => {
  test('an even match predicts 0.5', () => {
    assert.equal(expectedScore(1200, 1200), 0.5);
  });

  test('beating a harder item gains more than beating an easier one', () => {
    const hard = eloUpdate(1200, 1600, true);
    const easy = eloUpdate(1200, 800, true);
    assert.ok(hard.learnerAfter - 1200 > easy.learnerAfter - 1200);
  });

  test('item rating moves opposite to the learner', () => {
    const r = eloUpdate(1200, 1200, true);
    assert.ok(r.learnerAfter > 1200);
    assert.ok(r.itemAfter < 1200);
  });

  test('K shrinks with experience, so veterans move slowly', () => {
    const rookie = eloUpdate(1200, 1200, true, { learnerPlays: 0 });
    const veteran = eloUpdate(1200, 1200, true, { learnerPlays: 200 });
    assert.ok(rookie.learnerAfter - 1200 > veteran.learnerAfter - 1200);
  });

  test('elo and theta round-trip', () => {
    for (const theta of [-2, -0.5, 0, 1.3, 2.5]) {
      assert.ok(Math.abs(eloToTheta(thetaToElo(theta)) - theta) < 1e-3);
    }
  });
});

describe('spaced repetition', () => {
  test('retention decays monotonically with elapsed time', () => {
    const s = 10;
    const points = [0, 1, 5, 10, 30, 100].map((d) => retention(s, d));
    for (let i = 1; i < points.length; i++) {
      assert.ok(points[i] <= points[i - 1], `retention rose at day ${i}`);
    }
    assert.ok(points[0] === 1);
  });

  test('interval for 90% retention is shorter than for 70%', () => {
    assert.ok(intervalForRetention(10, 0.9) < intervalForRetention(10, 0.7));
  });

  test('higher stability means a longer interval', () => {
    assert.ok(intervalForRetention(40, 0.9) > intervalForRetention(10, 0.9));
  });

  test('spaced success grows stability; a lapse shrinks it', () => {
    const now = Date.UTC(2026, 0, 1);
    let state = initialState('good', 0.5);
    state.lastReviewMs = now;
    const first = review(state, 'good', { nowMs: now + 3 * DAY });
    assert.ok(first.state.stability > state.stability,
      `expected growth, ${state.stability} -> ${first.state.stability}`);

    const lapsed = review(first.state, 'again', { nowMs: now + 20 * DAY });
    assert.ok(lapsed.state.stability < first.state.stability);
    assert.equal(lapsed.state.lapses, first.state.lapses + 1);
  });

  test('recalling at low retention buys more stability than recalling immediately', () => {
    const now = Date.UTC(2026, 0, 1);
    const base = { ...initialState('good', 0.5), stability: 10, lastReviewMs: now };
    const massed = review(base, 'good', { nowMs: now + 0.1 * DAY });
    const spaced = review(base, 'good', { nowMs: now + 9 * DAY });
    assert.ok(spaced.state.stability > massed.state.stability,
      `spaced ${spaced.state.stability} should beat massed ${massed.state.stability}`);
  });

  test('intervals lengthen across repeated spaced successes', () => {
    let now = Date.UTC(2026, 0, 1);
    let state = { ...initialState('good', 0.4), lastReviewMs: now };
    const intervals: number[] = [];
    for (let i = 0; i < 5; i++) {
      const d = review(state, 'good', { nowMs: now });
      intervals.push(d.intervalDays);
      state = d.state;
      now = d.dueAtMs;
    }
    assert.ok(intervals[4] > intervals[0] * 3,
      `intervals should expand: ${intervals.join(', ')}`);
  });

  test('ratings map from performance', () => {
    assert.equal(ratingFrom({ correct: false }), 'again');
    assert.equal(ratingFrom({ correct: true, hintsUsed: 2 }), 'hard');
    assert.equal(ratingFrom({ correct: true, latencyMs: 2_000, expectedMs: 20_000 }), 'easy');
    assert.equal(ratingFrom({ correct: true, latencyMs: 20_000, expectedMs: 20_000 }), 'good');
  });

  test('knowledge recovery flags only the prerequisites that actually decayed', () => {
    const now = Date.UTC(2026, 5, 1);
    const needs = recoveryNeeds([
      { conceptId: 'fresh', state: { stability: 30, difficulty: 5, reps: 3, lapses: 0, lastReviewMs: now - 1 * DAY } },
      { conceptId: 'stale', state: { stability: 3, difficulty: 7, reps: 2, lapses: 1, lastReviewMs: now - 90 * DAY } },
    ], { nowMs: now });
    assert.equal(needs.length, 1);
    assert.equal(needs[0].conceptId, 'stale');
    assert.ok(needs[0].refresherSeconds > 20);
    assert.match(needs[0].reason, /re-teach|refresher/);
  });
});

describe('modality bandit', () => {
  const arms = (): Arm[] => [
    { modality: 'text', alpha: 1, beta: 1, trials: 0, rewardSum: 0 },
    { modality: 'animation', alpha: 1, beta: 1, trials: 0, rewardSum: 0 },
    { modality: 'audio', alpha: 1, beta: 1, trials: 0, rewardSum: 0 },
  ];

  test('cold start explores, led by the accessibility prior', () => {
    const s = selectModality(arms(), { contextWeights: { audio: 0.5 }, seed: 'x' });
    assert.equal(s.strategy, 'forced_exploration');
    assert.equal(s.chosen, 'audio');
  });

  test('a blocked modality is never chosen', () => {
    for (let i = 0; i < 40; i++) {
      const s = selectModality(arms(), { blocked: ['audio', 'animation'], seed: `s${i}` });
      assert.notEqual(s.chosen, 'audio');
      assert.notEqual(s.chosen, 'animation');
    }
  });

  test('a boost cannot override a block', () => {
    const s = selectModality(arms(), { blocked: ['audio'], contextWeights: { audio: 5 }, seed: 'q' });
    assert.notEqual(s.chosen, 'audio');
  });

  test('thompson sampling converges on the arm that actually works', () => {
    let pool = arms();
    // animation rewards 0.9, the others 0.15
    for (let i = 0; i < 60; i++) {
      const s = selectModality(pool, { seed: `t${i}` });
      const reward = s.chosen === 'animation' ? 0.9 : 0.15;
      pool = pool.map((a) => (a.modality === s.chosen ? updateArm(a, reward) : a));
    }
    const best = [...pool].sort((a, b) => b.alpha / (b.alpha + b.beta) - a.alpha / (a.alpha + a.beta))[0];
    assert.equal(best.modality, 'animation');
    const animation = pool.find((a) => a.modality === 'animation')!;
    assert.ok(animation.trials > 20, `expected exploitation, only ${animation.trials} trials`);
  });

  test('a clear winner is only declared once the posteriors separate', () => {
    const weak: Arm[] = [
      { modality: 'text', alpha: 3, beta: 2, trials: 3, rewardSum: 2 },
      { modality: 'audio', alpha: 2, beta: 3, trials: 3, rewardSum: 1 },
    ];
    assert.equal(hasClearWinner(weak), null);

    const strong: Arm[] = [
      { modality: 'animation', alpha: 38, beta: 4, trials: 40, rewardSum: 36 },
      { modality: 'text', alpha: 6, beta: 36, trials: 40, rewardSum: 5 },
    ];
    const w = hasClearWinner(strong);
    assert.ok(w);
    assert.equal(w!.winner, 'animation');
  });

  test('reward rewards learning, not just correctness', () => {
    const guessedRight = computeReward({ correct: true, masteryGain: 0.01, hintsUsed: 3, retries: 4 });
    const earnedRight = computeReward({ correct: true, masteryGain: 0.3, hintsUsed: 0, retries: 1 });
    assert.ok(earnedRight.reward > guessedRight.reward,
      `earned ${earnedRight.reward} should beat guessed ${guessedRight.reward}`);
  });

  test('abandonment is penalised even when the answer was right', () => {
    const r = computeReward({ correct: true, abandoned: true });
    assert.ok(r.reward < 0.8);
    assert.equal(r.breakdown.completion, 0);
  });

  test('rewards stay within bounds for every input combination', () => {
    for (const correct of [true, false]) {
      for (const hints of [0, 5]) {
        for (const latency of [100, 1e6]) {
          const r = computeReward({ correct, hintsUsed: hints, latencyMs: latency });
          assert.ok(r.reward >= 0 && r.reward <= 1, `out of range: ${r.reward}`);
        }
      }
    }
  });
});

describe('cognitive load and friction', () => {
  test('load rises with errors, novelty and session length', () => {
    const calm = estimateLoad({ recent: [resp(), resp(), resp()], contentDifficulty: 0.2 });
    const rough = estimateLoad({
      recent: [resp({ correct: false, attempts: 3 }), resp({ correct: false }), resp({ correct: false })],
      contentDifficulty: 0.9, novelTerms: 8, segmentWords: 400, sessionSeconds: 2400,
    });
    assert.ok(rough.load > calm.load);
    assert.ok(rough.load <= 1 && calm.load >= 0);
    assert.notEqual(rough.recommendation, 'continue');
  });

  test('confidence reflects how much evidence there is', () => {
    const thin = estimateLoad({ recent: [], contentDifficulty: 0.5 });
    const thick = estimateLoad({ recent: Array.from({ length: 10 }, () => resp()), contentDifficulty: 0.5 });
    assert.ok(thick.confidence > thin.confidence);
  });

  test('an error streak is detected and routed to prerequisite repair', () => {
    const signals = detectFriction([resp({ correct: false }), resp({ correct: false }), resp({ correct: false })]);
    assert.ok(signals.some((s) => s.kind === 'error_streak'));
    const v = frictionVerdict(signals, estimateLoad({ recent: [], contentDifficulty: 0.5 }));
    assert.equal(v.action, 'repair_prereq');
    assert.ok(v.message.length > 10);
  });

  test('fast wrong answers read as clicking, not struggling', () => {
    const signals = detectFriction(Array.from({ length: 4 }, () => resp({ correct: false, latencyMs: 900 })));
    assert.ok(signals.some((s) => s.kind === 'speed_run'));
    const v = frictionVerdict(signals, estimateLoad({ recent: [], contentDifficulty: 0.3 }));
    assert.equal(v.action, 'encourage_care');
  });

  test('hint dependence is caught even when every answer is correct', () => {
    const signals = detectFriction(Array.from({ length: 4 }, () => resp({ correct: true, hintsUsed: 2 })));
    assert.ok(signals.some((s) => s.kind === 'hint_dependence'));
  });

  test('every intervention names a reason', () => {
    const load = estimateLoad({
      recent: [resp({ correct: false }), resp({ correct: false }), resp({ correct: false })],
      contentDifficulty: 0.8,
    });
    const v = frictionVerdict([], load);
    if (v.intervene) {
      assert.ok(v.signals.length > 0, 'intervened with no named signal');
      assert.ok(v.signals[0].evidence.length > 0);
    }
  });

  test('a calm learner is left alone', () => {
    const signals = detectFriction([resp(), resp(), resp()]);
    const v = frictionVerdict(signals, estimateLoad({ recent: [resp(), resp()], contentDifficulty: 0.2 }));
    assert.equal(v.intervene, false);
    assert.equal(v.action, 'none');
  });
});

describe('error pattern mining', () => {
  const item = (over: Partial<ItemRecord>): ItemRecord => ({
    id: 'i1', conceptId: 'c1', kind: 'mcq', stem: 'What is 2 + 2?', choices: [], answer: { value: 4 },
    rubric: {}, difficulty: 0, discrimination: 1, guessing: 0.25, misconceptionMap: {}, bloom: 'apply',
    exposures: 0, pCorrect: null, accessibility: {}, meta: {}, createdAt: '', ...over,
  });

  test('question features are detected from the stem', () => {
    const keys = featuresOf(item({
      stem: 'Maya has 3/4 of a pizza and buys 2 more, then shares them between 5 friends. How much does each friend get in grams?',
    })).map((f) => f.key);
    assert.ok(keys.includes('fraction_notation'));
    assert.ok(keys.includes('word_problem'));
    assert.ok(keys.includes('units_required'));
  });

  test('a shape-specific weakness is separated from overall accuracy', () => {
    const wordy = item({ id: 'w', stem: 'Sam has 4 apples and buys 3 more, then gives 2 away. How many apples does Sam have now?' });
    const plain = item({ id: 'p', stem: 'What is 5 + 5?' });
    const responses: ResponseRecord[] = [
      ...Array.from({ length: 5 }, () => resp({ itemId: 'w', correct: false })),
      ...Array.from({ length: 5 }, () => resp({ itemId: 'p', correct: true })),
    ];
    const mined = minePatterns(responses, (idv) => (idv === 'w' ? wordy : plain));
    const wp = mined.patterns.find((p) => p.key === 'word_problem');
    assert.ok(wp, 'word_problem pattern not found');
    assert.equal(wp!.errorRate, 1);
    assert.ok(wp!.lift > 0.4, `lift too small: ${wp!.lift}`);
    assert.equal(wp!.verdict, 'confirmed');
    assert.equal(mined.baselineErrorRate, 0.5);
  });

  test('a small sample is reported as insufficient rather than confirmed', () => {
    const it = item({ id: 'x', stem: 'Solve for x: 2x + 1 = 9' });
    const mined = minePatterns([resp({ itemId: 'x', correct: false })], () => it);
    assert.ok(mined.patterns.every((p) => p.verdict === 'insufficient_data'));
  });
});
