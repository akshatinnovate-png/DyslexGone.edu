import { SceneBuilder } from './compiler.js';
import { PALETTE, type Scene } from './primitives.js';

import { parseFraction, type Fraction } from '../../misconception/detectors.js';

/** THE PROCEDURAL ANIMATION LIBRARY
 *
 *  Parameterised explanations, not stored videos. `fractionAddition(2/3, 1/4)`
 *  builds the right animation for those exact numbers, including the common
 *  denominator it has to find. Change the numbers and you get a new, correct
 *  animation - which is what makes targeted remediation possible at all. */

export interface AnimationRequest {
  conceptSlug: string;
  params?: Record<string, unknown>;
  grade?: number;
  paceMultiplier?: number;
  reduceMotion?: boolean;
  background?: string;
}

const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcd(b, a % b));
const lcm = (a: number, b: number): number => Math.abs(a * b) / (gcd(a, b) || 1);

/* ------------------------- fractions: the big one ------------------------- */

export function fractionAddition(a: Fraction, b: Fraction, opts: Partial<AnimationRequest> = {}): Scene {
  const L = lcm(a.d, b.d);
  const an = (a.n * L) / a.d;
  const bn = (b.n * L) / b.d;
  const sum = an + bn;
  const g = gcd(sum, L) || 1;

  const sb = new SceneBuilder({
    title: `Why ${a.n}/${a.d} + ${b.n}/${b.d} is not ${a.n + b.n}/${a.d + b.d}`,
    width: 900, height: 540,
    paceMultiplier: opts.paceMultiplier ?? (opts.grade && opts.grade <= 4 ? 1.35 : 1),
    reduceMotion: opts.reduceMotion,
    background: opts.background,
    meta: { conceptSlug: 'fraction-addition', params: { a, b, lcm: L } },
  });

  sb.backdrop({ kind: 'label', text: `${a.n}/${a.d} + ${b.n}/${b.d} = ?`, x: 450, y: 48, size: 34, anchor: 'middle', weight: 700 });

  sb.beat({
    say: `Here is ${a.n} out of ${a.d} equal parts.`,
    show: [{
      id: 'barA',
      primitive: {
        kind: 'fractionBar', x: 120, y: 110, width: 300, height: 64,
        parts: a.d, shaded: 0, label: `${a.n}/${a.d}`, showLabels: a.d <= 8, fill: PALETTE.primary,
        describe: `A bar cut into ${a.d} equal parts with ${a.n} shaded.`,
      },
    }],
    animate: [{ target: 'barA', channel: 'shaded', from: 0, to: a.n, easing: 'ease_out' }],
  });

  sb.beat({
    say: `And here is ${b.n} out of ${b.d} equal parts. Notice the pieces are a different size.`,
    show: [{
      id: 'barB',
      primitive: {
        kind: 'fractionBar', x: 480, y: 110, width: 300, height: 64,
        parts: b.d, shaded: 0, label: `${b.n}/${b.d}`, showLabels: b.d <= 8, fill: PALETTE.secondary,
        describe: `A bar cut into ${b.d} equal parts with ${b.n} shaded.`,
      },
    }],
    animate: [{ target: 'barB', channel: 'shaded', from: 0, to: b.n, easing: 'ease_out' }],
  });

  sb.beat({
    say: `The tempting move is to add the tops and add the bottoms: ${a.n} plus ${b.n} over ${a.d} plus ${b.d}, which gives ${a.n + b.n}/${a.d + b.d}. Watch why that cannot work.`,
    show: [
      { id: 'wrong', primitive: { kind: 'label', text: `${a.n}/${a.d} + ${b.n}/${b.d} = ${a.n + b.n}/${a.d + b.d}  ?`, x: 450, y: 232, size: 27, anchor: 'middle', color: PALETTE.warn, weight: 700 } },
      { id: 'wrongMark', primitive: { kind: 'highlight', x: 300, y: 208, w: 300, h: 36, opacity: 0.35, fill: PALETTE.warn } },
    ],
  });

  sb.beat({
    say: `You can only add pieces that are the same size. So cut both bars into ${L} parts - that is the smallest number both ${a.d} and ${b.d} divide into.`,
    hide: ['wrong', 'wrongMark'],
    show: [
      { id: 'barA2', primitive: { kind: 'fractionBar', x: 120, y: 280, width: 300, height: 64, parts: L, shaded: 0, label: `${an}/${L}`, fill: PALETTE.primary, describe: `The first bar re-cut into ${L} parts with ${an} shaded.` } },
      { id: 'barB2', primitive: { kind: 'fractionBar', x: 480, y: 280, width: 300, height: 64, parts: L, shaded: 0, label: `${bn}/${L}`, fill: PALETTE.secondary, describe: `The second bar re-cut into ${L} parts with ${bn} shaded.` } },
    ],
    animate: [
      { target: 'barA2', channel: 'shaded', from: 0, to: an, easing: 'ease' },
      { target: 'barB2', channel: 'shaded', from: 0, to: bn, delay: 0.3, easing: 'ease' },
    ],
  });

  sb.beat({
    say: `Same amount as before - ${a.n} out of ${a.d} really is ${an} out of ${L}. Nothing changed except the size of the pieces.`,
    show: [{ id: 'eq', primitive: { kind: 'label', text: `${a.n}/${a.d} = ${an}/${L}    and    ${b.n}/${b.d} = ${bn}/${L}`, x: 450, y: 376, size: 21, anchor: 'middle', color: PALETTE.muted } }],
  });

  sb.beat({
    say: `Now the pieces match, so just count them: ${an} plus ${bn} makes ${sum} pieces, each one ${L}th of the whole.`,
    hide: ['eq'],
    show: [{
      id: 'barSum',
      primitive: { kind: 'fractionBar', x: 300, y: 404, width: 300, height: 64, parts: L, shaded: 0, label: `${sum}/${L}`, fill: PALETTE.good, describe: `The result: ${sum} out of ${L} parts shaded.` },
    }],
    animate: [{ target: 'barSum', channel: 'shaded', from: 0, to: Math.min(sum, L), easing: 'ease_out' }],
  });

  const simplified = `${sum / g}/${L / g}`;
  sb.beat({
    say: g > 1
      ? `That is ${sum} over ${L}, which simplifies to ${simplified}. Compare it to the ${a.n + b.n}/${a.d + b.d} we nearly wrote.`
      : `So the answer is ${sum} over ${L} - not ${a.n + b.n}/${a.d + b.d}.`,
    show: [{
      id: 'answer',
      primitive: {
        kind: 'label',
        text: `${a.n}/${a.d} + ${b.n}/${b.d} = ${sum}/${L}${g > 1 ? ` = ${simplified}` : ''}`,
        x: 450, y: 508, size: 29, anchor: 'middle', color: PALETTE.good, weight: 700,
      },
    }],
  });

  return sb.build();
}

