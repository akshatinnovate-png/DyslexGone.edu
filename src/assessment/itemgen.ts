import type { Bloom, Concept, ItemRecord, Term } from '../domain/types.js';
import { seededRng, type Rng, round } from '../core/mathx.js';
import { truncate, words } from '../core/textkit.js';

/** PROCEDURAL ITEM GENERATION
 *
 *  A concept with no practice items is a dead end: the session can teach it but
 *  can never find out whether it landed. So every concept must be able to
 *  produce a check.
 *
 *  Generated items are not filler. Where a misconception is documented, the
 *  distractors are COMPUTED from the wrong rule - so a wrong answer is still a
 *  diagnosis, exactly like the hand-authored bank. */

export interface GeneratedItem {
  kind: ItemRecord['kind'];
  stem: string;
  choices: { key: string; text: string; misconceptionCode?: string }[];
  answer: { value: unknown; tolerance?: number; aliases?: string[] };
  difficulty: number;
  discrimination: number;
  guessing: number;
  misconceptionMap: Record<string, string>;
  bloom: Bloom;
  explanation: string;
  generator: string;
}

export interface GenContext {
  concept: Concept;
  terms: Term[];
  grade: number;
  rng: Rng;
  /** Roughly -2 (easy) to +2 (hard), used to size the numbers. */
  targetDifficulty: number;
}

type Generator = (ctx: GenContext) => GeneratedItem | null;

const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcd(b, a % b));
const lcm = (a: number, b: number): number => Math.abs(a * b) / (gcd(a, b) || 1);
const pick = <T,>(xs: readonly T[], rng: Rng): T => xs[Math.floor(rng() * xs.length)];
const int = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));

/** Build a 3-4 option MCQ, shuffling so the right answer is not always first. */
function mcq(
  rng: Rng,
  correct: string,
  distractors: { text: string; misconceptionCode?: string }[],
): { choices: GeneratedItem['choices']; answer: string; misconceptionMap: Record<string, string> } {
  const unique = distractors.filter((d, i, a) =>
    d.text !== correct && a.findIndex((x) => x.text === d.text) === i).slice(0, 3);
  const all = [{ text: correct }, ...unique];
  // Fisher-Yates on a seeded rng: deterministic per item, not per process.
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  const keys = ['a', 'b', 'c', 'd'];
  const choices = all.map((c, i) => ({
    key: keys[i],
    text: c.text,
    ...(('misconceptionCode' in c && c.misconceptionCode) ? { misconceptionCode: c.misconceptionCode } : {}),
  }));
  const misconceptionMap: Record<string, string> = {};
  for (const c of choices) if (c.misconceptionCode) misconceptionMap[c.key] = c.misconceptionCode;
  return {
    choices,
    answer: choices.find((c) => c.text === correct)!.key,
    misconceptionMap,
  };
}

/* ----------------------------- math generators ---------------------------- */

const fractionAddition: Generator = (ctx) => {
  const { rng } = ctx;
  const d1 = pick([2, 3, 4, 5, 6, 8], rng);
  let d2 = pick([3, 4, 5, 6, 7, 8, 10], rng);
  if (d2 === d1) d2 = d1 + 1;
  const n1 = int(rng, 1, d1 - 1);
  const n2 = int(rng, 1, d2 - 1);

  const L = lcm(d1, d2);
  const sum = (n1 * L) / d1 + (n2 * L) / d2;
  const g = gcd(sum, L) || 1;
  const correct = `${sum / g}/${L / g}`;

  // The classic error, computed rather than invented.
  const crossNum = n1 + n2;
  const crossDen = d1 + d2;
  const cg = gcd(crossNum, crossDen) || 1;

  const { choices, answer, misconceptionMap } = mcq(rng, correct, [
    { text: `${crossNum / cg}/${crossDen / cg}`, misconceptionCode: 'FRAC_ADD_CROSS' },
    { text: `${sum}/${L * 2}` },
    { text: `${n1 * n2}/${d1 * d2}` },
  ]);

  return {
    kind: 'mcq',
    stem: `What is ${n1}/${d1} + ${n2}/${d2}?`,
    choices,
    answer: { value: answer },
    difficulty: round(ctx.targetDifficulty + (L > 12 ? 0.4 : 0), 3),
    discrimination: 1.4,
    guessing: 1 / choices.length,
    misconceptionMap,
    bloom: 'apply',
    explanation: `Common denominator ${L}: ${(n1 * L) / d1}/${L} + ${(n2 * L) / d2}/${L} = ${sum}/${L}`
      + (g > 1 ? ` = ${correct}.` : '.'),
    generator: 'fractionAddition',
  };
};

