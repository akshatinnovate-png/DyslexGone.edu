import { solveLinear, round } from '../../core/mathx.js';

/** A real DC circuit solver by modified nodal analysis.
 *
 *  The student wires a circuit, changes a resistor, and the numbers that come
 *  back are computed from Kirchhoff's laws - not from a lookup table. That is
 *  what lets them discover Ohm's law rather than be told it, and it is why
 *  "what if I short the bulb" gives a real answer. */

export interface Component {
  id: string;
  kind: 'resistor' | 'battery' | 'bulb' | 'wire' | 'switch' | 'ammeter' | 'voltmeter';
  from: string;          // node name
  to: string;
  /** ohms for resistor/bulb, volts for battery */
  value?: number;
  closed?: boolean;      // switches
  label?: string;
}

export interface CircuitSpec {
  components: Component[];
  ground?: string;
}

export interface ComponentReading {
  id: string;
  kind: Component['kind'];
  label: string;
  currentA: number;
  voltageV: number;
  powerW: number;
  /** Bulbs only: 0..1 relative to their rated power. */
  brightness?: number;
  note?: string;
}

export interface CircuitSolution {
  ok: boolean;
  nodeVoltages: Record<string, number>;
  components: ComponentReading[];
  totalCurrentA: number;
  totalPowerW: number;
  equivalentResistance: number | null;
  warnings: string[];
  explanation: string[];
}

const WIRE_R = 1e-6;

export function solveCircuit(spec: CircuitSpec): CircuitSolution {
  const warnings: string[] = [];
  const active = spec.components.filter((c) => !(c.kind === 'switch' && c.closed === false));
  const openSwitches = spec.components.filter((c) => c.kind === 'switch' && c.closed === false);

  const nodes = [...new Set(active.flatMap((c) => [c.from, c.to]))].sort();
  if (!nodes.length) {
    return {
      ok: false, nodeVoltages: {}, components: [], totalCurrentA: 0, totalPowerW: 0,
      equivalentResistance: null, warnings: ['circuit has no components'], explanation: [],
    };
  }
  const ground = spec.ground && nodes.includes(spec.ground) ? spec.ground : nodes[0];
  const unknownNodes = nodes.filter((nd) => nd !== ground);
  const batteries = active.filter((c) => c.kind === 'battery');

  // Unknowns: node voltages (minus ground) then one current per voltage source.
  const nIdx = new Map(unknownNodes.map((nd, i) => [nd, i]));
  const bIdx = new Map(batteries.map((b, i) => [b.id, unknownNodes.length + i]));
  const size = unknownNodes.length + batteries.length;
  if (size === 0) {
    return {
      ok: false, nodeVoltages: { [ground]: 0 }, components: [], totalCurrentA: 0, totalPowerW: 0,
      equivalentResistance: null, warnings: ['circuit has only one node - nothing can flow'], explanation: [],
    };
  }

  const A: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  const b: number[] = new Array<number>(size).fill(0);

  const conductance = (c: Component): number => {
    if (c.kind === 'wire' || c.kind === 'ammeter') return 1 / WIRE_R;
    if (c.kind === 'switch') return 1 / WIRE_R;
    if (c.kind === 'voltmeter') return 1 / 1e7;             // ideal-ish voltmeter
    const r = Math.max(1e-9, c.value ?? 1);
    return 1 / r;
  };

  for (const c of active) {
    if (c.kind === 'battery') continue;
    const g = conductance(c);
    const i = nIdx.get(c.from);
    const j = nIdx.get(c.to);
    if (i !== undefined) A[i][i] += g;
    if (j !== undefined) A[j][j] += g;
    if (i !== undefined && j !== undefined) { A[i][j] -= g; A[j][i] -= g; }
  }

  for (const bat of batteries) {
    const k = bIdx.get(bat.id)!;
    const i = nIdx.get(bat.from);
    const j = nIdx.get(bat.to);
    // Current leaves `from` and enters `to`.
    if (i !== undefined) { A[i][k] += 1; A[k][i] += 1; }
    if (j !== undefined) { A[j][k] -= 1; A[k][j] -= 1; }
    // V(to) - V(from) = emf
    b[k] = -(bat.value ?? 0);
  }

  const x = solveLinear(A, b);
  if (!x) {
    return {
      ok: false, nodeVoltages: {}, components: [], totalCurrentA: 0, totalPowerW: 0,
      equivalentResistance: null,
      warnings: ['circuit is not solvable - it is probably incomplete, or a source is shorted'],
      explanation: ['Check that every component is part of a closed loop back to the battery.'],
    };
  }

  const V: Record<string, number> = { [ground]: 0 };
  for (const [nd, i] of nIdx) V[nd] = round(x[i], 6);

  const readings: ComponentReading[] = [];
  let totalPower = 0;
  for (const c of spec.components) {
    const open = c.kind === 'switch' && c.closed === false;
    const vFrom = V[c.from] ?? 0;
    const vTo = V[c.to] ?? 0;
    const dv = vFrom - vTo;
    let currentA: number;
    if (open) currentA = 0;
    else if (c.kind === 'battery') currentA = -(x[bIdx.get(c.id)!] ?? 0);
    else currentA = dv * conductance(c);

    const voltageV = c.kind === 'battery' ? (c.value ?? 0) : dv;
    const powerW = Math.abs(voltageV * currentA);
    if (c.kind !== 'battery') totalPower += powerW;

    const reading: ComponentReading = {
      id: c.id,
      kind: c.kind,
      label: c.label ?? c.id,
      currentA: round(Math.abs(currentA), 5),
      voltageV: round(Math.abs(voltageV), 5),
      powerW: round(powerW, 5),
    };

    if (c.kind === 'bulb') {
      const rated = Math.max(0.01, (c.value ?? 10));
      // Brightness is strongly non-linear in power, like a real filament.
      reading.brightness = round(Math.min(1, (powerW / (rated * 0.9)) ** 0.45), 4);
      if (reading.brightness < 0.03) reading.note = 'barely glowing';
      else if (reading.brightness > 0.97) reading.note = 'at risk of burning out';
    }
    if (open) reading.note = 'switch is open - no current can flow in this branch';
    readings.push(reading);
  }

  const sourceCurrent = batteries.length
    ? Math.abs(readings.find((r) => r.kind === 'battery')?.currentA ?? 0)
    : 0;
  const sourceVoltage = batteries[0]?.value ?? 0;
  const rEq = sourceCurrent > 1e-9 ? round(sourceVoltage / sourceCurrent, 4) : null;

  if (openSwitches.length) warnings.push(`${openSwitches.length} switch(es) open - part of the circuit is isolated`);
  if (sourceCurrent > 50) warnings.push('very large current: this looks like a short circuit across the battery');
  if (batteries.length === 0) warnings.push('no power source - nothing will flow');

  const explanation: string[] = [];
  if (rEq !== null) {
    explanation.push(`The battery supplies ${sourceVoltage} V and ${round(sourceCurrent, 3)} A flows, so the whole circuit behaves like a single ${rEq} Ω resistor.`);
  }
  const resistors = readings.filter((r) => r.kind === 'resistor' || r.kind === 'bulb');
  if (resistors.length > 1) {
    const sameCurrent = resistors.every((r) => Math.abs(r.currentA - resistors[0].currentA) < 1e-4);
    explanation.push(sameCurrent
      ? 'Every component carries the same current, which is what "in series" means. The voltage is what gets shared out.'
      : 'The components carry different currents, so there is more than one path. Each branch sees the same voltage; the current is what splits.');
  }
  const bulbs = readings.filter((r) => r.kind === 'bulb');
  if (bulbs.length > 1) {
    const dim = bulbs.reduce((a, c) => ((c.brightness ?? 0) < (a.brightness ?? 0) ? c : a));
    const bright = bulbs.reduce((a, c) => ((c.brightness ?? 0) > (a.brightness ?? 0) ? c : a));
    if (Math.abs((bright.brightness ?? 0) - (dim.brightness ?? 0)) > 0.05) {
      explanation.push(`${bright.label} is brighter than ${dim.label} because it dissipates more power (${bright.powerW} W against ${dim.powerW} W).`);
    }
  }

  return {
    ok: true,
    nodeVoltages: V,
    components: readings,
    totalCurrentA: round(sourceCurrent, 5),
    totalPowerW: round(totalPower, 5),
    equivalentResistance: rEq,
    warnings,
    explanation,
  };
}