export function fractionCompare(a: Fraction, b: Fraction, opts: Partial<AnimationRequest> = {}): Scene {
  const aVal = a.n / a.d;
  const bVal = b.n / b.d;
  const bigger = aVal >= bVal ? a : b;
  const smaller = aVal >= bVal ? b : a;

  const sb = new SceneBuilder({
    title: `Comparing ${a.n}/${a.d} and ${b.n}/${b.d}`,
    width: 880, height: 440, paceMultiplier: opts.paceMultiplier, reduceMotion: opts.reduceMotion,
    meta: { conceptSlug: 'fractions', params: { a, b } },
  });

  sb.backdrop({ kind: 'label', text: `Which is bigger: ${a.n}/${a.d} or ${b.n}/${b.d}?`, x: 440, y: 46, size: 29, anchor: 'middle', weight: 700 });

  sb.beat({
    say: `${b.d} is a bigger number than ${a.d}, so it is tempting to say ${b.n}/${b.d} is the bigger fraction. Let us check with two identical wholes.`,
    show: [
      { id: 'b1', primitive: { kind: 'fractionBar', x: 90, y: 120, width: 320, height: 60, parts: a.d, shaded: 0, label: `${a.n}/${a.d}`, showLabels: a.d <= 10, fill: PALETTE.primary } },
      { id: 'b2', primitive: { kind: 'fractionBar', x: 470, y: 120, width: 320, height: 60, parts: b.d, shaded: 0, label: `${b.n}/${b.d}`, showLabels: b.d <= 10, fill: PALETTE.secondary } },
    ],
    animate: [
      { target: 'b1', channel: 'shaded', from: 0, to: a.n, easing: 'ease_out' },
      { target: 'b2', channel: 'shaded', from: 0, to: b.n, delay: 0.25, easing: 'ease_out' },
    ],
  });

  sb.beat({
    say: `The denominator counts the cuts. More cuts means each piece is smaller - ${b.d} slices of the same pizza gives thinner slices than ${a.d}.`,
    show: [{ id: 'rule', primitive: { kind: 'label', text: 'denominator = how many cuts, not how much', x: 440, y: 228, size: 19, anchor: 'middle', color: PALETTE.muted } }],
  });

  sb.beat({
    say: `On one number line it is settled: ${bigger.n}/${bigger.d} sits further right, so ${bigger.n}/${bigger.d} is larger than ${smaller.n}/${smaller.d}.`,
    show: [{
      id: 'nl',
      primitive: {
        kind: 'numberLine', x: 140, y: 320, width: 600, min: 0, max: 1, step: 1 / Math.max(a.d, b.d),
        marks: [
          { value: aVal, label: `${a.n}/${a.d}`, color: PALETTE.primary },
          { value: bVal, label: `${b.n}/${b.d}`, color: PALETTE.secondary },
        ],
        describe: `A number line from 0 to 1 with ${a.n}/${a.d} and ${b.n}/${b.d} marked.`,
      },
    }],
  });

  sb.beat({
    say: `So the rule is about the size of the pieces, never the size of the number on the bottom.`,
    show: [{ id: 'ans', primitive: { kind: 'label', text: `${bigger.n}/${bigger.d} > ${smaller.n}/${smaller.d}`, x: 440, y: 414, size: 30, anchor: 'middle', color: PALETTE.good, weight: 700 } }],
  });

  return sb.build();
}

/* --------------------------------- integers ------------------------------- */

export function integerSubtraction(a: number, b: number, opts: Partial<AnimationRequest> = {}): Scene {
  const result = a - b;
  const sb = new SceneBuilder({
    title: `${a} − (${b}) on the number line`,
    width: 880, height: 360, paceMultiplier: opts.paceMultiplier, reduceMotion: opts.reduceMotion,
    meta: { conceptSlug: 'integers', params: { a, b } },
  });

  const lo = Math.min(a, result, b, 0) - 2;
  const hi = Math.max(a, result, b, 0) + 2;

  sb.backdrop({ kind: 'label', text: `${a} − (${b}) = ?`, x: 440, y: 46, size: 32, anchor: 'middle', weight: 700 });
  sb.backdrop({
    kind: 'numberLine', x: 90, y: 180, width: 700, min: lo, max: hi, step: 1,
    describe: `A number line from ${lo} to ${hi}.`,
  }, 2, 'nl');

  sb.beat({
    say: `Start at ${a}.`,
    show: [{ id: 'dot', primitive: { kind: 'circle', x: 90 + ((a - lo) / (hi - lo)) * 700, y: 180, r: 11, fill: PALETTE.primary, stroke: PALETTE.ink } }],
  });

  sb.beat({
    say: b < 0
      ? `Subtracting means facing the negative direction. But the number we are subtracting is itself negative, so we turn around twice - and end up moving right.`
      : `Subtracting ${b} means moving ${b} steps to the left.`,
    show: [{
      id: 'move',
      primitive: {
        kind: 'arrow',
        x: 90 + ((a - lo) / (hi - lo)) * 700, y: 148,
        x2: 90 + ((result - lo) / (hi - lo)) * 700, y2: 148,
        stroke: PALETTE.secondary, strokeWidth: 4,
        label: `${b < 0 ? '+' : '−'}${Math.abs(b)}`,
      },
    }],
  });

  sb.beat({
    say: `We land on ${result}. ${b < 0 ? `Taking away a debt of ${Math.abs(b)} leaves you better off - the answer is bigger than where you started.` : ''}`,
    animate: [{ target: 'dot', channel: 'x', from: 0, to: ((result - a) / (hi - lo)) * 700, easing: 'ease' }],
    show: [{ id: 'ans', primitive: { kind: 'label', text: `${a} − (${b}) = ${result}`, x: 440, y: 300, size: 30, anchor: 'middle', color: PALETTE.good, weight: 700 } }],
  });

  return sb.build();
}