const fractionCompare: Generator = (ctx) => {
  const { rng } = ctx;
  const d1 = pick([3, 4, 5, 6], rng);
  const d2 = pick([8, 9, 10, 12], rng);
  const correct = `1/${d1}`;
  const { choices, answer, misconceptionMap } = mcq(rng, correct, [
    { text: `1/${d2}`, misconceptionCode: 'FRAC_BIGGER_DENOM' },
    { text: 'They are equal' },
  ]);
  return {
    kind: 'mcq',
    stem: `Which is larger: 1/${d1} or 1/${d2}?`,
    choices,
    answer: { value: answer },
    difficulty: round(ctx.targetDifficulty - 0.4, 3),
    discrimination: 1.2,
    guessing: 1 / choices.length,
    misconceptionMap,
    bloom: 'understand',
    explanation: `More parts means smaller parts, so 1/${d1} > 1/${d2}.`,
    generator: 'fractionCompare',
  };
};

const division: Generator = (ctx) => {
  const { rng } = ctx;
  const divisor = int(rng, 2, ctx.targetDifficulty > 0 ? 12 : 6);
  const quotient = int(rng, 2, ctx.targetDifficulty > 0 ? 15 : 9);
  const remainder = ctx.targetDifficulty > 0.3 ? int(rng, 0, divisor - 1) : 0;
  const dividend = divisor * quotient + remainder;

  if (remainder === 0) {
    return {
      kind: 'numeric',
      stem: `A baker shares ${dividend} buns equally between ${divisor} boxes. How many buns go in each box?`,
      choices: [],
      answer: { value: quotient },
      difficulty: ctx.targetDifficulty,
      discrimination: 1.2,
      guessing: 0,
      misconceptionMap: {},
      bloom: 'apply',
      explanation: `${dividend} ÷ ${divisor} = ${quotient}, because ${divisor} × ${quotient} = ${dividend}.`,
      generator: 'division',
    };
  }
  const { choices, answer, misconceptionMap } = mcq(rng, `${quotient} remainder ${remainder}`, [
    { text: `${quotient + 1} remainder ${remainder}` },
    { text: `${quotient} remainder ${divisor - remainder}` },
    { text: `${Math.round(dividend / divisor)}` },
  ]);
  return {
    kind: 'mcq',
    stem: `What is ${dividend} ÷ ${divisor}?`,
    choices,
    answer: { value: answer },
    difficulty: round(ctx.targetDifficulty + 0.3, 3),
    discrimination: 1.3,
    guessing: 1 / choices.length,
    misconceptionMap,
    bloom: 'apply',
    explanation: `${divisor} × ${quotient} = ${divisor * quotient}, leaving ${remainder} over.`,
    generator: 'divisionRemainder',
  };
};

const multiplication: Generator = (ctx) => {
  const { rng } = ctx;
  const hi = ctx.targetDifficulty > 0 ? 12 : 9;
  const a = int(rng, 2, hi);
  const b = int(rng, 2, hi);
  return {
    kind: 'numeric',
    stem: `A tray holds ${a} rows of ${b} cakes. How many cakes is that altogether?`,
    choices: [],
    answer: { value: a * b },
    difficulty: ctx.targetDifficulty,
    discrimination: 1.1,
    guessing: 0,
    misconceptionMap: {},
    bloom: 'apply',
    explanation: `${a} rows of ${b} is ${a} × ${b} = ${a * b}.`,
    generator: 'multiplication',
  };
};

const integers: Generator = (ctx) => {
  const { rng } = ctx;
  const a = int(rng, 1, 12);
  const b = int(rng, 1, 9);
  const { choices, answer, misconceptionMap } = mcq(rng, String(a + b), [
    { text: String(a - b), misconceptionCode: 'NEG_SUBTRACT_SMALLER' },
    { text: String(-(a + b)) },
    { text: String(b - a) },
  ]);
  return {
    kind: 'mcq',
    stem: `What is ${a} − (−${b})?`,
    choices,
    answer: { value: answer },
    difficulty: ctx.targetDifficulty,
    discrimination: 1.3,
    guessing: 1 / choices.length,
    misconceptionMap,
    bloom: 'apply',
    explanation: `Subtracting a negative turns around twice: ${a} − (−${b}) = ${a} + ${b} = ${a + b}.`,
    generator: 'integers',
  };
};

