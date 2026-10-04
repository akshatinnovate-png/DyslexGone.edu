import { CIRCUIT_PRESETS, solveCircuit, type CircuitSpec } from './circuit.js';
import { decimate, simulateCollision, simulateIncline, simulatePendulum, simulateProjectile } from './mechanics.js';
import { balanceEquation, simulateTitration, solveGasLaw } from './chemistry.js';
import { hardyWeinberg, punnett } from './genetics.js';
import { unprocessable } from '../../core/errors.js';
import { clamp, round } from '../../core/mathx.js';

/** THE VIRTUAL LAB
 *
 *  Every experiment here is backed by a real solver, so a learner can ask a
 *  question the author never anticipated ("what if I short the bulb?",
 *  "what if the angle is 89 degrees?") and get a true answer. That is the
 *  difference between a simulation and an animation of a simulation. */

export interface LabControl {
  key: string;
  label: string;
  kind: 'number' | 'slider' | 'select' | 'toggle' | 'text';
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  default: unknown;
  unit?: string;
  hint?: string;
}

export interface LabReading {
  label: string;
  value: number | string;
  unit?: string;
  highlight?: boolean;
}

export interface LabRunResult {
  labId: string;
  ok: boolean;
  readings: LabReading[];
  series?: { name: string; x: number[]; y: number[]; xLabel: string; yLabel: string }[];
  table?: { headers: string[]; rows: (string | number)[][] };
  insights: string[];
  warnings: string[];
  /** The raw solver output, for a client that wants to draw its own view. */
  raw: unknown;
  /** What to try next, to turn fiddling into an actual investigation. */
  nextExperiment?: string;
}

export interface Lab {
  id: string;
  label: string;
  subject: string;
  conceptSlugs: string[];
  question: string;
  description: string;
  controls: LabControl[];
  /** What the learner should be able to say afterwards. */
  learningGoal: string;
  run(params: Record<string, unknown>): LabRunResult;
}

const num = (p: Record<string, unknown>, k: string, d: number): number => {
  const v = Number(p[k]);
  return Number.isFinite(v) ? v : d;
};
const str = (p: Record<string, unknown>, k: string, d: string): string =>
  (typeof p[k] === 'string' && p[k] ? String(p[k]) : d);
const bool = (p: Record<string, unknown>, k: string, d: boolean): boolean =>
  (p[k] === undefined ? d : p[k] === true || p[k] === 'true' || p[k] === 1);

/* --------------------------------- labs ---------------------------------- */

const circuitLab: Lab = {
  id: 'circuit',
  label: 'Circuit bench',
  subject: 'physics',
  conceptSlugs: ['circuits', 'current-electricity', 'ohms-law'],
  question: 'What actually changes when you add a second bulb?',
  description: 'Wire a circuit and measure it. Every number is solved from Kirchhoff\'s laws, so unusual wiring gives real answers rather than a shrug.',
  learningGoal: 'Current is the same everywhere in a series loop; voltage is what gets shared. In parallel it is the other way round.',
  controls: [
    { key: 'preset', label: 'Circuit', kind: 'select', default: 'series',
      options: Object.entries(CIRCUIT_PRESETS).map(([value, v]) => ({ value, label: v.label })) },
    { key: 'voltage', label: 'Battery voltage', kind: 'slider', min: 1, max: 24, step: 0.5, default: 9, unit: 'V' },
    { key: 'resistance1', label: 'First component', kind: 'slider', min: 1, max: 500, step: 1, default: 30, unit: 'Ω' },
    { key: 'resistance2', label: 'Second component', kind: 'slider', min: 1, max: 500, step: 1, default: 30, unit: 'Ω' },
    { key: 'switchClosed', label: 'Switch closed', kind: 'toggle', default: true },
  ],
  run(p) {
    const presetKey = str(p, 'preset', 'series');
    const preset = CIRCUIT_PRESETS[presetKey] ?? CIRCUIT_PRESETS.series;
    const spec: CircuitSpec = {
      ground: preset.spec.ground,
      components: preset.spec.components.map((c) => {
        if (c.kind === 'battery') return { ...c, value: num(p, 'voltage', c.value ?? 9) };
        if (c.kind === 'switch') return { ...c, closed: bool(p, 'switchClosed', c.closed ?? true) };
        if (c.id === 'b1' || c.id === 'r1') return { ...c, value: num(p, 'resistance1', c.value ?? 30) };
        if (c.id === 'b2' || c.id === 'r2') return { ...c, value: num(p, 'resistance2', c.value ?? 30) };
        return c;
      }),
    };
    const sol = solveCircuit(spec);
    return {
      labId: 'circuit',
      ok: sol.ok,
      readings: [
        { label: 'Total current', value: sol.totalCurrentA, unit: 'A', highlight: true },
        { label: 'Total power', value: sol.totalPowerW, unit: 'W' },
        { label: 'Equivalent resistance', value: sol.equivalentResistance ?? '—', unit: 'Ω' },
        ...sol.components.filter((c) => c.kind !== 'battery').flatMap((c) => [
          { label: `${c.label} current`, value: c.currentA, unit: 'A' },
          { label: `${c.label} voltage`, value: c.voltageV, unit: 'V' },
          ...(c.brightness !== undefined ? [{ label: `${c.label} brightness`, value: round(c.brightness, 3), highlight: true }] : []),
        ]),
      ],
      table: {
        headers: ['Component', 'Current (A)', 'Voltage (V)', 'Power (W)', 'Note'],
        rows: sol.components.map((c) => [c.label, c.currentA, c.voltageV, c.powerW, c.note ?? '']),
      },
      insights: sol.explanation,
      warnings: sol.warnings,
      raw: sol,
      nextExperiment: presetKey === 'series'
        ? 'Now switch to the parallel circuit with the same bulbs. Predict the total current before you look.'
        : preset.question,
    };
  },
};

