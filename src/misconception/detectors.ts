import { clamp, round } from '../core/mathx.js';

/** RULE-BASED MISCONCEPTION DETECTORS.
 *
 *  The point: don't just mark an answer wrong, work out which *wrong rule* the
 *  learner applied. If 2/3 + 1/4 comes back as 3/7, the learner isn't careless
 *  - they are consistently adding numerators and denominators. That is a
 *  diagnosis, and it has a specific repair.
 *
 *  Each detector re-derives the learner's answer from a hypothesised wrong
 *  procedure. If the hypothesis reproduces their answer exactly, we have
 *  strong evidence. No model call, no guessing. */

export interface Detection {
  code: string;
  confidence: number;
  reasoning: string;
  reproducedAnswer: string;
  wrongRule: string;
}

export interface DetectInput {
  stem: string;
  learnerAnswer: string;
  correctAnswer: string;
  conceptSlug?: string;
}

/* ------------------------------- parsing -------------------------------- */

export interface Fraction { n: number; d: number; }

export function parseFraction(s: string): Fraction | null {
  const m = s.trim().match(/^(-?\d+)\s*\/\s*(-?\d+)$/);
  if (!m) return null;
  const d = Number(m[2]);
  if (d === 0) return null;
  return { n: Number(m[1]), d };
}

export function parseFractions(s: string): Fraction[] {
  return [...s.matchAll(/(-?\d+)\s*\/\s*(-?\d+)/g)]
    .map((m) => ({ n: Number(m[1]), d: Number(m[2]) }))
    .filter((f) => f.d !== 0);
}

export function parseNumbers(s: string): number[] {
  return [...s.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
}

const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcd(b, a % b));

export function simplify(f: Fraction): Fraction {
  const g = gcd(f.n, f.d) || 1;
  const sign = f.d < 0 ? -1 : 1;
  return { n: (sign * f.n) / g, d: (sign * f.d) / g };
}

export const fracEq = (a: Fraction, b: Fraction): boolean => a.n * b.d === b.n * a.d;

export const fracStr = (f: Fraction): string => `${f.n}/${f.d}`;

/** Does the learner's text match this number/fraction, in any equivalent form? */
export function answerMatches(answer: string, target: number | Fraction, tolerance = 1e-9): boolean {
  const a = answer.trim();
  if (typeof target === 'number') {
    const f = parseFraction(a);
    if (f) return Math.abs(f.n / f.d - target) < 1e-6;
    const n = Number(a.replace(/[^\d.eE+-]/g, ''));
    return Number.isFinite(n) && Math.abs(n - target) <= Math.max(tolerance, Math.abs(target) * 1e-6);
  }
  const f = parseFraction(a);
  if (f) return fracEq(f, target);
  const n = Number(a.replace(/[^\d.eE+-]/g, ''));
  return Number.isFinite(n) && Math.abs(n - target.n / target.d) < 1e-6;
}

/* ------------------------------- detectors ------------------------------- */

type Detector = (input: DetectInput) => Detection | null;

/** a/b + c/d computed as (a+c)/(b+d). */
const fracAddCross: Detector = (input) => {
  if (!/\+|plus|add/i.test(input.stem)) return null;
  const fs = parseFractions(input.stem);
  if (fs.length < 2) return null;
  const [a, b] = fs;
  const wrong = { n: a.n + b.n, d: a.d + b.d };
  if (!answerMatches(input.learnerAnswer, wrong) && !answerMatches(input.learnerAnswer, simplify(wrong))) return null;
  return {
    code: 'FRAC_ADD_CROSS',
    confidence: 0.95,
    wrongRule: 'adds numerators and denominators as if they were separate sums',
    reproducedAnswer: fracStr(wrong),
    reasoning: `Applying "add the tops, add the bottoms" to ${fracStr(a)} + ${fracStr(b)} gives exactly ${fracStr(wrong)}, which is the answer given. `
      + `The learner is treating a fraction as two independent numbers rather than one quantity.`,
  };
};

/** Subtraction with the same cross rule. */
const fracSubCross: Detector = (input) => {
  if (!/-|minus|subtract|difference/i.test(input.stem)) return null;
  const fs = parseFractions(input.stem);
  if (fs.length < 2) return null;
  const [a, b] = fs;
  const wrong = { n: a.n - b.n, d: a.d - b.d };
  if (wrong.d === 0) return null;
  if (!answerMatches(input.learnerAnswer, wrong)) return null;
  return {
    code: 'FRAC_ADD_CROSS',
    confidence: 0.9,
    wrongRule: 'subtracts numerators and denominators separately',
    reproducedAnswer: fracStr(wrong),
    reasoning: `Subtracting top-from-top and bottom-from-bottom on ${fracStr(a)} - ${fracStr(b)} reproduces ${fracStr(wrong)}.`,
  };
};

