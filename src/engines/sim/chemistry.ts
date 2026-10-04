import { round, clamp } from '../../core/mathx.js';

/** Chemistry simulators: equation balancing, titration curves, gas laws. */

/* ------------------------- equation balancing ----------------------------- */

export interface ParsedFormula { counts: Record<string, number>; raw: string; }

/** Parses H2SO4, Ca(OH)2, (NH4)2SO4 into element counts. */
export function parseFormula(formula: string): ParsedFormula | null {
  const raw = formula.trim();
  if (!raw) return null;
  let i = 0;

  const parseGroup = (): Record<string, number> | null => {
    const counts: Record<string, number> = {};
    while (i < raw.length) {
      const ch = raw[i];
      if (ch === '(') {
        i++;
        const inner = parseGroup();
        if (!inner) return null;
        if (raw[i] !== ')') return null;
        i++;
        const mult = readNumber();
        for (const [el, n] of Object.entries(inner)) counts[el] = (counts[el] ?? 0) + n * mult;
        continue;
      }
      if (ch === ')') break;
      if (!/[A-Z]/.test(ch)) return null;
      let el = ch;
      i++;
      while (i < raw.length && /[a-z]/.test(raw[i])) el += raw[i++];
      const n = readNumber();
      counts[el] = (counts[el] ?? 0) + n;
    }
    return counts;
  };

  const readNumber = (): number => {
    let s = '';
    while (i < raw.length && /\d/.test(raw[i])) s += raw[i++];
    return s ? Number(s) : 1;
  };

  const counts = parseGroup();
  if (!counts || i < raw.length) return null;
  return { counts, raw };
}

export interface BalanceResult {
  ok: boolean;
  coefficients: number[];
  balanced: string;
  elementTable: { element: string; left: number; right: number; balanced: boolean }[];
  steps: string[];
  error?: string;
}

/** Balances by solving the integer nullspace of the element matrix.
 *
 *  This is the honest method: trial-and-error teaches guessing, but a learner
 *  who sees the conservation constraints written as equations understands why
 *  only the coefficients may change. */
export function balanceEquation(equation: string): BalanceResult {
  const [lhsRaw, rhsRaw] = equation.split(/->|→|=/).map((s) => s?.trim());
  if (!lhsRaw || !rhsRaw) {
    return { ok: false, coefficients: [], balanced: '', elementTable: [], steps: [], error: 'equation needs a left and a right side separated by ->' };
  }
  const split = (side: string) => side.split('+').map((s) => s.trim().replace(/^\d+\s*/, '')).filter(Boolean);
  const left = split(lhsRaw);
  const right = split(rhsRaw);
  const species = [...left, ...right];

  const parsed = species.map(parseFormula);
  if (parsed.some((p) => !p)) {
    const bad = species[parsed.findIndex((p) => !p)];
    return { ok: false, coefficients: [], balanced: '', elementTable: [], steps: [], error: `could not parse the formula "${bad}"` };
  }

  const elements = [...new Set(parsed.flatMap((p) => Object.keys(p!.counts)))].sort();
  // Matrix: one row per element, one column per species. Right side is negative.
  const M = elements.map((el) => species.map((_, j) => {
    const n = parsed[j]!.counts[el] ?? 0;
    return j < left.length ? n : -n;
  }));

  const coeffs = integerNullspace(M, species.length);
  if (!coeffs) {
    return {
      ok: false, coefficients: [], balanced: '', elementTable: [], steps: [],
      error: 'no whole-number balance exists - check the formulas on each side',
    };
  }

  const fmt = (list: string[], offset: number) =>
    list.map((s, k) => `${coeffs[offset + k] === 1 ? '' : coeffs[offset + k]}${s}`).join(' + ');
  const balanced = `${fmt(left, 0)} -> ${fmt(right, left.length)}`;

  const elementTable = elements.map((el) => {
    const l = left.reduce((a, _s, k) => a + coeffs[k] * (parsed[k]!.counts[el] ?? 0), 0);
    const r = right.reduce((a, _s, k) => a + coeffs[left.length + k] * (parsed[left.length + k]!.counts[el] ?? 0), 0);
    return { element: el, left: l, right: r, balanced: l === r };
  });

  const steps = [
    `There are ${elements.length} element(s) to conserve: ${elements.join(', ')}.`,
    'Write one equation per element: atoms in = atoms out. Only the coefficients can change - a subscript is part of the substance.',
    ...elementTable.map((e) => `${e.element}: ${e.left} on the left, ${e.right} on the right.`),
    `Smallest whole-number solution: ${coeffs.join(', ')}.`,
  ];

  return { ok: elementTable.every((e) => e.balanced), coefficients: coeffs, balanced, elementTable, steps };
}