const projectileLab: Lab = {
  id: 'projectile',
  label: 'Projectile range',
  subject: 'physics',
  conceptSlugs: ['motion', 'speed', 'acceleration', 'gravity'],
  question: 'Which launch angle goes furthest - and does the answer change with air resistance?',
  description: 'Launch a projectile with real RK4 integration, with or without drag.',
  learningGoal: 'Horizontal and vertical motion are independent. 45° is only optimal in a vacuum.',
  controls: [
    { key: 'speed', label: 'Launch speed', kind: 'slider', min: 1, max: 100, step: 1, default: 25, unit: 'm/s' },
    { key: 'angleDeg', label: 'Launch angle', kind: 'slider', min: 1, max: 89, step: 1, default: 45, unit: '°' },
    { key: 'height', label: 'Launch height', kind: 'slider', min: 0, max: 100, step: 1, default: 0, unit: 'm' },
    { key: 'dragCoefficient', label: 'Air resistance', kind: 'slider', min: 0, max: 0.5, step: 0.01, default: 0 },
    { key: 'gravity', label: 'Gravity', kind: 'slider', min: 1.6, max: 25, step: 0.1, default: 9.81, unit: 'm/s²',
      hint: 'Moon 1.6, Earth 9.81, Jupiter 24.8' },
  ],
  run(p) {
    const r = simulateProjectile({
      speed: num(p, 'speed', 25),
      angleDeg: clamp(num(p, 'angleDeg', 45), 0.5, 89.5),
      height: num(p, 'height', 0),
      gravity: num(p, 'gravity', 9.81),
      dragCoefficient: num(p, 'dragCoefficient', 0),
      mass: num(p, 'mass', 1),
    });
    const traj = decimate(r.trajectory, 70);
    return {
      labId: 'projectile',
      ok: true,
      readings: [
        { label: 'Range', value: r.range, unit: 'm', highlight: true },
        { label: 'Max height', value: r.maxHeight, unit: 'm' },
        { label: 'Flight time', value: r.flightTime, unit: 's' },
        { label: 'Impact speed', value: r.impactSpeed, unit: 'm/s' },
        { label: 'Impact angle', value: r.impactAngleDeg, unit: '°' },
        ...(r.dragLossPct > 0.5 ? [{ label: 'Range lost to drag', value: r.dragLossPct, unit: '%' }] : []),
      ],
      series: [{ name: 'path', x: traj.x, y: traj.y, xLabel: 'distance (m)', yLabel: 'height (m)' }],
      insights: r.insights,
      warnings: [],
      raw: r,
      nextExperiment: 'Try 30° and 60° with no drag. Explain why the ranges match, then add drag and watch the symmetry break.',
    };
  },
};