/** Larger denominator judged to be the larger fraction. */
const fracBiggerDenom: Detector = (input) => {
  if (!/larger|bigger|greater|which.*more|compare/i.test(input.stem)) return null;
  const fs = parseFractions(input.stem);
  if (fs.length < 2) return null;
  const chosen = parseFraction(input.learnerAnswer);
  if (!chosen) return null;
  const byDenom = [...fs].sort((x, y) => y.d - x.d)[0];
  const bySize = [...fs].sort((x, y) => y.n / y.d - x.n / x.d)[0];
  if (!fracEq(chosen, byDenom) || fracEq(byDenom, bySize)) return null;
  return {
    code: 'FRAC_BIGGER_DENOM',
    confidence: 0.9,
    wrongRule: 'compares fractions by denominator size, using whole-number logic',
    reproducedAnswer: fracStr(byDenom),
    reasoning: `${fracStr(byDenom)} has the larger denominator but is the smaller fraction. `
      + `Choosing it means the learner read "${byDenom.d} > ${bySize.d}" and stopped there - whole-number thinking carried into fractions.`,
  };
};

/** Longer decimal judged larger. */
const decLongerBigger: Detector = (input) => {
  const decimals = [...input.stem.matchAll(/\d*\.\d+/g)].map((m) => m[0]);
  if (decimals.length < 2) return null;
  if (!/larger|bigger|greater|smaller|compare|which/i.test(input.stem)) return null;
  const byLength = [...decimals].sort((a, b) => b.replace('.', '').length - a.replace('.', '').length)[0];
  const byValue = [...decimals].sort((a, b) => Number(b) - Number(a))[0];
  const answer = input.learnerAnswer.trim();
  if (!answer.includes(byLength) || byLength === byValue) return null;
  return {
    code: 'DEC_LONGER_BIGGER',
    confidence: 0.88,
    wrongRule: 'treats "more digits" as "bigger number"',
    reproducedAnswer: byLength,
    reasoning: `${byLength} has more digits than ${byValue} but is smaller. `
      + `The learner is counting digits instead of comparing place values from the left.`,
  };
};

/** Strict left-to-right evaluation. */
const pemdasLeftRight: Detector = (input) => {
  const expr = input.stem.match(/([-\d]+(?:\s*[-+*/×÷]\s*[-\d]+){1,6})/)?.[1];
  if (!expr) return null;
  const leftToRight = evalLeftToRight(expr);
  if (leftToRight === null) return null;
  const proper = evalExpression(expr);
  if (proper === null || Math.abs(leftToRight - proper) < 1e-9) return null;
  if (!answerMatches(input.learnerAnswer, leftToRight)) return null;
  return {
    code: 'PEMDAS_LEFT_RIGHT',
    confidence: 0.95,
    wrongRule: 'evaluates strictly left to right, ignoring operator precedence',
    reproducedAnswer: String(leftToRight),
    reasoning: `Reading ${expr} straight across gives ${leftToRight}; honouring precedence gives ${proper}. `
      + `The answer given is exactly the left-to-right result.`,
  };
};