/** Prebuilt circuits a learner can start from and then modify. */
export const CIRCUIT_PRESETS: Record<string, { label: string; spec: CircuitSpec; question: string }> = {
  simple: {
    label: 'One bulb, one battery',
    question: 'What happens to the current if you double the battery voltage?',
    spec: {
      ground: 'n0',
      components: [
        { id: 'bat', kind: 'battery', from: 'n0', to: 'n1', value: 9, label: '9 V battery' },
        { id: 'b1', kind: 'bulb', from: 'n1', to: 'n0', value: 30, label: 'bulb' },
      ],
    },
  },
  series: {
    label: 'Two bulbs in series',
    question: 'Are the two bulbs equally bright? Why?',
    spec: {
      ground: 'n0',
      components: [
        { id: 'bat', kind: 'battery', from: 'n0', to: 'n1', value: 9, label: '9 V battery' },
        { id: 'b1', kind: 'bulb', from: 'n1', to: 'n2', value: 30, label: 'bulb A' },
        { id: 'b2', kind: 'bulb', from: 'n2', to: 'n0', value: 30, label: 'bulb B' },
      ],
    },
  },
  parallel: {
    label: 'Two bulbs in parallel',
    question: 'Unscrew one bulb. What happens to the other one, and why is that different from the series circuit?',
    spec: {
      ground: 'n0',
      components: [
        { id: 'bat', kind: 'battery', from: 'n0', to: 'n1', value: 9, label: '9 V battery' },
        { id: 'b1', kind: 'bulb', from: 'n1', to: 'n0', value: 30, label: 'bulb A' },
        { id: 'b2', kind: 'bulb', from: 'n1', to: 'n0', value: 30, label: 'bulb B' },
      ],
    },
  },
  divider: {
    label: 'Voltage divider',
    question: 'Change R2 and watch the voltage across it. What is the rule?',
    spec: {
      ground: 'n0',
      components: [
        { id: 'bat', kind: 'battery', from: 'n0', to: 'n1', value: 12, label: '12 V supply' },
        { id: 'r1', kind: 'resistor', from: 'n1', to: 'n2', value: 100, label: 'R1 (100 Ω)' },
        { id: 'r2', kind: 'resistor', from: 'n2', to: 'n0', value: 200, label: 'R2 (200 Ω)' },
        { id: 'vm', kind: 'voltmeter', from: 'n2', to: 'n0', label: 'voltmeter' },
      ],
    },
  },
  switched: {
    label: 'Switch in series',
    question: 'Open the switch. Where does the voltage go?',
    spec: {
      ground: 'n0',
      components: [
        { id: 'bat', kind: 'battery', from: 'n0', to: 'n1', value: 6, label: '6 V battery' },
        { id: 'sw', kind: 'switch', from: 'n1', to: 'n2', closed: true, label: 'switch' },
        { id: 'b1', kind: 'bulb', from: 'n2', to: 'n0', value: 20, label: 'bulb' },
      ],
    },
  },
};