const pendulumLab: Lab = {
  id: 'pendulum',
  label: 'Pendulum',
  subject: 'physics',
  conceptSlugs: ['waves', 'energy', 'gravity'],
  question: 'Does a heavier bob swing more slowly? Does a bigger swing take longer?',
  description: 'A full nonlinear pendulum, so the small-angle approximation can be tested rather than assumed.',
  learningGoal: 'Period depends on length and gravity only - until the swing gets wide, when the simple formula starts to fail.',
  controls: [
    { key: 'lengthM', label: 'String length', kind: 'slider', min: 0.1, max: 5, step: 0.1, default: 1, unit: 'm' },
    { key: 'initialAngleDeg', label: 'Release angle', kind: 'slider', min: 1, max: 170, step: 1, default: 15, unit: '°' },
    { key: 'gravity', label: 'Gravity', kind: 'slider', min: 1.6, max: 25, step: 0.1, default: 9.81, unit: 'm/s²' },
    { key: 'dampingPerSec', label: 'Damping', kind: 'slider', min: 0, max: 1, step: 0.02, default: 0 },
  ],
  run(p) {
    const r = simulatePendulum({
      lengthM: num(p, 'lengthM', 1),
      initialAngleDeg: num(p, 'initialAngleDeg', 15),
      gravity: num(p, 'gravity', 9.81),
      dampingPerSec: num(p, 'dampingPerSec', 0),
      durationSec: 12,
    });
    return {
      labId: 'pendulum',
      ok: true,
      readings: [
        { label: 'Measured period', value: r.periodSec, unit: 's', highlight: true },
        { label: 'Small-angle formula', value: r.smallAnglePeriodSec, unit: 's' },
        { label: 'Formula error', value: r.periodErrorPct, unit: '%' },
      ],
      series: [{ name: 'angle', x: r.t, y: r.angleDeg, xLabel: 'time (s)', yLabel: 'angle (°)' }],
      insights: r.insights,
      warnings: Math.abs(num(p, 'initialAngleDeg', 15)) > 30
        ? ['Beyond about 30° the small-angle formula starts to be visibly wrong.'] : [],
      raw: r,
      nextExperiment: 'Keep the length fixed and raise the release angle from 5° to 150°. Plot the error - when does the textbook formula stop being good enough?',
    };
  },
};

const inclineLab: Lab = {
  id: 'incline',
  label: 'Friction on a slope',
  subject: 'physics',
  conceptSlugs: ['friction', 'forces', 'newtons-second-law'],
  question: 'Does a heavier box slide at a smaller angle?',
  description: 'Tilt a slope and watch the force balance until it slips.',
  learningGoal: 'The slipping angle depends only on the friction coefficient. Mass cancels, because it increases both the pull and the grip.',
  controls: [
    { key: 'angleDeg', label: 'Slope angle', kind: 'slider', min: 0, max: 80, step: 1, default: 20, unit: '°' },
    { key: 'massKg', label: 'Mass', kind: 'slider', min: 0.1, max: 100, step: 0.1, default: 5, unit: 'kg' },
    { key: 'frictionCoefficient', label: 'Friction (μ)', kind: 'slider', min: 0, max: 1.5, step: 0.01, default: 0.4 },
  ],
  run(p) {
    const r = simulateIncline({
      angleDeg: num(p, 'angleDeg', 20),
      massKg: num(p, 'massKg', 5),
      frictionCoefficient: num(p, 'frictionCoefficient', 0.4),
    });
    return {
      labId: 'incline',
      ok: true,
      readings: [
        { label: 'Moving?', value: r.moves ? 'yes, sliding' : 'no, held by friction', highlight: true },
        { label: 'Acceleration', value: r.accelerationMs2, unit: 'm/s²' },
        { label: 'Weight', value: r.weightN, unit: 'N' },
        { label: 'Normal force', value: r.normalN, unit: 'N' },
        { label: 'Force along slope', value: r.alongSlopeN, unit: 'N' },
        { label: 'Max static friction', value: r.maxStaticFrictionN, unit: 'N' },
        { label: 'Slips at', value: r.tippingAngleDeg, unit: '°', highlight: true },
      ],
      insights: r.insights,
      warnings: [],
      raw: r,
      nextExperiment: 'Double the mass and find the slipping angle again. Why did it not change?',
    };
  },
};