const orderOfOperations: Generator = (ctx) => {
  const { rng } = ctx;
  const a = int(rng, 2, 9);
  const b = int(rng, 2, 9);
  const c = int(rng, 2, 9);
  const correct = a + b * c;
  const leftToRight = (a + b) * c;
  const { choices, answer, misconceptionMap } = mcq(rng, String(correct), [
    { text: String(leftToRight), misconceptionCode: 'PEMDAS_LEFT_RIGHT' },
    { text: String(a * b + c) },
    { text: String(a + b + c) },
  ]);
  return {
    kind: 'mcq',
    stem: `Evaluate ${a} + ${b} × ${c}`,
    choices,
    answer: { value: answer },
    difficulty: ctx.targetDifficulty,
    discrimination: 1.5,
    guessing: 1 / choices.length,
    misconceptionMap,
    bloom: 'apply',
    explanation: `Multiplication binds first: ${b} × ${c} = ${b * c}, then ${a} + ${b * c} = ${correct}.`,
    generator: 'orderOfOperations',
  };
};

const linearEquation: Generator = (ctx) => {
  const { rng } = ctx;
  const a = int(rng, 2, 7);
  const x = int(rng, 2, 12);
  const b = int(rng, 1, 15);
  const c = a * x + b;
  return {
    kind: 'numeric',
    stem: `Solve for x:  ${a}x + ${b} = ${c}`,
    choices: [],
    answer: { value: x },
    difficulty: round(ctx.targetDifficulty + 0.3, 3),
    discrimination: 1.6,
    guessing: 0,
    misconceptionMap: {},
    bloom: 'apply',
    explanation: `Subtract ${b} from both sides: ${a}x = ${c - b}. Divide both sides by ${a}: x = ${x}.`,
    generator: 'linearEquation',
  };
};

const proportions: Generator = (ctx) => {
  const { rng } = ctx;
  const people1 = int(rng, 2, 5);
  const factor = int(rng, 2, 4);
  const people2 = people1 * factor;
  const qty1 = int(rng, 2, 8);
  const correct = qty1 * factor;
  const additive = qty1 + (people2 - people1);
  const { choices, answer, misconceptionMap } = mcq(rng, `${correct} cups`, [
    { text: `${additive} cups`, misconceptionCode: 'PROP_ADDITIVE' },
    { text: `${qty1} cups` },
    { text: `${correct + people1} cups` },
  ]);
  return {
    kind: 'mcq',
    stem: `A recipe for ${people1} people needs ${qty1} cups of flour. How much flour for ${people2} people?`,
    choices,
    answer: { value: answer },
    difficulty: round(ctx.targetDifficulty + 0.2, 3),
    discrimination: 1.4,
    guessing: 1 / choices.length,
    misconceptionMap,
    bloom: 'apply',
    explanation: `${people2} ÷ ${people1} = ${factor}, so multiply the flour by ${factor}: ${qty1} × ${factor} = ${correct}.`,
    generator: 'proportions',
  };
};

const percentages: Generator = (ctx) => {
  const { rng } = ctx;
  const pct = pick([10, 20, 25, 50, 75], rng);
  const total = pick([40, 60, 80, 120, 200, 240], rng);
  return {
    kind: 'numeric',
    stem: `What is ${pct}% of ${total}?`,
    choices: [],
    answer: { value: (pct / 100) * total },
    difficulty: ctx.targetDifficulty,
    discrimination: 1.2,
    guessing: 0,
    misconceptionMap: {},
    bloom: 'apply',
    explanation: `${pct}% means ${pct} per hundred: ${total} × ${pct / 100} = ${(pct / 100) * total}.`,
    generator: 'percentages',
  };
};

const areaPerimeter: Generator = (ctx) => {
  const { rng } = ctx;
  const w = int(rng, 3, 12);
  const h = int(rng, 2, 10);
  const askArea = rng() > 0.5;
  const area = w * h;
  const perimeter = 2 * (w + h);
  const correct = askArea ? `${area} square cm` : `${perimeter} cm`;
  const { choices, answer, misconceptionMap } = mcq(rng, correct, [
    { text: askArea ? `${perimeter} square cm` : `${area} cm`, misconceptionCode: 'AREA_PERIM_CONFUSION' },
    { text: askArea ? `${w + h} square cm` : `${w + h} cm` },
  ]);
  return {
    kind: 'mcq',
    stem: `A rectangle is ${w} cm by ${h} cm. What is its ${askArea ? 'area' : 'perimeter'}?`,
    choices,
    answer: { value: answer },
    difficulty: ctx.targetDifficulty,
    discrimination: 1.3,
    guessing: 1 / choices.length,
    misconceptionMap,
    bloom: 'apply',
    explanation: askArea
      ? `Area covers the inside: ${w} × ${h} = ${area} square cm.`
      : `Perimeter walks the edge: 2 × (${w} + ${h}) = ${perimeter} cm.`,
    generator: 'areaPerimeter',
  };
};