/** Subtracting a negative treated as subtracting. */
const negSubtract: Detector = (input) => {
  const m = input.stem.match(/(-?\d+)\s*-\s*\(\s*(-\d+)\s*\)/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const wrong = a + b;        // treated the minus-minus as a single minus
  const right = a - b;
  if (Math.abs(wrong - right) < 1e-9) return null;
  if (!answerMatches(input.learnerAnswer, wrong)) return null;
  return {
    code: 'NEG_SUBTRACT_SMALLER',
    confidence: 0.93,
    wrongRule: 'collapses "subtract a negative" into "subtract"',
    reproducedAnswer: String(wrong),
    reasoning: `${a} - (${b}) was computed as ${a} + (${b}) = ${wrong}. The two minus signs cancel: the answer is ${right}. `
      + `The learner is treating the sign as decoration rather than a direction.`,
  };
};

/** Additive scaling where the relationship is multiplicative. */
const propAdditive: Detector = (input) => {
  const nums = parseNumbers(input.stem);
  if (nums.length < 3) return null;
  const [a, b, c] = nums;
  if (!a || !b) return null;
  const additive = c + (b - a);        // "add the same difference"
  const multiplicative = (b / a) * c;
  if (Math.abs(additive - multiplicative) < 1e-9) return null;
  if (!answerMatches(input.learnerAnswer, additive)) return null;
  return {
    code: 'PROP_ADDITIVE',
    confidence: 0.85,
    wrongRule: 'scales by adding the difference instead of multiplying by the ratio',
    reproducedAnswer: String(round(additive, 4)),
    reasoning: `The learner went from ${a} to ${c} by adding ${round(b - a, 4)}, giving ${round(additive, 4)}. `
      + `Proportional scaling multiplies by ${round(b / a, 4)}, giving ${round(multiplicative, 4)}. `
      + `This is the single most common proportional-reasoning error.`,
  };
};

/** Perimeter computed when area was asked (or the reverse). */
const areaPerimeter: Detector = (input) => {
  const nums = parseNumbers(input.stem);
  if (nums.length < 2) return null;
  const [w, h] = nums;
  if (!w || !h) return null;
  const area = w * h;
  const perimeter = 2 * (w + h);
  if (Math.abs(area - perimeter) < 1e-9) return null;
  const wantsArea = /\barea\b/i.test(input.stem);
  const wantsPerimeter = /\bperimeter\b/i.test(input.stem);
  if (wantsArea && answerMatches(input.learnerAnswer, perimeter)) {
    return {
      code: 'AREA_PERIM_CONFUSION', confidence: 0.92,
      wrongRule: 'computes the perimeter when asked for area',
      reproducedAnswer: String(perimeter),
      reasoning: `2 x (${w} + ${h}) = ${perimeter} is the perimeter. The area is ${w} x ${h} = ${area}. The learner walked the fence instead of covering the grass.`,
    };
  }
  if (wantsPerimeter && answerMatches(input.learnerAnswer, area)) {
    return {
      code: 'AREA_PERIM_CONFUSION', confidence: 0.92,
      wrongRule: 'computes the area when asked for perimeter',
      reproducedAnswer: String(area),
      reasoning: `${w} x ${h} = ${area} is the area, not the perimeter (${perimeter}).`,
    };
  }
  return null;
};

/** Mean reported where the median was asked, or vice versa. */
const meanMedian: Detector = (input) => {
  const nums = parseNumbers(input.stem);
  if (nums.length < 4) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  if (Math.abs(mean - median) < 1e-9) return null;
  if (/\bmedian\b/i.test(input.stem) && answerMatches(input.learnerAnswer, mean)) {
    return {
      code: 'MEAN_IS_MIDDLE', confidence: 0.88,
      wrongRule: 'computes the mean when asked for the median',
      reproducedAnswer: String(round(mean, 4)),
      reasoning: `The mean is ${round(mean, 4)}; the median is ${median}. With an outlier present these diverge sharply, which is exactly why the distinction matters.`,
    };
  }
  if (/\bmean\b|\baverage\b/i.test(input.stem) && answerMatches(input.learnerAnswer, median)) {
    return {
      code: 'MEAN_IS_MIDDLE', confidence: 0.85,
      wrongRule: 'computes the median when asked for the mean',
      reproducedAnswer: String(median),
      reasoning: `The median is ${median}; the mean is ${round(mean, 4)}.`,
    };
  }
  return null;
};

/** Balancing by altering subscripts rather than coefficients. */
const chemSubscripts: Detector = (input) => {
  if (!/balanc|equation/i.test(input.stem) && !/->|→/.test(input.learnerAnswer)) return null;
  const answer = input.learnerAnswer;
  if (!/->|→/.test(answer)) return null;
  // A changed subscript shows up as a formula in the answer that is absent from the question.
  const formulas = (answer.match(/[A-Z][a-z]?\d*(?:[A-Z][a-z]?\d*)*/g) ?? []).filter((f) => /\d/.test(f));
  const stemFormulas = new Set((input.stem.match(/[A-Z][a-z]?\d*(?:[A-Z][a-z]?\d*)*/g) ?? []));
  const invented = formulas.filter((f) => !stemFormulas.has(f) && !/^\d/.test(f));
  if (!invented.length) return null;
  return {
    code: 'CHEM_UNBALANCED_SUBSCRIPTS',
    confidence: 0.75,
    wrongRule: 'changes subscripts to balance, which changes the substance',
    reproducedAnswer: invented.join(', '),
    reasoning: `The answer introduces ${invented.join(', ')}, which did not appear in the question. `
      + `Altering a subscript creates a different chemical; only the coefficients in front may change.`,
  };
};

/** Respiration described as breathing. */
const respBreathing: Detector = (input) => {
  if (!/respiration/i.test(input.stem)) return null;
  if (!/breath|lung|inhal|exhal|air in|nose|mouth/i.test(input.learnerAnswer)) return null;
  if (/cell|mitochondri|glucose|energy release/i.test(input.learnerAnswer)) return null;
  return {
    code: 'BIO_RESP_IS_BREATHING',
    confidence: 0.8,
    wrongRule: 'equates cellular respiration with ventilation',
    reproducedAnswer: input.learnerAnswer.slice(0, 80),
    reasoning: 'The answer describes moving air rather than releasing energy from glucose inside cells. '
      + 'The word "respiration" is doing double duty and the learner has the organism-level meaning only.',
  };
};

/** Mass assumed lost when a gas escapes. */
const chemMassLost: Detector = (input) => {
  if (!/mass|weigh/i.test(input.stem)) return null;
  if (!/less|lost|decreas|lighter|disappear/i.test(input.learnerAnswer)) return null;
  if (!/gas|bubble|open|escape|carbon dioxide|hydrogen/i.test(input.stem + input.learnerAnswer)) return null;
  return {
    code: 'CHEM_MASS_LOST_IN_REACTION',
    confidence: 0.72,
    wrongRule: 'treats an escaped gas as mass that ceased to exist',
    reproducedAnswer: input.learnerAnswer.slice(0, 80),
    reasoning: 'The answer says mass decreased. The gas still has mass - it simply left the container. '
      + 'Repeating the reaction sealed would show the total unchanged.',
  };
};

/** Seasons attributed to orbital distance. */
const seasonsDistance: Detector = (input) => {
  if (!/season|summer|winter/i.test(input.stem)) return null;
  if (!/clos|near|far|distance/i.test(input.learnerAnswer)) return null;
  if (/tilt|axis|angle/i.test(input.learnerAnswer)) return null;
  return {
    code: 'EARTH_SEASONS_DISTANCE',
    confidence: 0.85,
    wrongRule: 'explains seasons by distance from the Sun rather than axial tilt',
    reproducedAnswer: input.learnerAnswer.slice(0, 80),
    reasoning: 'The answer appeals to distance. If distance drove seasons, both hemispheres would share them - '
      + 'and Earth is in fact slightly farther from the Sun during the northern summer.',
  };
};

/** Motion assumed to need a continuous force. */
const forceForMotion: Detector = (input) => {
  if (!/constant (?:speed|velocity)|steady speed|net force|friction(?:less)?/i.test(input.stem)) return null;
  if (!/forward force|a force|pushing|force on it|constant force/i.test(input.learnerAnswer)) return null;
  if (/zero|no net|nothing|balanced/i.test(input.learnerAnswer)) return null;
  return {
    code: 'PHYS_FORCE_NEEDED_FOR_MOTION',
    confidence: 0.82,
    wrongRule: 'requires a force to sustain motion rather than to change it',
    reproducedAnswer: input.learnerAnswer.slice(0, 80),
    reasoning: 'The answer keeps a forward force on an object moving at constant velocity. '
      + 'Force changes motion; it is not consumed maintaining it. This is the Aristotelian intuition almost every learner starts with.',
  };
};

/** Current assumed to be used up round a circuit. */
const currentUsedUp: Detector = (input) => {
  if (!/current/i.test(input.stem)) return null;
  if (!/less|smaller|used up|reduc|decreas|weaker/i.test(input.learnerAnswer)) return null;
  return {
    code: 'PHYS_CURRENT_USED_UP',
    confidence: 0.85,
    wrongRule: 'treats current as a fuel consumed by components',
    reproducedAnswer: input.learnerAnswer.slice(0, 80),
    reasoning: 'The answer has less current after the bulb. Charge is conserved round the loop; '
      + 'what the bulb takes is energy, not charge. A bicycle chain moves as one piece.',
  };
};

export const DETECTORS: { code: string; subject: string; fn: Detector }[] = [
  { code: 'FRAC_ADD_CROSS', subject: 'math', fn: fracAddCross },
  { code: 'FRAC_ADD_CROSS', subject: 'math', fn: fracSubCross },
  { code: 'FRAC_BIGGER_DENOM', subject: 'math', fn: fracBiggerDenom },
  { code: 'DEC_LONGER_BIGGER', subject: 'math', fn: decLongerBigger },
  { code: 'PEMDAS_LEFT_RIGHT', subject: 'math', fn: pemdasLeftRight },
  { code: 'NEG_SUBTRACT_SMALLER', subject: 'math', fn: negSubtract },
  { code: 'PROP_ADDITIVE', subject: 'math', fn: propAdditive },
  { code: 'AREA_PERIM_CONFUSION', subject: 'math', fn: areaPerimeter },
  { code: 'MEAN_IS_MIDDLE', subject: 'math', fn: meanMedian },
  { code: 'CHEM_UNBALANCED_SUBSCRIPTS', subject: 'chemistry', fn: chemSubscripts },
  { code: 'CHEM_MASS_LOST_IN_REACTION', subject: 'chemistry', fn: chemMassLost },
  { code: 'BIO_RESP_IS_BREATHING', subject: 'biology', fn: respBreathing },
  { code: 'EARTH_SEASONS_DISTANCE', subject: 'earth_science', fn: seasonsDistance },
  { code: 'PHYS_FORCE_NEEDED_FOR_MOTION', subject: 'physics', fn: forceForMotion },
  { code: 'PHYS_CURRENT_USED_UP', subject: 'physics', fn: currentUsedUp },
];

/** Run every detector; return matches ordered by confidence. */
export function detectAll(input: DetectInput): Detection[] {
  const out: Detection[] = [];
  const seen = new Set<string>();
  for (const d of DETECTORS) {
    let hit: Detection | null = null;
    try { hit = d.fn(input); } catch { hit = null; }
    if (!hit || seen.has(hit.code)) continue;
    seen.add(hit.code);
    out.push({ ...hit, confidence: round(clamp(hit.confidence), 3) });
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

/* ---------------------------- expression eval ---------------------------- */

const tokenize = (expr: string): string[] =>
  (expr.replace(/×/g, '*').replace(/÷/g, '/').match(/-?\d+(?:\.\d+)?|[-+*/()]/g) ?? []);

/** Precedence-correct evaluation (shunting-yard), numbers and + - * / ( ) only. */
export function evalExpression(expr: string): number | null {
  const tokens = tokenize(expr);
  if (!tokens.length) return null;
  const prec: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 };
  const output: (number | string)[] = [];
  const ops: string[] = [];
  let expectOperand = true;

  for (const t of tokens) {
    if (/^-?\d/.test(t) && !(t === '-' )) {
      output.push(Number(t));
      expectOperand = false;
    } else if (t === '(') {
      ops.push(t);
      expectOperand = true;
    } else if (t === ')') {
      while (ops.length && ops[ops.length - 1] !== '(') output.push(ops.pop()!);
      if (!ops.length) return null;
      ops.pop();
      expectOperand = false;
    } else if (t in prec) {
      if (expectOperand && t === '-') { output.push(0); }   // unary minus
      while (ops.length && ops[ops.length - 1] !== '(' && prec[ops[ops.length - 1]] >= prec[t]) {
        output.push(ops.pop()!);
      }
      ops.push(t);
      expectOperand = true;
    } else return null;
  }
  while (ops.length) {
    const op = ops.pop()!;
    if (op === '(') return null;
    output.push(op);
  }

  const stack: number[] = [];
  for (const t of output) {
    if (typeof t === 'number') { stack.push(t); continue; }
    const b = stack.pop();
    const a = stack.pop();
    if (a === undefined || b === undefined) return null;
    stack.push(t === '+' ? a + b : t === '-' ? a - b : t === '*' ? a * b : b === 0 ? NaN : a / b);
  }
  const result = stack.pop();
  return result !== undefined && Number.isFinite(result) ? round(result, 6) : null;
}

/** Deliberately wrong evaluation: ignore precedence and work across. */
export function evalLeftToRight(expr: string): number | null {
  const tokens = tokenize(expr).filter((t) => t !== '(' && t !== ')');
  if (!tokens.length || !/^-?\d/.test(tokens[0])) return null;
  let acc = Number(tokens[0]);
  for (let i = 1; i < tokens.length - 1; i += 2) {
    const op = tokens[i];
    const rhs = Number(tokens[i + 1]);
    if (!Number.isFinite(rhs)) return null;
    acc = op === '+' ? acc + rhs : op === '-' ? acc - rhs : op === '*' ? acc * rhs : rhs === 0 ? NaN : acc / rhs;
  }
  return Number.isFinite(acc) ? round(acc, 6) : null;
}