/* --------------------------- order of operations -------------------------- */

export function orderOfOperations(expr: string, opts: Partial<AnimationRequest> = {}): Scene {
  const sb = new SceneBuilder({
    title: `Order of operations: ${expr}`,
    width: 860, height: 400, paceMultiplier: opts.paceMultiplier, reduceMotion: opts.reduceMotion,
    meta: { conceptSlug: 'order-of-operations', params: { expr } },
  });

  const m = expr.match(/(-?\d+)\s*([-+])\s*(-?\d+)\s*([*x×])\s*(-?\d+)/);
  const [, aS, op, bS, , cS] = m ?? [, '2', '+', '3', '*', '4'];
  const a = Number(aS);
  const b = Number(bS);
  const c = Number(cS);
  const product = b * c;
  const right = op === '+' ? a + product : a - product;
  const wrong = op === '+' ? (a + b) * c : (a - b) * c;

  sb.backdrop({ kind: 'label', text: expr, x: 430, y: 60, size: 40, anchor: 'middle', weight: 700 });

  sb.beat({
    say: `Reading straight across gives ${a} ${op} ${b} is ${op === '+' ? a + b : a - b}, then times ${c} is ${wrong}. That is the trap.`,
    show: [
      { id: 'lr', primitive: { kind: 'label', text: `left to right: ${wrong}`, x: 430, y: 130, size: 24, anchor: 'middle', color: PALETTE.warn, weight: 600 } },
      { id: 'lrbox', primitive: { kind: 'highlight', x: 250, y: 108, w: 360, h: 32, fill: PALETTE.warn, opacity: 0.3 } },
    ],
  });

  sb.beat({
    say: `Multiplication binds tighter than addition. ${b} times ${c} is one single quantity: ${product}. Box it first.`,
    hide: ['lr', 'lrbox'],
    show: [
      { id: 'box', primitive: { kind: 'highlight', x: 430, y: 36, w: 150, h: 42, fill: PALETTE.highlight, opacity: 0 } },
      { id: 'groups', primitive: { kind: 'areaModel', x: 300, y: 160, rows: b, cols: c, cell: 26, shadedRows: b, label: `${b} groups of ${c} = ${product}` } },
    ],
    animate: [{ target: 'box', channel: 'opacity', from: 0, to: 0.6, easing: 'ease' }],
  });

  sb.beat({
    say: `Now ${a} ${op} ${product} gives ${right}. Same symbols, different answer, because the structure is different.`,
    show: [{ id: 'ans', primitive: { kind: 'label', text: `${expr} = ${right}`, x: 430, y: 370, size: 32, anchor: 'middle', color: PALETTE.good, weight: 700 } }],
  });

  return sb.build();
}

/* --------------------------------- physics -------------------------------- */

export function newtonsThirdLaw(opts: Partial<AnimationRequest> = {}): Scene {
  const sb = new SceneBuilder({
    title: "Newton's third law: forces act on different objects",
    width: 900, height: 440, paceMultiplier: opts.paceMultiplier, reduceMotion: opts.reduceMotion,
    meta: { conceptSlug: 'newtons-third-law' },
  });

  sb.backdrop({ kind: 'label', text: 'Every force comes in a pair', x: 450, y: 46, size: 29, anchor: 'middle', weight: 700 });
  sb.backdrop({ kind: 'line', x: 60, y: 300, x2: 840, y2: 300, stroke: PALETTE.muted, strokeWidth: 3 }, 2);

  sb.beat({
    say: 'A skateboarder pushes against a wall.',
    show: [
      { id: 'wall', primitive: { kind: 'rect', x: 740, y: 140, w: 60, h: 160, fill: PALETTE.grid, stroke: PALETTE.ink, label: 'wall' } },
      { id: 'person', primitive: { kind: 'circle', x: 420, y: 250, r: 30, fill: PALETTE.primary, stroke: PALETTE.ink, label: 'you' } },
    ],
  });

  sb.beat({
    say: 'You push the wall to the right. That force acts on the wall.',
    show: [{ id: 'f1', primitive: { kind: 'forceVector', x: 460, y: 240, magnitude: 6, angleDeg: 0, label: 'you on wall', color: PALETTE.secondary, scalePxPerUnit: 38 } }],
  });

  sb.beat({
    say: 'At exactly the same instant the wall pushes you to the left, equally hard. That force acts on you.',
    show: [{ id: 'f2', primitive: { kind: 'forceVector', x: 390, y: 270, magnitude: 6, angleDeg: 180, label: 'wall on you', color: PALETTE.primary, scalePxPerUnit: 38 } }],
  });

  sb.beat({
    say: 'Here is the key point: the two forces act on different objects, so they never cancel each other out. That is why you roll away.',
    animate: [{ target: 'person', channel: 'x', from: 0, to: -230, easing: 'ease_in' }],
    show: [{ id: 'note', primitive: { kind: 'label', text: 'different objects → no cancellation → you accelerate', x: 450, y: 370, size: 20, anchor: 'middle', color: PALETTE.muted } }],
  });

  sb.beat({
    say: 'Write every force as "A on B" and the pair becomes obvious: you on wall, wall on you.',
    show: [{ id: 'rule', primitive: { kind: 'label', text: 'F(you on wall) = −F(wall on you)', x: 450, y: 414, size: 25, anchor: 'middle', color: PALETTE.good, weight: 700 } }],
  });

  return sb.build();
}