/** Rational Gaussian elimination, then scale to the smallest integers. */
function integerNullspace(M: number[][], cols: number): number[] | null {
  const rows = M.length;
  const A = M.map((r) => r.map((v) => [v, 1] as [number, number]));  // exact fractions

  const addScaled = (dst: [number, number][], src: [number, number][], factor: [number, number]) => {
    for (let c = 0; c < cols; c++) dst[c] = fSub(dst[c], fMul(src[c], factor));
  };

  let pivotRow = 0;
  const pivotCols: number[] = [];
  for (let col = 0; col < cols && pivotRow < rows; col++) {
    let sel = -1;
    for (let r = pivotRow; r < rows; r++) if (A[r][col][0] !== 0) { sel = r; break; }
    if (sel < 0) continue;
    [A[pivotRow], A[sel]] = [A[sel], A[pivotRow]];
    const p = A[pivotRow][col];
    for (let c = 0; c < cols; c++) A[pivotRow][c] = fDiv(A[pivotRow][c], p);
    for (let r = 0; r < rows; r++) {
      if (r === pivotRow || A[r][col][0] === 0) continue;
      addScaled(A[r], A[pivotRow], A[r][col]);
    }
    pivotCols.push(col);
    pivotRow++;
  }

  const freeCols = Array.from({ length: cols }, (_, i) => i).filter((c) => !pivotCols.includes(c));
  if (freeCols.length !== 1) return null;    // a unique balance needs exactly one degree of freedom
  const free = freeCols[0];

  const sol: [number, number][] = Array.from({ length: cols }, () => [0, 1] as [number, number]);
  sol[free] = [1, 1];
  pivotCols.forEach((pc, ri) => { sol[pc] = fNeg(A[ri][free]); });

  // Scale to integers.
  let lcmD = 1;
  for (const [, d] of sol) lcmD = lcmInt(lcmD, d);
  const ints = sol.map(([nn, d]) => (nn * lcmD) / d);
  let g = 0;
  for (const v of ints) g = gcdInt(g, Math.abs(v));
  if (g === 0) return null;
  const scaled = ints.map((v) => v / g);
  if (scaled.some((v) => v <= 0) || scaled.some((v) => !Number.isInteger(v))) {
    const flipped = scaled.map((v) => -v);
    if (flipped.every((v) => v > 0 && Number.isInteger(v))) return flipped;
    return null;
  }
  return scaled;
}

const gcdInt = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcdInt(b, a % b));
const lcmInt = (a: number, b: number): number => Math.abs(a * b) / (gcdInt(a, b) || 1);
const norm = ([n, d]: [number, number]): [number, number] => {
  if (d === 0) return [0, 1];
  const g = gcdInt(Math.abs(n), Math.abs(d)) || 1;
  const sign = d < 0 ? -1 : 1;
  return [(sign * n) / g, (sign * d) / g];
};
const fMul = (a: [number, number], b: [number, number]): [number, number] => norm([a[0] * b[0], a[1] * b[1]]);
const fDiv = (a: [number, number], b: [number, number]): [number, number] => norm([a[0] * b[1], a[1] * b[0]]);
const fSub = (a: [number, number], b: [number, number]): [number, number] => norm([a[0] * b[1] - b[0] * a[1], a[1] * b[1]]);
const fNeg = (a: [number, number]): [number, number] => [-a[0], a[1]];

/* ------------------------------- titration -------------------------------- */

export interface TitrationInput {
  acidConcentration: number;   // mol/L
  acidVolumeMl: number;
  baseConcentration: number;
  strongAcid?: boolean;
  strongBase?: boolean;
  acidPka?: number;            // weak acids
  maxBaseMl?: number;
}

export interface TitrationResult {
  curve: { volumeMl: number; pH: number }[];
  equivalenceVolumeMl: number;
  equivalencePh: number;
  halfEquivalencePh: number | null;
  bufferRegion: [number, number] | null;
  indicator: { name: string; range: [number, number]; suitable: boolean }[];
  insights: string[];
}