const collisionLab: Lab = {
  id: 'collision',
  label: 'Collisions',
  subject: 'physics',
  conceptSlugs: ['energy-conservation', 'newtons-third-law', 'energy'],
  question: 'What survives a crash - momentum, energy, or both?',
  description: 'Collide two objects at any mass, speed and bounciness.',
  learningGoal: 'Momentum is always conserved. Kinetic energy only is when the collision is elastic.',
  controls: [
    { key: 'm1', label: 'Mass A', kind: 'slider', min: 0.1, max: 20, step: 0.1, default: 2, unit: 'kg' },
    { key: 'v1', label: 'Velocity A', kind: 'slider', min: -20, max: 20, step: 0.5, default: 5, unit: 'm/s' },
    { key: 'm2', label: 'Mass B', kind: 'slider', min: 0.1, max: 20, step: 0.1, default: 3, unit: 'kg' },
    { key: 'v2', label: 'Velocity B', kind: 'slider', min: -20, max: 20, step: 0.5, default: -2, unit: 'm/s' },
    { key: 'restitution', label: 'Bounciness', kind: 'slider', min: 0, max: 1, step: 0.05, default: 1,
      hint: '1 = perfectly elastic, 0 = they stick together' },
  ],
  run(p) {
    const r = simulateCollision({
      m1: num(p, 'm1', 2), v1: num(p, 'v1', 5),
      m2: num(p, 'm2', 3), v2: num(p, 'v2', -2),
      restitution: num(p, 'restitution', 1),
    });
    return {
      labId: 'collision',
      ok: true,
      readings: [
        { label: 'A after', value: r.v1After, unit: 'm/s', highlight: true },
        { label: 'B after', value: r.v2After, unit: 'm/s', highlight: true },
        { label: 'Momentum before', value: r.momentumBefore, unit: 'kg·m/s' },
        { label: 'Momentum after', value: r.momentumAfter, unit: 'kg·m/s' },
        { label: 'Kinetic energy before', value: r.kineticEnergyBefore, unit: 'J' },
        { label: 'Kinetic energy after', value: r.kineticEnergyAfter, unit: 'J' },
        { label: 'Energy lost', value: r.energyLostPct, unit: '%' },
      ],
      insights: r.insights,
      warnings: [],
      raw: r,
      nextExperiment: 'Set bounciness to 0 and watch the energy disappear while the momentum does not move at all.',
    };
  },
};

const balancingLab: Lab = {
  id: 'balancing',
  label: 'Equation balancer',
  subject: 'chemistry',
  conceptSlugs: ['balancing-equations', 'conservation-mass', 'chemical-reactions'],
  question: 'Why can you change the big numbers but not the small ones?',
  description: 'Type any equation. It is balanced by solving the conservation constraints, with the atom count shown for every element.',
  learningGoal: 'Coefficients say how many molecules; subscripts say what the molecule IS. Changing a subscript changes the substance.',
  controls: [
    { key: 'equation', label: 'Equation', kind: 'text', default: 'H2 + O2 -> H2O',
      hint: 'Try CH4 + O2 -> CO2 + H2O, or Fe + O2 -> Fe2O3' },
  ],
  run(p) {
    const r = balanceEquation(str(p, 'equation', 'H2 + O2 -> H2O'));
    return {
      labId: 'balancing',
      ok: r.ok,
      readings: [{ label: 'Balanced equation', value: r.balanced || '—', highlight: true }],
      table: {
        headers: ['Element', 'Left', 'Right', 'Balanced'],
        rows: r.elementTable.map((e) => [e.element, e.left, e.right, e.balanced ? 'yes' : 'NO']),
      },
      insights: r.steps,
      warnings: r.error ? [r.error] : [],
      raw: r,
      nextExperiment: 'Try to balance it by changing a subscript instead. Count the atoms - you will find you made a different chemical.',
    };
  },
};