export function newtonsFirstLaw(opts: Partial<AnimationRequest> = {}): Scene {
  const sb = new SceneBuilder({
    title: "Newton's first law: force changes motion, it does not maintain it",
    width: 900, height: 420, paceMultiplier: opts.paceMultiplier, reduceMotion: opts.reduceMotion,
    meta: { conceptSlug: 'newtons-first-law' },
  });

  sb.backdrop({ kind: 'label', text: 'What keeps it moving?', x: 450, y: 44, size: 29, anchor: 'middle', weight: 700 });
  sb.backdrop({ kind: 'line', x: 60, y: 200, x2: 840, y2: 200, stroke: PALETTE.grid, strokeWidth: 3 }, 2);
  sb.backdrop({ kind: 'label', text: 'rough carpet', x: 200, y: 232, size: 15, anchor: 'middle', color: PALETTE.muted }, 2);
  sb.backdrop({ kind: 'line', x: 450, y: 200, x2: 840, y2: 200, stroke: PALETTE.primary, strokeWidth: 4 }, 3);
  sb.backdrop({ kind: 'label', text: 'frictionless ice', x: 640, y: 232, size: 15, anchor: 'middle', color: PALETTE.primary }, 3);

  sb.beat({
    say: 'Give a puck one push on carpet and it slows to a stop. It feels like motion needs a constant force.',
    show: [{ id: 'puck1', primitive: { kind: 'circle', x: 110, y: 180, r: 16, fill: PALETTE.secondary, stroke: PALETTE.ink } }],
    animate: [{ target: 'puck1', channel: 'x', from: 0, to: 220, easing: 'ease_out' }],
  });

  sb.beat({
    say: 'But something was acting the whole time: friction, pushing backwards.',
    show: [{ id: 'fric', primitive: { kind: 'forceVector', x: 330, y: 180, magnitude: 4, angleDeg: 180, label: 'friction', color: PALETTE.warn, scalePxPerUnit: 26 } }],
  });

  sb.beat({
    say: 'Now take the friction away. One push on frictionless ice and the puck simply keeps going, with nothing pushing it at all.',
    hide: ['fric', 'puck1'],
    show: [{ id: 'puck2', primitive: { kind: 'circle', x: 470, y: 180, r: 16, fill: PALETTE.good, stroke: PALETTE.ink } }],
    animate: [{ target: 'puck2', channel: 'x', from: 0, to: 340, easing: 'linear' }],
  });

  sb.beat({
    say: 'So force is not what maintains motion. Force is what changes it. With zero net force, velocity stays exactly as it was.',
    show: [{ id: 'rule', primitive: { kind: 'label', text: 'net force = 0  →  velocity does not change', x: 450, y: 350, size: 25, anchor: 'middle', color: PALETTE.good, weight: 700 } }],
  });

  return sb.build();
}

export function circuitCurrent(opts: Partial<AnimationRequest> = {}): Scene {
  const sb = new SceneBuilder({
    title: 'Current is not used up',
    width: 880, height: 440, paceMultiplier: opts.paceMultiplier, reduceMotion: opts.reduceMotion,
    meta: { conceptSlug: 'circuits' },
  });

  sb.backdrop({ kind: 'label', text: 'Does the bulb use up the current?', x: 440, y: 44, size: 27, anchor: 'middle', weight: 700 });
  // Circuit loop
  const L = 180, R = 700, T = 110, B = 350;
  sb.backdrop({ kind: 'rect', x: L, y: T, w: R - L, h: B - T, radius: 14, stroke: PALETTE.ink, strokeWidth: 4, fill: 'none' }, 2);
  sb.backdrop({ kind: 'rect', x: L - 30, y: 200, w: 60, h: 60, fill: PALETTE.accent, stroke: PALETTE.ink, label: '9V' }, 4);
  sb.backdrop({ kind: 'circle', x: 440, y: T, r: 26, fill: PALETTE.highlight, stroke: PALETTE.ink }, 4);
  sb.backdrop({ kind: 'label', text: 'bulb', x: 440, y: T - 38, size: 16, anchor: 'middle', weight: 600 }, 5);

  // Charges spaced around the WHOLE loop - the point is that every one of them
  // moves at once, so they cannot all live on the top wire.
  const perimeter = 2 * ((R - L) + (B - T));
  const carriers = 16;
  const at = (d: number): { x: number; y: number; dx: number; dy: number } => {
    let s = ((d % perimeter) + perimeter) % perimeter;
    if (s < R - L) return { x: L + s, y: T, dx: 1, dy: 0 };
    s -= R - L;
    if (s < B - T) return { x: R, y: T + s, dx: 0, dy: 1 };
    s -= B - T;
    if (s < R - L) return { x: R - s, y: B, dx: -1, dy: 0 };
    s -= R - L;
    return { x: L, y: B - s, dx: 0, dy: -1 };
  };
  const stepLen = perimeter / carriers;
  for (let i = 0; i < carriers; i++) {
    const pos = at(i * stepLen);
    sb.backdrop({
      kind: 'particle', x: pos.x, y: pos.y, r: 7, charge: '-',
      describe: i === 0 ? 'Negative charges spaced evenly all the way round the loop.' : undefined,
    }, 6, `e${i}`);
  }

  sb.beat({
    say: 'A circuit is a complete loop. Charge flows all the way round.',
  });

  sb.beat({
    say: 'Watch the charges move. Every one of them moves together, like links in a bicycle chain.',
    animate: Array.from({ length: carriers }, (_, i) => {
      const pos = at(i * stepLen);
      return pos.dx !== 0
        ? { target: `e${i}`, channel: 'x' as const, from: 0, to: pos.dx * stepLen, easing: 'linear' as const }
        : { target: `e${i}`, channel: 'y' as const, from: 0, to: pos.dy * stepLen, easing: 'linear' as const };
    }),
  });

  sb.beat({
    say: 'Measure the current before the bulb and after the bulb. The readings are identical.',
    show: [
      { id: 'a1', primitive: { kind: 'label', text: 'A = 0.5 A', x: 300, y: 92, size: 19, anchor: 'middle', color: PALETTE.primary, weight: 600 } },
      { id: 'a2', primitive: { kind: 'label', text: 'A = 0.5 A', x: 580, y: 92, size: 19, anchor: 'middle', color: PALETTE.primary, weight: 600 } },
    ],
  });

  sb.beat({
    say: 'Nothing is consumed. What the bulb takes is energy, not charge - and the energy comes from the battery, not from the amount of current.',
    show: [{ id: 'rule', primitive: { kind: 'label', text: 'charge is conserved · energy is transferred', x: 440, y: 404, size: 24, anchor: 'middle', color: PALETTE.good, weight: 700 } }],
  });

  return sb.build();
}

/* ------------------------------ earth science ----------------------------- */