export function simulateTitration(input: TitrationInput): TitrationResult {
  const Ca = input.acidConcentration;
  const Va = input.acidVolumeMl / 1000;
  const Cb = input.baseConcentration;
  const strongAcid = input.strongAcid ?? true;
  const pka = input.acidPka ?? 4.76;
  const equivalenceL = (Ca * Va) / Math.max(1e-9, Cb);
  const maxMl = input.maxBaseMl ?? Math.max(equivalenceL * 1000 * 2, 10);

  const curve: { volumeMl: number; pH: number }[] = [];
  const steps = 240;
  for (let i = 0; i <= steps; i++) {
    const Vb = (maxMl / 1000) * (i / steps);
    const molA = Ca * Va;
    const molB = Cb * Vb;
    const total = Va + Vb;
    let pH: number;

    if (molB < molA - 1e-12) {
      if (strongAcid) {
        pH = -Math.log10(Math.max(1e-14, (molA - molB) / total));
      } else {
        // Henderson-Hasselbalch in the buffer region.
        const ratio = molB / Math.max(1e-12, molA - molB);
        pH = molB <= 1e-12 ? 0.5 * (pka - Math.log10(Ca)) : pka + Math.log10(Math.max(1e-9, ratio));
      }
    } else if (Math.abs(molB - molA) <= 1e-12) {
      pH = strongAcid ? 7 : 7 + 0.5 * pka + 0.5 * Math.log10(Math.max(1e-9, molA / total));
    } else {
      const excessOh = (molB - molA) / total;
      pH = 14 + Math.log10(Math.max(1e-14, excessOh));
    }
    curve.push({ volumeMl: round(Vb * 1000, 3), pH: round(clamp(pH, 0, 14), 3) });
  }

  const equivalenceMl = round(equivalenceL * 1000, 3);
  const eqPoint = curve.reduce((a, c) => (Math.abs(c.volumeMl - equivalenceMl) < Math.abs(a.volumeMl - equivalenceMl) ? c : a));
  const halfEq = strongAcid ? null : pka;

  const indicators = [
    { name: 'methyl orange', range: [3.1, 4.4] as [number, number] },
    { name: 'bromothymol blue', range: [6.0, 7.6] as [number, number] },
    { name: 'phenolphthalein', range: [8.3, 10.0] as [number, number] },
  ].map((ind) => ({
    ...ind,
    suitable: eqPoint.pH >= ind.range[0] - 0.6 && eqPoint.pH <= ind.range[1] + 0.6,
  }));

  const insights = [
    `Equivalence arrives at ${equivalenceMl} mL, where moles of base finally equal moles of acid.`,
    strongAcid
      ? 'Strong acid with strong base: the equivalence point is pH 7, and the curve is almost vertical there - one drop swings the pH by several units.'
      : `Weak acid: equivalence lands at pH ${round(eqPoint.pH, 2)}, above 7, because the conjugate base left behind is itself basic.`,
  ];
  if (!strongAcid) {
    insights.push(`Halfway to equivalence the pH equals the pKa (${pka}). That is the flattest, best-buffered part of the curve.`);
  }
  const suitable = indicators.filter((i) => i.suitable).map((i) => i.name);
  insights.push(suitable.length
    ? `Use ${suitable.join(' or ')}: the colour change brackets the equivalence pH.`
    : 'No standard indicator brackets this equivalence point well - use a pH meter.');

  return {
    curve,
    equivalenceVolumeMl: equivalenceMl,
    equivalencePh: round(eqPoint.pH, 3),
    halfEquivalencePh: halfEq,
    bufferRegion: strongAcid ? null : [round(equivalenceMl * 0.2, 2), round(equivalenceMl * 0.8, 2)],
    indicator: indicators,
    insights,
  };
}

/* ------------------------------- gas laws --------------------------------- */

export interface GasLawInput {
  pressureKpa?: number;
  volumeL?: number;
  temperatureK?: number;
  moles?: number;
  solveFor: 'pressure' | 'volume' | 'temperature' | 'moles';
}

export interface GasLawResult {
  value: number;
  unit: string;
  relationship: string;
  table: { label: string; value: number; unit: string }[];
  insights: string[];
}

const R = 8.314;   // J/(mol·K)

export function solveGasLaw(input: GasLawInput): GasLawResult {
  const P = (input.pressureKpa ?? 0) * 1000;
  const V = (input.volumeL ?? 0) / 1000;
  const T = input.temperatureK ?? 0;
  const n = input.moles ?? 0;

  let value: number;
  let unit: string;
  let relationship: string;

  switch (input.solveFor) {
    case 'pressure':
      value = round((n * R * T) / Math.max(1e-12, V) / 1000, 4);
      unit = 'kPa';
      relationship = 'P = nRT / V - halve the volume and the pressure doubles.';
      break;
    case 'volume':
      value = round(((n * R * T) / Math.max(1e-12, P)) * 1000, 4);
      unit = 'L';
      relationship = 'V = nRT / P - volume rises with temperature and falls with pressure.';
      break;
    case 'temperature':
      value = round((P * V) / Math.max(1e-12, n * R), 4);
      unit = 'K';
      relationship = 'T = PV / nR - this is absolute temperature, so kelvin, never celsius.';
      break;
    default:
      value = round((P * V) / Math.max(1e-12, R * T), 6);
      unit = 'mol';
      relationship = 'n = PV / RT';
  }

  return {
    value,
    unit,
    relationship,
    table: [
      { label: 'pressure', value: round(input.solveFor === 'pressure' ? value : (input.pressureKpa ?? 0), 4), unit: 'kPa' },
      { label: 'volume', value: round(input.solveFor === 'volume' ? value : (input.volumeL ?? 0), 4), unit: 'L' },
      { label: 'temperature', value: round(input.solveFor === 'temperature' ? value : (input.temperatureK ?? 0), 4), unit: 'K' },
      { label: 'amount', value: round(input.solveFor === 'moles' ? value : (input.moles ?? 0), 6), unit: 'mol' },
    ],
    insights: [
      relationship,
      'Every gas law is the same equation with something held constant: Boyle holds T, Charles holds P, Gay-Lussac holds V.',
      'Temperature must be in kelvin. Using celsius here is the single most common error, and it gives answers that are wrong by hundreds of percent.',
    ],
  };
}