const titrationLab: Lab = {
  id: 'titration',
  label: 'Titration',
  subject: 'chemistry',
  conceptSlugs: ['acids-bases', 'solutions'],
  question: 'Why does the pH barely move, then jump several units from one drop?',
  description: 'Titrate a strong or weak acid and watch the curve build.',
  learningGoal: 'Equivalence is where moles match, not where pH is 7. For a weak acid those are different points.',
  controls: [
    { key: 'acidConcentration', label: 'Acid concentration', kind: 'slider', min: 0.01, max: 1, step: 0.01, default: 0.1, unit: 'mol/L' },
    { key: 'acidVolumeMl', label: 'Acid volume', kind: 'slider', min: 5, max: 100, step: 5, default: 25, unit: 'mL' },
    { key: 'baseConcentration', label: 'Base concentration', kind: 'slider', min: 0.01, max: 1, step: 0.01, default: 0.1, unit: 'mol/L' },
    { key: 'strongAcid', label: 'Strong acid', kind: 'toggle', default: true },
    { key: 'acidPka', label: 'Acid pKa (weak acids)', kind: 'slider', min: 1, max: 10, step: 0.1, default: 4.76 },
  ],
  run(p) {
    const r = simulateTitration({
      acidConcentration: num(p, 'acidConcentration', 0.1),
      acidVolumeMl: num(p, 'acidVolumeMl', 25),
      baseConcentration: num(p, 'baseConcentration', 0.1),
      strongAcid: bool(p, 'strongAcid', true),
      acidPka: num(p, 'acidPka', 4.76),
    });
    return {
      labId: 'titration',
      ok: true,
      readings: [
        { label: 'Equivalence volume', value: r.equivalenceVolumeMl, unit: 'mL', highlight: true },
        { label: 'pH at equivalence', value: r.equivalencePh, highlight: true },
        ...(r.halfEquivalencePh !== null ? [{ label: 'pH at half-equivalence (= pKa)', value: r.halfEquivalencePh }] : []),
        { label: 'Suitable indicator', value: r.indicator.filter((i) => i.suitable).map((i) => i.name).join(', ') || 'none' },
      ],
      series: [{
        name: 'titration curve',
        x: r.curve.map((c) => c.volumeMl),
        y: r.curve.map((c) => c.pH),
        xLabel: 'base added (mL)', yLabel: 'pH',
      }],
      insights: r.insights,
      warnings: [],
      raw: r,
      nextExperiment: 'Switch to a weak acid with the same concentrations. The equivalence volume does not move - but the pH there does. Why?',
    };
  },
};

const gasLab: Lab = {
  id: 'gas',
  label: 'Ideal gas',
  subject: 'chemistry',
  conceptSlugs: ['matter-states', 'particle-model', 'solutions'],
  question: 'Boyle, Charles and Gay-Lussac are three laws - or are they one?',
  description: 'Solve PV = nRT for any unknown and watch the others move.',
  learningGoal: 'They are one equation with something held constant. And the temperature is always absolute.',
  controls: [
    { key: 'solveFor', label: 'Solve for', kind: 'select', default: 'pressure',
      options: ['pressure', 'volume', 'temperature', 'moles'].map((v) => ({ value: v, label: v })) },
    { key: 'pressureKpa', label: 'Pressure', kind: 'slider', min: 1, max: 1000, step: 1, default: 101, unit: 'kPa' },
    { key: 'volumeL', label: 'Volume', kind: 'slider', min: 0.1, max: 100, step: 0.1, default: 22.4, unit: 'L' },
    { key: 'temperatureK', label: 'Temperature', kind: 'slider', min: 1, max: 1000, step: 1, default: 273, unit: 'K' },
    { key: 'moles', label: 'Amount', kind: 'slider', min: 0.01, max: 10, step: 0.01, default: 1, unit: 'mol' },
  ],
  run(p) {
    const r = solveGasLaw({
      solveFor: str(p, 'solveFor', 'pressure') as 'pressure' | 'volume' | 'temperature' | 'moles',
      pressureKpa: num(p, 'pressureKpa', 101),
      volumeL: num(p, 'volumeL', 22.4),
      temperatureK: num(p, 'temperatureK', 273),
      moles: num(p, 'moles', 1),
    });
    return {
      labId: 'gas',
      ok: true,
      readings: [
        { label: `Solved ${str(p, 'solveFor', 'pressure')}`, value: r.value, unit: r.unit, highlight: true },
        ...r.table.map((t) => ({ label: t.label, value: t.value, unit: t.unit })),
      ],
      insights: r.insights,
      warnings: num(p, 'temperatureK', 273) < 0 ? ['Temperature below absolute zero is not physical.'] : [],
      raw: r,
      nextExperiment: 'Halve the volume and solve for pressure. Then halve it again. What kind of relationship is that?',
    };
  },
};