export function seasons(opts: Partial<AnimationRequest> = {}): Scene {
  const sb = new SceneBuilder({
    title: 'Seasons come from tilt, not distance',
    width: 900, height: 480, paceMultiplier: opts.paceMultiplier, reduceMotion: opts.reduceMotion,
    meta: { conceptSlug: 'seasons' },
  });

  sb.backdrop({ kind: 'label', text: 'Why is it summer?', x: 450, y: 42, size: 29, anchor: 'middle', weight: 700 });
  sb.backdrop({ kind: 'circle', x: 450, y: 250, r: 40, fill: '#E8A33D', stroke: PALETTE.accent, label: 'Sun' }, 3);

  sb.beat({
    say: 'Earth travels round the Sun on a path that is very nearly a circle. The distance barely changes.',
    show: [{ id: 'orbit', primitive: { kind: 'orbit', x: 450, y: 250, rx: 300, ry: 130, bodyR: 20, angleDeg: 0, fill: PALETTE.primary, describe: 'Earth on a near-circular orbit around the Sun.' } }],
    animate: [{ target: 'orbit', channel: 'angleDeg', from: 0, to: 360, easing: 'linear' }],
  });

  sb.beat({
    say: 'In fact Earth is slightly further from the Sun during the northern summer. So distance cannot be the answer.',
    show: [{ id: 'bust', primitive: { kind: 'label', text: 'July: Earth is FURTHER from the Sun', x: 450, y: 420, size: 21, anchor: 'middle', color: PALETTE.warn, weight: 600 } }],
  });

  sb.beat({
    say: 'The real cause is that Earth is tilted. The hemisphere leaning toward the Sun gets sunlight arriving steeply.',
    hide: ['bust'],
    show: [
      { id: 'earth', primitive: { kind: 'circle', x: 760, y: 250, r: 52, fill: PALETTE.primary, stroke: PALETTE.ink } },
      { id: 'axis', primitive: { kind: 'line', x: 745, y: 180, x2: 775, y2: 320, stroke: PALETTE.ink, strokeWidth: 3, dashed: true } },
      { id: 'rays', primitive: { kind: 'beam', x: 520, y: 215, x2: 700, y2: 225, rays: 4, spread: 18, stroke: '#E8A33D' } },
    ],
  });

  sb.beat({
    say: 'Steep light is concentrated onto a small patch, so that patch heats up. That is summer.',
    show: [
      { id: 'hot', primitive: { kind: 'highlight', x: 730, y: 200, w: 70, h: 24, fill: PALETTE.warn, opacity: 0.5 } },
      { id: 'hotL', primitive: { kind: 'label', text: 'concentrated', x: 765, y: 176, size: 15, anchor: 'middle', color: PALETTE.warn } },
    ],
  });

  sb.beat({
    say: 'The other hemisphere gets the same light spread thinly over a much larger area, so it stays cold. Both happen at once - which is exactly what distance could never explain.',
    show: [
      { id: 'cold', primitive: { kind: 'highlight', x: 715, y: 294, w: 100, h: 24, fill: PALETTE.primary, opacity: 0.45 } },
      { id: 'coldL', primitive: { kind: 'label', text: 'spread out', x: 765, y: 336, size: 15, anchor: 'middle', color: PALETTE.primary } },
      { id: 'rule', primitive: { kind: 'label', text: 'tilt → angle of sunlight → energy per square metre', x: 450, y: 452, size: 22, anchor: 'middle', color: PALETTE.good, weight: 700 } },
    ],
  });

  return sb.build();
}

/* -------------------------------- biology --------------------------------- */

export function photosynthesis(opts: Partial<AnimationRequest> = {}): Scene {
  const sb = new SceneBuilder({
    title: 'Photosynthesis: where a tree gets its mass',
    width: 900, height: 460, paceMultiplier: opts.paceMultiplier, reduceMotion: opts.reduceMotion,
    meta: { conceptSlug: 'photosynthesis' },
  });

  sb.backdrop({ kind: 'label', text: 'Where does a tree come from?', x: 450, y: 42, size: 29, anchor: 'middle', weight: 700 });
  sb.backdrop({
    kind: 'cell', x: 450, y: 250, rx: 190, ry: 120,
    organelles: [{ kind: 'chloroplast', x: -60, y: -20, r: 30, label: 'chloroplast' }, { kind: 'nucleus', x: 70, y: 30, r: 26, label: 'nucleus' }],
    describe: 'A plant cell containing a chloroplast and a nucleus.',
  }, 3, 'cell');

  sb.beat({
    say: 'Most people answer: the soil. Let us follow the atoms instead.',
  });

  sb.beat({
    say: 'Light arrives and is captured by chlorophyll inside the chloroplast.',
    show: [{ id: 'light', primitive: { kind: 'beam', x: 110, y: 150, x2: 370, y2: 215, rays: 4, spread: 16, stroke: '#E8A33D' } }],
  });

  sb.beat({
    say: 'Carbon dioxide comes in from the air through tiny pores in the leaf.',
    show: [
      { id: 'co2', primitive: { kind: 'molecule', x: 140, y: 330, atoms: [{ el: 'C', x: 0, y: 0 }, { el: 'O', x: -28, y: 0 }, { el: 'O', x: 28, y: 0 }], bonds: [{ from: 0, to: 1, order: 2 }, { from: 0, to: 2, order: 2 }], label: 'CO₂ from the air' } },
    ],
    animate: [{ target: 'co2', channel: 'x', from: 0, to: 190, easing: 'ease' }],
  });

  sb.beat({
    say: 'Water arrives from the roots.',
    show: [
      { id: 'h2o', primitive: { kind: 'molecule', x: 760, y: 340, atoms: [{ el: 'O', x: 0, y: 0 }, { el: 'H', x: -24, y: 18 }, { el: 'H', x: 24, y: 18 }], bonds: [{ from: 0, to: 1 }, { from: 0, to: 2 }], label: 'H₂O from the roots' } },
    ],
    animate: [{ target: 'h2o', channel: 'x', from: 0, to: -190, easing: 'ease' }],
  });

  sb.beat({
    say: 'The carbon atoms from the air are joined into glucose. That carbon is what the tree is built from - wood is mostly carbon that used to be in the air.',
    hide: ['co2', 'h2o'],
    show: [
      { id: 'glu', primitive: { kind: 'label', text: '6CO₂ + 6H₂O + light → C₆H₁₂O₆ + 6O₂', x: 450, y: 404, size: 24, anchor: 'middle', color: PALETTE.good, weight: 700 } },
      { id: 'note', primitive: { kind: 'label', text: 'the carbon came from the AIR, not the soil', x: 450, y: 436, size: 18, anchor: 'middle', color: PALETTE.secondary } },
    ],
  });

  sb.beat({
    say: 'Soil supplies water and minerals. It does not supply the bulk of the mass, and it does not supply the energy.',
  });

  return sb.build();
}