const pythagoras: Generator = (ctx) => {
  const triples = [[3, 4, 5], [6, 8, 10], [5, 12, 13], [8, 15, 17], [9, 12, 15]];
  const [a, b, c] = pick(triples, ctx.rng);
  return {
    kind: 'numeric',
    stem: `A right triangle has legs of ${a} and ${b}. How long is the hypotenuse?`,
    choices: [],
    answer: { value: c },
    difficulty: round(ctx.targetDifficulty + 0.4, 3),
    discrimination: 1.5,
    guessing: 0,
    misconceptionMap: {},
    bloom: 'apply',
    explanation: `${a}² + ${b}² = ${a * a} + ${b * b} = ${c * c}, and √${c * c} = ${c}.`,
    generator: 'pythagoras',
  };
};

const measuresOfCentre: Generator = (ctx) => {
  const { rng } = ctx;
  const base = Array.from({ length: 4 }, () => int(rng, 1, 9)).sort((x, y) => x - y);
  const outlier = int(rng, 60, 120);
  const data = [...base, outlier];
  const mean = data.reduce((a, b) => a + b, 0) / data.length;
  const median = data[2];
  const { choices, answer, misconceptionMap } = mcq(rng, String(median), [
    { text: String(round(mean, 1)), misconceptionCode: 'MEAN_IS_MIDDLE' },
    { text: String(data[data.length - 1]) },
    { text: String(data[0]) },
  ]);
  return {
    kind: 'mcq',
    stem: `What is the median of ${data.join(', ')}?`,
    choices,
    answer: { value: answer },
    difficulty: ctx.targetDifficulty,
    discrimination: 1.3,
    guessing: 1 / choices.length,
    misconceptionMap,
    bloom: 'apply',
    explanation: `Sorted, the middle value is ${median}. The mean is ${round(mean, 1)} - the outlier drags it up.`,
    generator: 'measuresOfCentre',
  };
};

const exponents: Generator = (ctx) => {
  const { rng } = ctx;
  const base = int(rng, 2, 6);
  const power = int(rng, 2, 4);
  const correct = base ** power;
  const { choices, answer, misconceptionMap } = mcq(rng, String(correct), [
    { text: String(base * power) },
    { text: String(base * base) },
    { text: String(power ** base) },
  ]);
  return {
    kind: 'mcq',
    stem: `What is ${base}^${power}?`,
    choices,
    answer: { value: answer },
    difficulty: ctx.targetDifficulty,
    discrimination: 1.2,
    guessing: 1 / choices.length,
    misconceptionMap,
    bloom: 'apply',
    explanation: `${base}^${power} means ${Array(power).fill(base).join(' × ')} = ${correct}, not ${base} × ${power}.`,
    generator: 'exponents',
  };
};

const decimals: Generator = (ctx) => {
  const { rng } = ctx;
  const shortD = pick([0.4, 0.5, 0.7, 0.9], rng);
  const longD = pick([0.125, 0.345, 0.289, 0.1234], rng);
  const bigger = shortD > longD ? shortD : longD;
  const smaller = shortD > longD ? longD : shortD;
  const { choices, answer, misconceptionMap } = mcq(rng, String(bigger), [
    { text: String(smaller), misconceptionCode: smaller === longD ? 'DEC_LONGER_BIGGER' : undefined },
    { text: 'They are equal' },
  ]);
  return {
    kind: 'mcq',
    stem: `Which number is larger: ${shortD} or ${longD}?`,
    choices,
    answer: { value: answer },
    difficulty: round(ctx.targetDifficulty - 0.2, 3),
    discrimination: 1.3,
    guessing: 1 / choices.length,
    misconceptionMap,
    bloom: 'understand',
    explanation: `Line the decimal points up and compare tenths first: ${bigger} > ${smaller}.`,
    generator: 'decimals',
  };
};

