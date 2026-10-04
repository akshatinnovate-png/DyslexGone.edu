import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  abilityBand, calibrateItem, estimateAbility, estimateAbilityEap, information,
  probability, selectNextItem, shouldStop, type IrtItem, type IrtResponse,
} from '../assessment/irt.js';

const item = (over: Partial<IrtItem> = {}): IrtItem => ({ id: 'i', a: 1.2, b: 0, c: 0, ...over });

describe('item response theory', () => {
  test('probability is 0.5 at the difficulty point when there is no guessing', () => {
    assert.ok(Math.abs(probability(0, item({ b: 0, c: 0 })) - 0.5) < 1e-6);
    assert.ok(Math.abs(probability(1.5, item({ b: 1.5, c: 0 })) - 0.5) < 1e-6);
  });

  test('guessing raises the floor by exactly c', () => {
    const p = probability(-6, item({ b: 0, c: 0.25 }));
    assert.ok(Math.abs(p - 0.25) < 0.01, `floor should be ~0.25, got ${p}`);
  });

  test('probability rises monotonically with ability', () => {
    let prev = -1;
    for (let theta = -3; theta <= 3; theta += 0.25) {
      const p = probability(theta, item({ b: 0.5, a: 1.4, c: 0.2 }));
      assert.ok(p > prev, `probability fell at theta=${theta}`);
      prev = p;
    }
  });

  test('information peaks near the item difficulty', () => {
    const it = item({ b: 1, a: 1.5, c: 0 });
    const peak = [-2, -1, 0, 0.5, 1, 1.5, 2, 3]
      .map((t) => ({ t, i: information(t, it) }))
      .sort((a, b) => b.i - a.i)[0];
    assert.ok(Math.abs(peak.t - 1) <= 0.5, `information peaked at ${peak.t}, expected near 1`);
  });

  test('a more discriminating item carries more information at its peak', () => {
    const sharp = information(0, item({ a: 2.2 }));
    const blunt = information(0, item({ a: 0.6 }));
    assert.ok(sharp > blunt);
  });

  test('ability estimate rises with more correct answers', () => {
    const bank: IrtItem[] = [-1, -0.5, 0, 0.5, 1].map((b, i) => ({ id: `i${i}`, a: 1.3, b, c: 0 }));
    const allRight = estimateAbility(bank.map((it) => ({ item: it, correct: true })));
    const allWrong = estimateAbility(bank.map((it) => ({ item: it, correct: false })));
    const mixed = estimateAbility(bank.map((it, i) => ({ item: it, correct: i < 3 })));
    assert.ok(allRight.theta > mixed.theta, `${allRight.theta} should beat ${mixed.theta}`);
    assert.ok(mixed.theta > allWrong.theta);
  });

  test('a perfect run is bounded by the prior rather than running to infinity', () => {
    const bank: IrtItem[] = Array.from({ length: 20 }, (_, i) => ({ id: `i${i}`, a: 1.2, b: 0, c: 0 }));
    const r = estimateAbility(bank.map((it) => ({ item: it, correct: true })));
    assert.ok(Number.isFinite(r.theta));
    assert.ok(r.theta <= 4, `unbounded estimate: ${r.theta}`);
  });

  test('standard error shrinks as evidence accumulates', () => {
    const it = item({ b: 0, a: 1.5 });
    const few = estimateAbility([{ item: it, correct: true }, { item: it, correct: false }]);
    const many = estimateAbility(Array.from({ length: 24 }, (_, i) => ({ item: it, correct: i % 2 === 0 })));
    assert.ok(many.se < few.se, `se should shrink: ${few.se} -> ${many.se}`);
  });

  test('recovers a known ability from simulated responses', () => {
    const trueTheta = 0.8;
    const bank: IrtItem[] = Array.from({ length: 40 }, (_, i) => ({
      id: `i${i}`, a: 1.4, b: -2 + (i * 4) / 39, c: 0,
    }));
    // Deterministic responses: correct when P > 0.5 at the true ability.
    const responses: IrtResponse[] = bank.map((it) => ({ item: it, correct: probability(trueTheta, it) > 0.5 }));
    const est = estimateAbility(responses);
    assert.ok(Math.abs(est.theta - trueTheta) < 0.45,
      `estimated ${est.theta}, true ${trueTheta}`);
  });

  test('EAP agrees with MLE on reasonable data and always returns a posterior', () => {
    const bank: IrtItem[] = [-1, 0, 1].map((b, i) => ({ id: `i${i}`, a: 1.3, b, c: 0 }));
    const responses = bank.map((it, i) => ({ item: it, correct: i < 2 }));
    const mle = estimateAbility(responses);
    const eap = estimateAbilityEap(responses);
    assert.ok(Math.abs(mle.theta - eap.theta) < 0.6, `${mle.theta} vs ${eap.theta}`);
    assert.ok(eap.posterior.length > 10);
    const mass = eap.posterior.reduce((a, g) => a + g.density, 0) * (8 / 60);
    assert.ok(Math.abs(mass - 1) < 0.05, `posterior should integrate to 1, got ${mass}`);
  });

  test('item selection targets the most informative item', () => {
    const bank: IrtItem[] = [-2, -1, 0, 1, 2].map((b, i) => ({ id: `i${i}`, a: 1.5, b, c: 0 }));
    const pick = selectNextItem(1.0, bank, { randomesque: 1 });
    assert.ok(pick);
    assert.equal(pick!.item.b, 1);
    assert.match(pick!.reason, /information/);
  });

  test('exposure control stops the bank being burned through', () => {
    const bank: IrtItem[] = [0, 0.05].map((b, i) => ({ id: `i${i}`, a: 1.5, b, c: 0 }));
    const exposure = new Map([['i0', 200]]);
    const pick = selectNextItem(0, bank, { exposure, randomesque: 1 });
    assert.equal(pick!.item.id, 'i1', 'should avoid the heavily-used item');
  });

  test('already-seen items are excluded', () => {
    const bank: IrtItem[] = [0, 1].map((b, i) => ({ id: `i${i}`, a: 1.5, b, c: 0 }));
    const pick = selectNextItem(0, bank, { exclude: new Set(['i0']), randomesque: 1 });
    assert.equal(pick!.item.id, 'i1');
    assert.equal(selectNextItem(0, bank, { exclude: new Set(['i0', 'i1']) }), null);
  });

  test('stopping rules respect the floor, the target and the ceiling', () => {
    assert.equal(shouldStop({ responses: 2, se: 0.1 }, { minItems: 4 }).stop, false);
    assert.equal(shouldStop({ responses: 6, se: 0.2 }, { targetSe: 0.3 }).stop, true);
    assert.equal(shouldStop({ responses: 20, se: 0.9 }, { maxItems: 20 }).stop, true);
    const cont = shouldStop({ responses: 6, se: 0.5 }, { targetSe: 0.3, maxItems: 20 });
    assert.equal(cont.stop, false);
    assert.match(cont.reason, /standard error/);
  });

  test('calibration recovers a known difficulty', () => {
    const truth = { a: 1.4, b: 0.6, c: 0 };
    const observations = Array.from({ length: 160 }, (_, i) => {
      const theta = -3 + (i * 6) / 159;
      return { theta, correct: probability(theta, { id: 'x', ...truth }) > 0.5 };
    });
    const cal = calibrateItem(observations);
    assert.ok(cal);
    assert.ok(Math.abs(cal!.b - truth.b) < 0.35, `recovered b=${cal!.b}, truth ${truth.b}`);
  });

  test('calibration declines on insufficient data rather than guessing', () => {
    assert.equal(calibrateItem([{ theta: 0, correct: true }]), null);
  });

  test('ability bands report their own confidence honestly', () => {
    const precise = abilityBand(1.0, 0.2);
    const vague = abilityBand(1.0, 0.8);
    assert.match(precise.confidence, /high/);
    assert.match(vague.confidence, /low/);
    assert.equal(precise.band, 'above');
  });
});