/* -------------------------------- geometry -------------------------------- */

export function pythagoras(a = 3, b = 4, opts: Partial<AnimationRequest> = {}): Scene {
  const c = Math.sqrt(a * a + b * b);
  const unit = 34;
  const sb = new SceneBuilder({
    title: `Pythagoras with legs ${a} and ${b}`,
    width: 880, height: 520, paceMultiplier: opts.paceMultiplier, reduceMotion: opts.reduceMotion,
    meta: { conceptSlug: 'pythagoras', params: { a, b, c } },
  });

  const ox = 300;
  const oy = 300;
  sb.backdrop({ kind: 'label', text: `a² + b² = c²`, x: 440, y: 42, size: 32, anchor: 'middle', weight: 700 });

  sb.beat({
    say: `A right triangle with legs of ${a} and ${b}.`,
    show: [{
      id: 'tri',
      primitive: {
        kind: 'polygon',
        points: [{ x: ox, y: oy }, { x: ox + b * unit, y: oy }, { x: ox, y: oy - a * unit }],
        stroke: PALETTE.ink, strokeWidth: 3, fill: PALETTE.highlight,
        describe: `A right triangle with a vertical leg of ${a} units and a horizontal leg of ${b} units.`,
      },
    }],
  });

  sb.beat({
    say: `Build a square on the short leg: ${a} by ${a} is ${a * a} squares.`,
    show: [{ id: 'sqA', primitive: { kind: 'areaModel', x: ox - a * unit, y: oy - a * unit, rows: a, cols: a, cell: unit, shadedRows: a, label: `a² = ${a * a}` } }],
  });

  sb.beat({
    say: `And on the other leg: ${b} by ${b} is ${b * b} squares.`,
    show: [{ id: 'sqB', primitive: { kind: 'areaModel', x: ox, y: oy, rows: b, cols: b, cell: unit, shadedRows: b, label: `b² = ${b * b}` } }],
  });

  sb.beat({
    say: `Add them: ${a * a} plus ${b * b} is ${a * a + b * b} squares.`,
    show: [{ id: 'sum', primitive: { kind: 'label', text: `${a * a} + ${b * b} = ${a * a + b * b}`, x: 700, y: 180, size: 27, anchor: 'middle', weight: 700, color: PALETTE.primary } }],
  });

  sb.beat({
    say: `That is exactly the area of the square on the long side. So c² is ${a * a + b * b}, and c is ${Number.isInteger(c) ? c : c.toFixed(2)}.`,
    show: [{ id: 'ans', primitive: { kind: 'label', text: `c = √${a * a + b * b} = ${Number.isInteger(c) ? c : c.toFixed(2)}`, x: 700, y: 228, size: 29, anchor: 'middle', color: PALETTE.good, weight: 700 } }],
  });

  return sb.build();
}

export function areaVsPerimeter(w = 5, h = 3, opts: Partial<AnimationRequest> = {}): Scene {
  const unit = 44;
  const sb = new SceneBuilder({
    title: 'Perimeter is the fence, area is the grass',
    width: 840, height: 440, paceMultiplier: opts.paceMultiplier, reduceMotion: opts.reduceMotion,
    meta: { conceptSlug: 'perimeter-area', params: { w, h } },
  });

  const ox = 180;
  const oy = 140;
  sb.backdrop({ kind: 'label', text: `A ${w} by ${h} rectangle`, x: 420, y: 44, size: 27, anchor: 'middle', weight: 700 });

  sb.beat({
    say: 'Perimeter is the distance all the way round the edge. Walk it.',
    show: [{ id: 'outline', primitive: { kind: 'rect', x: ox, y: oy, w: w * unit, h: h * unit, stroke: PALETTE.secondary, strokeWidth: 5, fill: 'none' } }],
  });

  sb.beat({
    say: `That is ${w} plus ${h} plus ${w} plus ${h}, which is ${2 * (w + h)} units of fence.`,
    show: [{ id: 'per', primitive: { kind: 'label', text: `perimeter = 2(${w} + ${h}) = ${2 * (w + h)} units`, x: 420, y: oy + h * unit + 46, size: 22, anchor: 'middle', color: PALETTE.secondary, weight: 600 } }],
  });

  sb.beat({
    say: 'Area is different. It is how much flat space is covered - so count the squares inside.',
    show: [{ id: 'tiles', primitive: { kind: 'areaModel', x: ox, y: oy, rows: h, cols: w, cell: unit, shadedRows: h } }],
  });

  sb.beat({
    say: `${w} columns of ${h} squares is ${w * h} square units. One answer is a length, the other is a covering - they are not the same kind of thing.`,
    show: [{ id: 'ar', primitive: { kind: 'label', text: `area = ${w} × ${h} = ${w * h} square units`, x: 420, y: oy + h * unit + 80, size: 22, anchor: 'middle', color: PALETTE.primary, weight: 600 } }],
  });

  return sb.build();
}

/* ------------------------------- proportions ------------------------------ */