const placeValue: Generator = (ctx) => {
  const { rng } = ctx;
  const digits = ctx.targetDifficulty > 0 ? 5 : 3;
  const n = int(rng, 10 ** (digits - 1), 10 ** digits - 1);
  const s = String(n);
  const pos = int(rng, 0, s.length - 1);
  const digit = Number(s[pos]);
  const place = 10 ** (s.length - 1 - pos);
  return {
    kind: 'numeric',
    stem: `In the number ${n}, what is the value of the digit ${digit}${s.split(digit.toString()).length > 2 ? ` in position ${pos + 1} from the left` : ''}?`,
    choices: [],
    answer: { value: digit * place },
    difficulty: ctx.targetDifficulty,
    discrimination: 1.1,
    guessing: 0,
    misconceptionMap: {},
    bloom: 'understand',
    explanation: `That digit sits in the ${place === 1 ? 'ones' : `${place}s`} column, so it is worth ${digit} × ${place} = ${digit * place}.`,
    generator: 'placeValue',
  };
};

const probability: Generator = (ctx) => {
  const { rng } = ctx;
  const red = int(rng, 2, 8);
  const blue = int(rng, 2, 8);
  const total = red + blue;
  const g = gcd(red, total) || 1;
  return {
    kind: 'short_answer',
    stem: `A bag holds ${red} red counters and ${blue} blue counters. You take one without looking. `
      + `What is the probability it is red? Give your answer as a fraction.`,
    choices: [],
    answer: { value: `${red / g}/${total / g}`, aliases: [`${red}/${total}`, String(round(red / total, 4))] },
    difficulty: ctx.targetDifficulty,
    discrimination: 1.3,
    guessing: 0,
    misconceptionMap: {},
    bloom: 'apply',
    explanation: `${red} favourable out of ${total} equally likely: ${red}/${total}`
      + (g > 1 ? ` = ${red / g}/${total / g}.` : '.'),
    generator: 'probability',
  };
};

/* ---------------------------- generic generators -------------------------- */

/** Vocabulary check built from the concept's own glossary. */
const termDefinition: Generator = (ctx) => {
  const withDefs = ctx.terms.filter((t) => t.definition && t.definition.length > 8);
  if (!withDefs.length) return null;
  const target = pick(withDefs, ctx.rng);
  const others = withDefs.filter((t) => t.term !== target.term);
  const { choices, answer, misconceptionMap } = mcq(ctx.rng, target.definition, [
    ...others.slice(0, 2).map((o) => ({ text: o.definition })),
    { text: `The opposite of ${target.term}.` },
  ]);
  if (choices.length < 2) return null;
  return {
    kind: 'mcq',
    stem: `In ${ctx.concept.label}, what does "${target.term}" mean?`,
    choices,
    answer: { value: answer },
    difficulty: round(ctx.targetDifficulty - 0.5, 3),
    discrimination: 1.0,
    guessing: 1 / choices.length,
    misconceptionMap,
    bloom: 'remember',
    explanation: `${target.term}: ${target.definition}`,
    generator: 'termDefinition',
  };
};

/** True/false drawn from the concept description - weak, but real and checkable. */
const statementCheck: Generator = (ctx) => {
  const desc = ctx.concept.description;
  if (!desc || words(desc).length < 8) return null;
  const isTrue = ctx.rng() > 0.45;
  const statement = isTrue ? truncate(desc, 160) : negate(truncate(desc, 160));
  const { choices, answer, misconceptionMap } = mcq(ctx.rng, isTrue ? 'True' : 'False', [{ text: isTrue ? 'False' : 'True' }]);
  return {
    kind: 'true_false',
    stem: `True or false: ${statement}`,
    choices,
    answer: { value: answer },
    difficulty: round(ctx.targetDifficulty - 0.3, 3),
    discrimination: 0.9,
    guessing: 0.5,
    misconceptionMap,
    bloom: 'understand',
    explanation: isTrue
      ? 'This restates the concept accurately.'
      : `The statement was reversed. The accurate version is: ${truncate(desc, 160)}`,
    generator: 'statementCheck',
  };
};

const NEGATIONS: [RegExp, string][] = [
  [/\bis\b/, 'is not'], [/\bare\b/, 'are not'], [/\bcan\b/, 'cannot'],
  [/\balways\b/, 'never'], [/\bnever\b/, 'always'], [/\bmore\b/, 'less'],
  [/\bless\b/, 'more'], [/\bincreases?\b/, 'decreases'], [/\bdecreases?\b/, 'increases'],
  [/\brises?\b/, 'falls'], [/\bfalls?\b/, 'rises'], [/\bmust\b/, 'must not'],
  [/\bsame\b/, 'different'], [/\bequal\b/, 'unequal'], [/\bbefore\b/, 'after'],
];

