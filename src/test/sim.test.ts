import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { solveCircuit, CIRCUIT_PRESETS } from '../engines/sim/circuit.js';
import { simulateProjectile, simulatePendulum, simulateIncline, simulateCollision } from '../engines/sim/mechanics.js';
import { balanceEquation, parseFormula, simulateTitration, solveGasLaw } from '../engines/sim/chemistry.js';
import { punnett, gametes, hardyWeinberg } from '../engines/sim/genetics.js';
import { describeLabs, labDefaults, runLab, LABS } from '../engines/sim/lab.js';

const near = (a: number, b: number, tol = 1e-3) =>
  assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (tolerance ${tol})`);

describe('circuit solver', () => {
  test("obeys Ohm's law on a single resistor", () => {
    const s = solveCircuit({
      ground: 'n0',
      components: [
        { id: 'bat', kind: 'battery', from: 'n0', to: 'n1', value: 12 },
        { id: 'r', kind: 'resistor', from: 'n1', to: 'n0', value: 4 },
      ],
    });
    assert.ok(s.ok);
    near(s.totalCurrentA, 3, 1e-3);          // 12 V / 4 Ω
    near(s.equivalentResistance ?? 0, 4, 1e-2);
    near(s.components.find((c) => c.id === 'r')!.powerW, 36, 0.05);
  });

  test('series resistances add', () => {
    const s = solveCircuit({
      ground: 'n0',
      components: [
        { id: 'bat', kind: 'battery', from: 'n0', to: 'n1', value: 12 },
        { id: 'r1', kind: 'resistor', from: 'n1', to: 'n2', value: 100 },
        { id: 'r2', kind: 'resistor', from: 'n2', to: 'n0', value: 200 },
      ],
    });
    near(s.equivalentResistance ?? 0, 300, 0.5);
    const r1 = s.components.find((c) => c.id === 'r1')!;
    const r2 = s.components.find((c) => c.id === 'r2')!;
    near(r1.currentA, r2.currentA, 1e-4);     // same current in series
    near(r1.voltageV + r2.voltageV, 12, 0.01); // voltages share out
    near(r2.voltageV, 8, 0.01);                // divider rule
  });

  test('parallel resistances combine reciprocally', () => {
    const s = solveCircuit({
      ground: 'n0',
      components: [
        { id: 'bat', kind: 'battery', from: 'n0', to: 'n1', value: 12 },
        { id: 'r1', kind: 'resistor', from: 'n1', to: 'n0', value: 100 },
        { id: 'r2', kind: 'resistor', from: 'n1', to: 'n0', value: 100 },
      ],
    });
    near(s.equivalentResistance ?? 0, 50, 0.5);
    near(s.totalCurrentA, 0.24, 1e-3);
  });

  test('current is identical before and after a bulb - the classic misconception', () => {
    const s = solveCircuit(CIRCUIT_PRESETS.series.spec);
    const a = s.components.find((c) => c.id === 'b1')!;
    const b = s.components.find((c) => c.id === 'b2')!;
    near(a.currentA, b.currentA, 1e-6);
  });

  test('an open switch stops the current in that branch', () => {
    const spec = structuredClone(CIRCUIT_PRESETS.switched.spec);
    spec.components.find((c) => c.id === 'sw')!.closed = false;
    const s = solveCircuit(spec);
    near(s.components.find((c) => c.id === 'b1')!.currentA, 0, 1e-6);
    assert.ok(s.warnings.some((w) => /switch/i.test(w)));
  });

  test('unscrewing one parallel bulb leaves the other at full brightness', () => {
    const both = solveCircuit(CIRCUIT_PRESETS.parallel.spec);
    const b1Both = both.components.find((c) => c.id === 'b1')!;
    const spec = structuredClone(CIRCUIT_PRESETS.parallel.spec);
    spec.components = spec.components.filter((c) => c.id !== 'b2');
    const one = solveCircuit(spec);
    const b1Alone = one.components.find((c) => c.id === 'b1')!;
    near(b1Both.currentA, b1Alone.currentA, 1e-5);
  });

  test('a circuit with no source is reported, not crashed', () => {
    const s = solveCircuit({ components: [{ id: 'r', kind: 'resistor', from: 'a', to: 'b', value: 10 }] });
    assert.ok(s.warnings.some((w) => /power source/i.test(w)));
  });
});

describe('mechanics', () => {
  test('vacuum range matches the closed form', () => {
    const r = simulateProjectile({ speed: 20, angleDeg: 45, dragCoefficient: 0 });
    const expected = (20 * 20 * Math.sin(Math.PI / 2)) / 9.81;
    near(r.range, expected, 0.05);
    near(r.vacuumRange, expected, 0.05);
  });

  test('45 degrees maximises range in a vacuum', () => {
    const ranges = [15, 30, 45, 60, 75].map((a) => simulateProjectile({ speed: 25, angleDeg: a }).range);
    const best = ranges.indexOf(Math.max(...ranges));
    assert.equal(best, 2, `expected 45° to win, got index ${best}`);
  });

  test('complementary angles give equal range from ground level', () => {
    const a = simulateProjectile({ speed: 30, angleDeg: 30 }).range;
    const b = simulateProjectile({ speed: 30, angleDeg: 60 }).range;
    near(a, b, 0.1);
  });

  test('drag always reduces range', () => {
    const vac = simulateProjectile({ speed: 40, angleDeg: 45, dragCoefficient: 0 }).range;
    const air = simulateProjectile({ speed: 40, angleDeg: 45, dragCoefficient: 0.05 }).range;
    assert.ok(air < vac, `drag increased range: ${air} vs ${vac}`);
  });

  test('lower gravity means longer range', () => {
    const earth = simulateProjectile({ speed: 20, angleDeg: 45, gravity: 9.81 }).range;
    const moon = simulateProjectile({ speed: 20, angleDeg: 45, gravity: 1.62 }).range;
    assert.ok(moon > earth * 4);
  });

  test('pendulum period matches the small-angle formula at small angles', () => {
    const r = simulatePendulum({ lengthM: 1, initialAngleDeg: 3 });
    near(r.periodSec, 2 * Math.PI * Math.sqrt(1 / 9.81), 0.02);
    assert.ok(Math.abs(r.periodErrorPct) < 1);
  });

  test('a wide swing takes longer than the formula predicts', () => {
    const wide = simulatePendulum({ lengthM: 1, initialAngleDeg: 120 });
    assert.ok(wide.periodErrorPct > 5, `expected a real error, got ${wide.periodErrorPct}%`);
    assert.ok(wide.periodSec > wide.smallAnglePeriodSec);
  });

  test('pendulum period is independent of nothing but length and gravity', () => {
    const short = simulatePendulum({ lengthM: 0.25, initialAngleDeg: 5 });
    const long = simulatePendulum({ lengthM: 1, initialAngleDeg: 5 });
    near(long.periodSec / short.periodSec, 2, 0.05);   // period scales with sqrt(L)
  });

  test('slipping angle depends on friction, not mass', () => {
    const light = simulateIncline({ angleDeg: 20, massKg: 1, frictionCoefficient: 0.4 });
    const heavy = simulateIncline({ angleDeg: 20, massKg: 100, frictionCoefficient: 0.4 });
    near(light.tippingAngleDeg, heavy.tippingAngleDeg, 1e-6);
    assert.equal(light.moves, heavy.moves);
  });

  test('a slope past the friction angle slides', () => {
    const held = simulateIncline({ angleDeg: 10, massKg: 5, frictionCoefficient: 0.4 });
    const sliding = simulateIncline({ angleDeg: 40, massKg: 5, frictionCoefficient: 0.4 });
    assert.equal(held.moves, false);
    assert.equal(sliding.moves, true);
    assert.ok(sliding.accelerationMs2 > 0);
  });

  test('momentum is conserved in every collision; energy only when elastic', () => {
    for (const e of [0, 0.5, 1]) {
      const r = simulateCollision({ m1: 2, v1: 5, m2: 3, v2: -2, restitution: e });
      near(r.momentumBefore, r.momentumAfter, 1e-6);
      if (e === 1) near(r.kineticEnergyBefore, r.kineticEnergyAfter, 1e-6);
      else assert.ok(r.energyLostJ > 0, `expected energy loss at e=${e}`);
    }
  });

  test('equal masses in an elastic head-on collision swap velocities', () => {
    const r = simulateCollision({ m1: 1, v1: 4, m2: 1, v2: -4, restitution: 1 });
    near(r.v1After, -4, 1e-6);
    near(r.v2After, 4, 1e-6);
  });

  test('a perfectly inelastic collision leaves both at one velocity', () => {
    const r = simulateCollision({ m1: 2, v1: 6, m2: 4, v2: 0, restitution: 0 });
    near(r.v1After, r.v2After, 1e-9);
    near(r.v1After, 2, 1e-6);
  });
});

describe('chemistry', () => {
  test('formula parsing handles groups and subscripts', () => {
    assert.deepEqual(parseFormula('H2O')!.counts, { H: 2, O: 1 });
    assert.deepEqual(parseFormula('Ca(OH)2')!.counts, { Ca: 1, O: 2, H: 2 });
    assert.deepEqual(parseFormula('(NH4)2SO4')!.counts, { N: 2, H: 8, S: 1, O: 4 });
    assert.equal(parseFormula('h2o'), null);
  });

  test('balances classic equations', () => {
    const cases: [string, string][] = [
      ['H2 + O2 -> H2O', '2H2 + O2 -> 2H2O'],
      ['CH4 + O2 -> CO2 + H2O', 'CH4 + 2O2 -> CO2 + 2H2O'],
      ['Fe + O2 -> Fe2O3', '4Fe + 3O2 -> 2Fe2O3'],
      ['N2 + H2 -> NH3', 'N2 + 3H2 -> 2NH3'],
    ];
    for (const [input, expected] of cases) {
      const r = balanceEquation(input);
      assert.ok(r.ok, `failed to balance ${input}: ${r.error ?? ''}`);
      assert.equal(r.balanced, expected);
      assert.ok(r.elementTable.every((e) => e.balanced));
    }
  });

  test('an impossible equation is refused rather than fudged', () => {
    const r = balanceEquation('H2 -> O2');
    assert.equal(r.ok, false);
    assert.ok(r.error);
  });

  test('malformed input is reported', () => {
    assert.ok(balanceEquation('nonsense')?.error);
    assert.ok(balanceEquation('H2 + O2')?.error);
  });

  test('strong acid titration has equivalence at pH 7', () => {
    const r = simulateTitration({ acidConcentration: 0.1, acidVolumeMl: 25, baseConcentration: 0.1, strongAcid: true });
    near(r.equivalenceVolumeMl, 25, 0.2);
    near(r.equivalencePh, 7, 0.6);
    assert.ok(r.curve[0].pH < 2);
    assert.ok(r.curve[r.curve.length - 1].pH > 11);
  });

  test('weak acid equivalence lands above pH 7', () => {
    const r = simulateTitration({ acidConcentration: 0.1, acidVolumeMl: 25, baseConcentration: 0.1, strongAcid: false, acidPka: 4.76 });
    assert.ok(r.equivalencePh > 7.5, `weak acid equivalence should be basic, got ${r.equivalencePh}`);
    assert.equal(r.halfEquivalencePh, 4.76);
    assert.ok(r.indicator.find((i) => i.name === 'phenolphthalein')?.suitable);
  });

  test('pH rises monotonically as base is added', () => {
    const r = simulateTitration({ acidConcentration: 0.1, acidVolumeMl: 25, baseConcentration: 0.1 });
    for (let i = 1; i < r.curve.length; i++) {
      assert.ok(r.curve[i].pH >= r.curve[i - 1].pH - 1e-6, `pH fell at ${r.curve[i].volumeMl} mL`);
    }
  });

  test('ideal gas law is self-consistent', () => {
    const p = solveGasLaw({ solveFor: 'pressure', volumeL: 22.4, temperatureK: 273, moles: 1 });
    near(p.value, 101.3, 1.5);
    const v = solveGasLaw({ solveFor: 'volume', pressureKpa: p.value, temperatureK: 273, moles: 1 });
    near(v.value, 22.4, 0.1);
  });

  test('halving the volume doubles the pressure', () => {
    const a = solveGasLaw({ solveFor: 'pressure', volumeL: 20, temperatureK: 300, moles: 1 }).value;
    const b = solveGasLaw({ solveFor: 'pressure', volumeL: 10, temperatureK: 300, moles: 1 }).value;
    near(b / a, 2, 1e-6);
  });
});

describe('genetics', () => {
  test('gametes enumerate correctly', () => {
    assert.deepEqual(gametes('Aa').sort(), ['A', 'a']);
    assert.equal(gametes('AaBb').length, 4);
    assert.equal(new Set(gametes('AaBb')).size, 4);
  });

  test('Aa x Aa gives the classic 3:1 and 1:2:1', () => {
    const r = punnett({ parent1: 'Aa', parent2: 'Aa' });
    assert.ok(r.ok);
    assert.equal(r.total, 4);
    const dominant = r.phenotypeRatios.find((p) => p.phenotype === 'A')!;
    const recessive = r.phenotypeRatios.find((p) => p.phenotype === 'a')!;
    assert.equal(dominant.fraction, '3/4');
    assert.equal(recessive.fraction, '1/4');
    assert.equal(r.genotypeRatios.find((g) => g.genotype === 'Aa')!.count, 2);
  });

  test('a dihybrid cross gives 9:3:3:1', () => {
    const r = punnett({ parent1: 'AaBb', parent2: 'AaBb' });
    assert.equal(r.total, 16);
    const counts = r.phenotypeRatios.map((p) => p.count).sort((a, b) => b - a);
    assert.deepEqual(counts, [9, 3, 3, 1]);
  });

  test('aa x aa can never produce the dominant phenotype', () => {
    const r = punnett({ parent1: 'aa', parent2: 'aa' });
    assert.equal(r.phenotypeRatios.length, 1);
    assert.equal(r.phenotypeRatios[0].phenotype, 'a');
  });

  test('mismatched or malformed genotypes are refused', () => {
    assert.equal(punnett({ parent1: 'Aa', parent2: 'Bb' }).ok, false);
    assert.equal(punnett({ parent1: 'xyz', parent2: 'Aa' }).ok, false);
  });

  test('Hardy-Weinberg shows carriers far outnumber the affected', () => {
    const r = hardyWeinberg(1 / 2500);
    assert.ok(r.carriers > r.homozygousRecessive * 20,
      `carriers ${r.carriers} should dwarf affected ${r.homozygousRecessive}`);
    assert.ok(Math.abs(r.p + r.q - 1) < 1e-6);
  });
});

describe('lab registry', () => {
  test('every lab runs on its own defaults without throwing', () => {
    for (const lab of LABS) {
      const result = runLab(lab.id, labDefaults(lab.id));
      assert.equal(result.labId, lab.id);
      assert.ok(result.readings.length > 0, `${lab.id} returned no readings`);
      assert.ok(result.insights.length > 0, `${lab.id} returned no insights`);
    }
  });

  test('every lab declares a question, a goal and controls', () => {
    for (const l of describeLabs()) {
      assert.ok(l.question.length > 10, `${l.id} has no question`);
      assert.ok(l.learningGoal.length > 10, `${l.id} has no learning goal`);
      assert.ok(l.controls.length > 0, `${l.id} has no controls`);
      assert.ok(l.conceptSlugs.length > 0, `${l.id} is not linked to any concept`);
    }
  });

  test('an unknown lab fails loudly and lists the real ones', () => {
    assert.throws(() => runLab('teleporter'), /unknown lab/);
  });

  test('labs survive hostile parameters', () => {
    for (const lab of LABS) {
      assert.doesNotThrow(() => runLab(lab.id, { speed: NaN, angleDeg: 'abc', equation: '', parent1: '!!', voltage: -999 }),
        `${lab.id} threw on hostile input`);
    }
  });
});