export function proportionalScaling(a = 2, b = 3, qty = 4, opts: Partial<AnimationRequest> = {}): Scene {
  const factor = b / a;
  const right = qty * factor;
  const wrong = qty + (b - a);
  const sb = new SceneBuilder({
    title: 'Scaling multiplies, it does not add',
    width: 880, height: 440, paceMultiplier: opts.paceMultiplier, reduceMotion: opts.reduceMotion,
    meta: { conceptSlug: 'proportions', params: { a, b, qty } },
  });

  sb.backdrop({ kind: 'label', text: `${qty} cups feeds ${a} people. How much for ${b}?`, x: 440, y: 44, size: 25, anchor: 'middle', weight: 700 });

  sb.beat({
    say: `The tempting move: ${b} is one more person than ${a}, so add one more cup. That gives ${wrong}.`,
    show: [{ id: 'wrong', primitive: { kind: 'label', text: `add the difference → ${wrong} cups`, x: 440, y: 110, size: 22, anchor: 'middle', color: PALETTE.warn, weight: 600 } }],
  });

  sb.beat({
    say: `Test that rule somewhere extreme: ${a} people to ${a * 10} people. Adding the difference gives ${qty + (a * 10 - a)} cups, but ten times the people must need ten times the flour. The additive rule collapses.`,
    show: [{ id: 'break', primitive: { kind: 'label', text: `${a} → ${a * 10} people: additive gives ${qty + (a * 10 - a)}, truth is ${qty * 10}`, x: 440, y: 150, size: 19, anchor: 'middle', color: PALETTE.warn } }],
  });

  sb.beat({
    say: `Proportional means a constant multiplier. From ${a} to ${b} people the factor is ${round2(factor)}.`,
    hide: ['wrong', 'break'],
    show: [{
      id: 'chart',
      primitive: {
        kind: 'barChart', x: 240, y: 200, width: 400, height: 160,
        bars: [
          { label: `${a} people`, value: qty, color: PALETTE.primary },
          { label: `${b} people`, value: right, color: PALETTE.good },
        ],
      },
    }],
  });

  sb.beat({
    say: `So multiply the flour by the same ${round2(factor)}: ${qty} times ${round2(factor)} is ${round2(right)} cups.`,
    show: [{ id: 'ans', primitive: { kind: 'label', text: `${qty} × ${round2(factor)} = ${round2(right)} cups`, x: 440, y: 416, size: 27, anchor: 'middle', color: PALETTE.good, weight: 700 } }],
  });

  return sb.build();
}

const round2 = (v: number): string => String(Math.round(v * 100) / 100);

/* --------------------------------- waves ---------------------------------- */

export function waveAnatomy(opts: Partial<AnimationRequest> = {}): Scene {
  const sb = new SceneBuilder({
    title: 'Anatomy of a wave',
    width: 880, height: 420, paceMultiplier: opts.paceMultiplier, reduceMotion: opts.reduceMotion,
    meta: { conceptSlug: 'waves' },
  });

  sb.backdrop({ kind: 'label', text: 'A wave carries energy, not matter', x: 440, y: 42, size: 27, anchor: 'middle', weight: 700 });
  sb.backdrop({ kind: 'line', x: 100, y: 220, x2: 800, y2: 220, stroke: PALETTE.grid, strokeWidth: 2, dashed: true }, 2);

  sb.beat({
    say: 'Here is a wave travelling to the right.',
    show: [{
      id: 'w',
      primitive: {
        kind: 'wave', x: 100, y: 220, width: 700, amplitude: 60, wavelength: 175, phase: 0,
        stroke: PALETTE.primary, strokeWidth: 4,
        describe: 'A sine wave with four repeats across the screen.',
      },
    }],
    animate: [{ target: 'w', channel: 'phase', from: 0, to: -Math.PI * 2, easing: 'linear' }],
  });

  sb.beat({
    say: 'Amplitude is how far the material moves from rest. Bigger amplitude means more energy.',
    show: [
      { id: 'amp', primitive: { kind: 'arrow', x: 140, y: 220, x2: 140, y2: 160, stroke: PALETTE.secondary, strokeWidth: 3, label: 'amplitude' } },
    ],
  });

  sb.beat({
    say: 'Wavelength is the distance from one repeat to the next.',
    show: [
      { id: 'wl', primitive: { kind: 'bracket', x: 187, y: 310, x2: 362, y2: 310, label: 'wavelength', stroke: PALETTE.tertiary, side: 'bottom' } },
    ],
  });

  sb.beat({
    say: 'Frequency counts how many repeats pass a point each second. Here the shape moves right, but the material only moves up and down - it never travels with the wave.',
    show: [
      { id: 'dot', primitive: { kind: 'particle', x: 450, y: 220, r: 9, color: PALETTE.warn, label: 'one particle' } },
    ],
    animate: [{ target: 'dot', channel: 'y', from: -58, to: 58, easing: 'ease' }],
  });

  sb.beat({
    say: 'Speed equals frequency times wavelength. That single relationship covers sound, light, and water waves alike.',
    show: [{ id: 'eq', primitive: { kind: 'label', text: 'v = f λ', x: 440, y: 388, size: 30, anchor: 'middle', color: PALETTE.good, weight: 700 } }],
  });

  return sb.build();
}

/* ------------------------------ balance model ----------------------------- */

export function equationBalance(a = 2, b = 3, c = 11, opts: Partial<AnimationRequest> = {}): Scene {
  const x = (c - b) / a;
  const sb = new SceneBuilder({
    title: `Solving ${a}x + ${b} = ${c} on a balance`,
    width: 880, height: 480, paceMultiplier: opts.paceMultiplier, reduceMotion: opts.reduceMotion,
    meta: { conceptSlug: 'linear-equations', params: { a, b, c, x } },
  });

  sb.backdrop({ kind: 'label', text: `${a}x + ${b} = ${c}`, x: 440, y: 44, size: 34, anchor: 'middle', weight: 700 });

  sb.beat({
    say: 'An equation is a balance. The two sides weigh exactly the same.',
    show: [{
      id: 'bal',
      primitive: {
        kind: 'balance', x: 440, y: 160, width: 420, tilt: 0,
        left: [{ label: `${a}x`, weight: a }, { label: `${b}`, weight: b }],
        right: [{ label: `${c}`, weight: c }],
        describe: `A balance scale with ${a}x plus ${b} on the left and ${c} on the right.`,
      },
    }],
  });

  sb.beat({
    say: `Take ${b} off the left pan. To keep it level you must take ${b} off the right pan too.`,
    show: [{ id: 'step1', primitive: { kind: 'label', text: `both sides − ${b}`, x: 440, y: 300, size: 22, anchor: 'middle', color: PALETTE.secondary, weight: 600 } }],
    animate: [{ target: 'bal', channel: 'tilt', from: 0, to: -4, span: 0.4, easing: 'ease' }, { target: 'bal', channel: 'tilt', from: -4, to: 0, delay: 0.5, easing: 'ease' }],
  });

  sb.beat({
    say: `Now the balance reads ${a}x equals ${c - b}.`,
    show: [{ id: 'step2', primitive: { kind: 'label', text: `${a}x = ${c - b}`, x: 440, y: 340, size: 27, anchor: 'middle', weight: 700 } }],
  });

  sb.beat({
    say: `There are ${a} identical x weights sharing ${c - b}, so each x is ${c - b} divided by ${a}, which is ${x}.`,
    show: [{ id: 'step3', primitive: { kind: 'label', text: `x = ${c - b} ÷ ${a} = ${x}`, x: 440, y: 384, size: 29, anchor: 'middle', color: PALETTE.good, weight: 700 } }],
  });

  sb.beat({
    say: `Always check: ${a} times ${x} is ${a * x}, plus ${b} is ${a * x + b}. It matches, so the balance really is level.`,
    show: [{ id: 'check', primitive: { kind: 'label', text: `check: ${a}(${x}) + ${b} = ${a * x + b} ✓`, x: 440, y: 426, size: 21, anchor: 'middle', color: PALETTE.muted } }],
  });

  return sb.build();
}