const punnettLab: Lab = {
  id: 'punnett',
  label: 'Punnett square',
  subject: 'biology',
  conceptSlugs: ['punnett-squares', 'inheritance', 'dna'],
  question: 'Two parents who show no sign of a trait have a child who does. How?',
  description: 'Cross any two genotypes, for one gene or several, and get the full probability breakdown.',
  learningGoal: 'Dominant means "shows when present", not "common". A carrier shows nothing and still passes it on.',
  controls: [
    { key: 'parent1', label: 'Parent 1 genotype', kind: 'text', default: 'Aa', hint: 'Aa, AA, aa, or AaBb for two genes' },
    { key: 'parent2', label: 'Parent 2 genotype', kind: 'text', default: 'Aa' },
  ],
  run(p) {
    const r = punnett({ parent1: str(p, 'parent1', 'Aa'), parent2: str(p, 'parent2', 'Aa') });
    if (!r.ok) {
      return { labId: 'punnett', ok: false, readings: [], insights: [], warnings: [r.error ?? 'invalid genotypes'], raw: r };
    }
    return {
      labId: 'punnett',
      ok: true,
      readings: [
        { label: 'Possible combinations', value: r.total, highlight: true },
        ...r.phenotypeRatios.map((ph) => ({ label: `${ph.description}`, value: ph.fraction, highlight: true })),
      ],
      table: {
        headers: ['', ...r.gametes2],
        rows: r.grid.map((row, i) => [r.gametes1[i], ...row.map((c) => c.genotype)]),
      },
      insights: r.insights,
      warnings: [],
      raw: r,
      nextExperiment: 'Cross Aa × aa. Compare it with Aa × Aa and explain why the recessive trait appears far more often.',
    };
  },
};

const hardyLab: Lab = {
  id: 'hardy-weinberg',
  label: 'Carrier frequency',
  subject: 'biology',
  conceptSlugs: ['inheritance', 'evolution'],
  question: 'If 1 person in 2500 has a recessive condition, how many people carry it?',
  description: 'Hardy-Weinberg: turn an observed trait frequency into allele and carrier frequencies.',
  learningGoal: 'Carriers vastly outnumber affected individuals for any rare recessive trait.',
  controls: [
    { key: 'recessiveFrequency', label: 'Fraction showing the recessive trait', kind: 'slider',
      min: 0.0001, max: 0.5, step: 0.0001, default: 0.0004 },
  ],
  run(p) {
    const r = hardyWeinberg(num(p, 'recessiveFrequency', 0.0004));
    return {
      labId: 'hardy-weinberg',
      ok: true,
      readings: [
        { label: 'p (dominant allele)', value: r.p },
        { label: 'q (recessive allele)', value: r.q },
        { label: 'Carriers (heterozygous)', value: `${round(r.carriers * 100, 2)}%`, highlight: true },
        { label: 'Affected', value: `${round(r.homozygousRecessive * 100, 4)}%` },
        { label: 'Carriers per affected person', value: round(r.carriers / Math.max(1e-9, r.homozygousRecessive), 1), highlight: true },
      ],
      insights: r.insights,
      warnings: [],
      raw: r,
      nextExperiment: 'Make the trait ten times rarer. Do the carriers become ten times rarer too?',
    };
  },
};

export const LABS: Lab[] = [
  circuitLab, projectileLab, pendulumLab, inclineLab, collisionLab,
  balancingLab, titrationLab, gasLab, punnettLab, hardyLab,
];

const BY_ID = new Map(LABS.map((l) => [l.id, l]));

export function getLab(id: string): Lab {
  const lab = BY_ID.get(id);
  if (!lab) throw unprocessable(`unknown lab '${id}'`, { available: LABS.map((l) => l.id) });
  return lab;
}

export function runLab(id: string, params: Record<string, unknown> = {}): LabRunResult {
  return getLab(id).run(params);
}

export function labsForConcept(conceptSlug: string): Lab[] {
  return LABS.filter((l) => l.conceptSlugs.includes(conceptSlug));
}

export function describeLabs() {
  return LABS.map((l) => ({
    id: l.id, label: l.label, subject: l.subject, question: l.question,
    description: l.description, learningGoal: l.learningGoal,
    conceptSlugs: l.conceptSlugs, controls: l.controls,
  }));
}

/** Default parameter set for a lab, so a client can render it immediately. */
export function labDefaults(id: string): Record<string, unknown> {
  return Object.fromEntries(getLab(id).controls.map((c) => [c.key, c.default]));
}