function negate(s: string): string {
  for (const [re, rep] of NEGATIONS) {
    if (re.test(s)) return s.replace(re, rep);
  }
  return `It is not true that ${s[0].toLowerCase()}${s.slice(1)}`;
}

/** Explain-it-back. Graded by rubric, not by string match. */
const explainBack: Generator = (ctx) => ({
  kind: 'explain',
  stem: `In your own words, explain ${ctx.concept.label}. `
    + (ctx.terms.length ? `Try to use the word "${ctx.terms[0].term}".` : 'Give one example.'),
  choices: [],
  answer: { value: ctx.concept.description || ctx.concept.label },
  difficulty: round(ctx.targetDifficulty + 0.2, 3),
  discrimination: 1.1,
  guessing: 0,
  misconceptionMap: {},
  bloom: 'understand',
  explanation: ctx.concept.description || `A good answer describes what ${ctx.concept.label} is and why it matters.`,
  generator: 'explainBack',
});

/* -------------------------------- registry -------------------------------- */

const BY_SLUG: Record<string, Generator[]> = {
  'fraction-addition': [fractionAddition],
  fractions: [fractionCompare, fractionAddition],
  'equivalent-fractions': [fractionCompare],
  'fraction-multiplication': [fractionAddition],
  division: [division],
  multiplication: [multiplication],
  addition: [multiplication],
  integers: [integers],
  'order-of-operations': [orderOfOperations],
  'linear-equations': [linearEquation],
  variables: [linearEquation],
  proportions: [proportions],
  ratios: [proportions],
  'unit-rates': [proportions],
  percentages: [percentages],
  'perimeter-area': [areaPerimeter],
  volume: [areaPerimeter],
  pythagoras: [pythagoras],
  'mean-median-mode': [measuresOfCentre],
  variability: [measuresOfCentre],
  exponents: [exponents],
  decimals: [decimals],
  'place-value': [placeValue],
  probability: [probability],
  'punnett-squares': [probability],
};

const GENERIC: Generator[] = [termDefinition, statementCheck, explainBack];

export interface GenerateOptions {
  count?: number;
  targetDifficulty?: number;
  seed?: string;
  /** Exclude stems already in the bank, so generation adds rather than repeats. */
  existingStems?: Set<string>;
  allowGeneric?: boolean;
}

/** Generate practice items for any concept. Specific generators first, then
 *  generic ones built from the concept's own description and glossary. */
export function generateItems(
  concept: Concept,
  terms: Term[],
  opts: GenerateOptions = {},
): GeneratedItem[] {
  const count = opts.count ?? 3;
  const rng = seededRng(opts.seed ?? `${concept.slug}:${count}`);
  const grade = Math.round((concept.gradeMin + concept.gradeMax) / 2);
  const targetDifficulty = opts.targetDifficulty ?? round(concept.difficulty * 2 - 1, 3);

  const specific = BY_SLUG[concept.slug] ?? [];
  const pool = opts.allowGeneric === false ? specific : [...specific, ...GENERIC];
  if (!pool.length) return [];

  const out: GeneratedItem[] = [];
  const seenStems = new Set(opts.existingStems ?? []);

  // Try each generator repeatedly; a parameterised generator yields a different
  // item each call, so this fills the bank without duplicates.
  for (let attempt = 0; attempt < count * 8 && out.length < count; attempt++) {
    const gen = pool[attempt % pool.length];
    const ctx: GenContext = {
      concept,
      terms,
      grade,
      rng,
      targetDifficulty: round(targetDifficulty + (out.length - count / 2) * 0.25, 3),
    };
    let item: GeneratedItem | null = null;
    try {
      item = gen(ctx);
    } catch {
      item = null;
    }
    if (!item) continue;
    const key = item.stem.trim().toLowerCase();
    if (seenStems.has(key)) continue;
    seenStems.add(key);
    out.push(item);
  }
  return out;
}

export function hasSpecificGenerator(conceptSlug: string): boolean {
  return conceptSlug in BY_SLUG;
}

export function listGenerators(): { conceptSlug: string; generators: string[] }[] {
  return Object.entries(BY_SLUG).map(([conceptSlug, gens]) => ({
    conceptSlug,
    generators: gens.map((g) => g.name || 'anonymous'),
  }));
}