/* -------------------------------- registry -------------------------------- */

export type AnimationBuilder = (params: Record<string, unknown>, opts: Partial<AnimationRequest>) => Scene;

const num = (v: unknown, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const frac = (v: unknown, d: Fraction): Fraction => {
  if (typeof v === 'string') return parseFraction(v) ?? d;
  if (v && typeof v === 'object' && 'n' in (v as object)) return v as Fraction;
  return d;
};

export const ANIMATION_LIBRARY: Record<string, { label: string; builder: AnimationBuilder; params: string[] }> = {
  'fraction-addition': {
    label: 'Adding fractions with unlike denominators',
    params: ['a (e.g. "2/3")', 'b (e.g. "1/4")'],
    builder: (p, o) => fractionAddition(frac(p.a, { n: 2, d: 3 }), frac(p.b, { n: 1, d: 4 }), o),
  },
  fractions: {
    label: 'Comparing fractions',
    params: ['a', 'b'],
    builder: (p, o) => fractionCompare(frac(p.a, { n: 1, d: 3 }), frac(p.b, { n: 1, d: 8 }), o),
  },
  'equivalent-fractions': {
    label: 'Comparing fractions',
    params: ['a', 'b'],
    builder: (p, o) => fractionCompare(frac(p.a, { n: 2, d: 4 }), frac(p.b, { n: 1, d: 2 }), o),
  },
  integers: {
    label: 'Subtracting a negative on the number line',
    params: ['a', 'b'],
    builder: (p, o) => integerSubtraction(num(p.a, 5), num(p.b, -3), o),
  },
  'order-of-operations': {
    label: 'Why precedence changes the answer',
    params: ['expr'],
    builder: (p, o) => orderOfOperations(String(p.expr ?? '2 + 3 * 4'), o),
  },
  'newtons-third-law': { label: 'Action and reaction act on different objects', params: [], builder: (_p, o) => newtonsThirdLaw(o) },
  'newtons-first-law': { label: 'Force changes motion, it does not maintain it', params: [], builder: (_p, o) => newtonsFirstLaw(o) },
  forces: { label: 'Force changes motion, it does not maintain it', params: [], builder: (_p, o) => newtonsFirstLaw(o) },
  circuits: { label: 'Current is not used up', params: [], builder: (_p, o) => circuitCurrent(o) },
  'current-electricity': { label: 'Current is not used up', params: [], builder: (_p, o) => circuitCurrent(o) },
  seasons: { label: 'Seasons come from tilt, not distance', params: [], builder: (_p, o) => seasons(o) },
  photosynthesis: { label: 'Where a tree gets its mass', params: [], builder: (_p, o) => photosynthesis(o) },
  pythagoras: {
    label: 'Pythagoras by area',
    params: ['a', 'b'],
    builder: (p, o) => pythagoras(num(p.a, 3), num(p.b, 4), o),
  },
  'perimeter-area': {
    label: 'Perimeter versus area',
    params: ['w', 'h'],
    builder: (p, o) => areaVsPerimeter(num(p.w, 5), num(p.h, 3), o),
  },
  proportions: {
    label: 'Scaling multiplies, it does not add',
    params: ['a', 'b', 'qty'],
    builder: (p, o) => proportionalScaling(num(p.a, 2), num(p.b, 3), num(p.qty, 4), o),
  },
  ratios: {
    label: 'Scaling multiplies, it does not add',
    params: ['a', 'b', 'qty'],
    builder: (p, o) => proportionalScaling(num(p.a, 2), num(p.b, 3), num(p.qty, 4), o),
  },
  waves: { label: 'Anatomy of a wave', params: [], builder: (_p, o) => waveAnatomy(o) },
  sound: { label: 'Anatomy of a wave', params: [], builder: (_p, o) => waveAnatomy(o) },
  light: { label: 'Anatomy of a wave', params: [], builder: (_p, o) => waveAnatomy(o) },
  'linear-equations': {
    label: 'Solving an equation as a balance',
    params: ['a', 'b', 'c'],
    builder: (p, o) => equationBalance(num(p.a, 2), num(p.b, 3), num(p.c, 11), o),
  },
  variables: {
    label: 'Solving an equation as a balance',
    params: ['a', 'b', 'c'],
    builder: (p, o) => equationBalance(num(p.a, 2), num(p.b, 3), num(p.c, 11), o),
  },
};

export function hasAnimation(conceptSlug: string): boolean {
  return conceptSlug in ANIMATION_LIBRARY;
}

export function buildAnimation(req: AnimationRequest): Scene | null {
  const entry = ANIMATION_LIBRARY[req.conceptSlug];
  if (!entry) return null;
  return entry.builder(req.params ?? {}, req);
}

export function listAnimations(): { conceptSlug: string; label: string; params: string[] }[] {
  return Object.entries(ANIMATION_LIBRARY).map(([conceptSlug, v]) => ({
    conceptSlug, label: v.label, params: v.params,
  }));
}
