import { S, type JsonSchema } from '../../llm/jsonschema.js';
import { SceneBuilder, estimateHold, type Beat } from './compiler.js';
import {
  PALETTE, type Channel, type Easing, type PrimitiveKind, type PrimitiveProps, type Scene, type Vec2,
} from './primitives.js';
import { clamp, round } from '../../core/mathx.js';
import { slugify } from '../../core/textkit.js';

/** THE STORYBOARD CONTRACT
 *
 *  A model does not draw. It authors a storyboard - pedagogical beats made of
 *  named primitives - and the deterministic compiler turns that into a scene.
 *  That split matters: the model is good at deciding *what explains a concept*
 *  and bad at pixel geometry, so geometry stays in code where it can be
 *  validated, clamped and audited.
 *
 *  The schema is deliberately FLAT. Discriminated unions are the fastest way to
 *  get malformed output from a model, so every element is one object with
 *  optional fields, and the sanitizer below does the real translation. Complex
 *  structures use compact string encodings ("0,0 28,-10") for the same reason. */

export const PRIMITIVE_KINDS: PrimitiveKind[] = [
  'label', 'arrow', 'circle', 'rect', 'line', 'polygon',
  'numberLine', 'fractionBar', 'areaModel', 'barChart', 'axes', 'curve',
  'forceVector', 'particle', 'spring', 'wave', 'orbit', 'beam',
  'molecule', 'cell', 'timeline', 'bracket', 'angleArc', 'grid',
  'counter', 'highlight', 'balance',
];

export const ANIMATABLE_CHANNELS: Channel[] = [
  'x', 'y', 'opacity', 'rotate', 'scale', 'shaded', 'pointer',
  'phase', 'angleDeg', 'magnitude', 'value', 'tilt', 'amplitude',
];

const EASINGS: Easing[] = ['linear', 'ease', 'ease_in', 'ease_out', 'bounce', 'elastic'];

export const PALETTE_KEYS = Object.keys(PALETTE);

/* ------------------------------- the schema ------------------------------- */

const elementSchema: JsonSchema = S.obj({
  id: S.str('short unique id, lowercase, used to animate or hide this element later'),
  kind: S.enumOf(PRIMITIVE_KINDS as string[], 'which primitive to draw'),
  x: S.num('x position in canvas units'),
  y: S.num('y position in canvas units'),
  x2: S.num('end x, for arrow/line/spring/bracket/beam'),
  y2: S.num('end y, for arrow/line/spring/bracket/beam'),
  w: S.num('width, for rect/grid/highlight'),
  h: S.num('height, for rect/grid/highlight'),
  r: S.num('radius, for circle/particle/angleArc'),
  rx: S.num('x radius, for orbit/cell'),
  ry: S.num('y radius, for orbit/cell'),
  text: S.str('the text, for label'),
  label: S.str('a caption attached to this element'),
  size: S.num('font size, for label/counter'),
  anchor: S.enumOf(['start', 'middle', 'end'], 'text alignment, for label'),
  weight: S.num('font weight 400-700, for label'),
  color: S.enumOf(PALETTE_KEYS, 'palette colour name'),
  fill: S.enumOf([...PALETTE_KEYS, 'none'], 'palette fill name'),
  stroke: S.enumOf(PALETTE_KEYS, 'palette stroke name'),
  strokeWidth: S.num('line thickness'),
  dashed: S.bool('dashed line'),
  describe: S.str('one sentence describing this element for a learner who cannot see it'),

  parts: S.int('number of equal parts, for fractionBar'),
  shaded: S.num('how many parts are shaded, for fractionBar'),
  showLabels: S.bool('label each part, for fractionBar'),
  width: S.num('width, for numberLine/fractionBar/barChart/axes/wave/timeline'),
  height: S.num('height, for fractionBar/barChart/axes'),
  min: S.num('lowest value, for numberLine/timeline'),
  max: S.num('highest value, for numberLine/timeline'),
  step: S.num('tick spacing, for numberLine'),
  pointer: S.num('value to point at, for numberLine'),
  marks: S.str('numberLine marks as "value:label, value:label"'),

  rows: S.int('rows, for areaModel'),
  cols: S.int('columns, for areaModel'),
  cell: S.num('cell size in px, for areaModel'),
  shadedRows: S.int('shaded rows, for areaModel'),
  shadedCols: S.int('shaded columns, for areaModel'),

  bars: S.str('barChart bars as "label:value, label:value"'),
  points: S.str('polygon or curve points as "x,y x,y x,y"'),
  closed: S.bool('close the curve'),

  xMin: S.num('axes x minimum'), xMax: S.num('axes x maximum'),
  yMin: S.num('axes y minimum'), yMax: S.num('axes y maximum'),
  xLabel: S.str('axes x label'), yLabel: S.str('axes y label'),

  magnitude: S.num('force size, for forceVector'),
  angleDeg: S.num('angle in degrees, for forceVector/orbit/angleArc'),
  startDeg: S.num('arc start angle, for angleArc'),
  endDeg: S.num('arc end angle, for angleArc'),
  charge: S.enumOf(['+', '-', 'neutral'], 'particle charge'),
  amplitude: S.num('wave amplitude'),
  wavelength: S.num('wave wavelength'),
  phase: S.num('wave phase in radians'),
  coils: S.int('spring coils'),
  rays: S.int('number of rays, for beam'),
  spread: S.num('ray spacing, for beam'),

  atoms: S.str('molecule atoms as "C:0,0 O:-28,0 O:28,0" (element:x,y)'),
  bonds: S.str('molecule bonds as "0-1:2 0-2:1" (fromIndex-toIndex:order)'),
  organelles: S.str('cell organelles as "nucleus:-60,-20,30 chloroplast:70,30,26" (label:x,y,r)'),
  events: S.str('timeline events as "1905:special relativity, 1915:general relativity"'),
  left: S.str('balance left pan as "2x:2, 3:3" (label:weight)'),
  right: S.str('balance right pan as "11:11"'),
  tilt: S.num('balance tilt in degrees'),

  value: S.num('the number shown, for counter'),
  decimals: S.int('decimal places, for counter'),
  prefix: S.str('text before the number, for counter'),
  suffix: S.str('text after the number, for counter'),
  radius: S.num('corner radius, for rect/highlight'),
  opacity: S.num('0 to 1'),
}, ['id', 'kind']);

const animationSchema: JsonSchema = S.obj({
  target: S.str('id of an element shown in this beat or an earlier one'),
  channel: S.enumOf(ANIMATABLE_CHANNELS as string[], 'what to change over time'),
  from: S.num('starting value (optional - defaults to the element\'s current value)'),
  to: S.num('ending value'),
  easing: S.enumOf(EASINGS as string[]),
  delay: S.num('fraction of the beat to wait first, 0 to 0.9'),
  span: S.num('fraction of the beat the motion occupies, 0.05 to 1'),
}, ['target', 'channel', 'to']);

const beatSchema: JsonSchema = S.obj({
  say: S.str('the narration for this beat: one or two short spoken sentences'),
  hold: S.num('seconds this beat lasts (optional - derived from the narration if omitted)'),
  show: S.arr(elementSchema, 'elements introduced in this beat'),
  hide: S.arr(S.str('element id'), 'elements removed at the end of this beat'),
  animate: S.arr(animationSchema, 'motion during this beat'),
}, ['say']);

export const STORYBOARD_SCHEMA: JsonSchema = S.obj({
  title: S.str('short title for the whole animation'),
  goal: S.str('what the learner should be able to say afterwards'),
  misconception: S.str('the wrong idea this animation attacks, or empty string'),
  width: S.int('canvas width, 700 to 1000'),
  height: S.int('canvas height, 360 to 620'),
  beats: S.arr(beatSchema, 'the sequence of teaching beats, 3 to 8 of them', { minItems: 3, maxItems: 8 }),
}, ['title', 'goal', 'beats']);

/* -------------------------------- the types ------------------------------- */

export interface ElementSpec extends Record<string, unknown> {
  id: string;
  kind: string;
}

export interface AnimationSpec {
  target: string;
  channel: string;
  from?: number;
  to: number;
  easing?: string;
  delay?: number;
  span?: number;
}

export interface BeatSpec {
  say: string;
  hold?: number;
  show?: ElementSpec[];
  hide?: string[];
  animate?: AnimationSpec[];
}

export interface Storyboard {
  title: string;
  goal: string;
  misconception?: string;
  width?: number;
  height?: number;
  beats: BeatSpec[];
}

export interface SanitizeResult {
  beats: Beat[];
  width: number;
  height: number;
  title: string;
  goal: string;
  misconception?: string;
  /** Every change made to the model's output, so nothing is silently rewritten. */
  repairs: string[];
  /** Elements and animations dropped entirely, with the reason. */
  rejected: string[];
}

/* ------------------------------ compact parsers --------------------------- */

const numOr = (v: unknown, d: number): number => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^\d.eE+-]/g, ''));
  return Number.isFinite(n) ? n : d;
};

/** "x,y x,y x,y" -> points */
export function parsePoints(raw: unknown): Vec2[] {
  if (Array.isArray(raw)) {
    return raw.map((p) => (typeof p === 'object' && p
      ? { x: numOr((p as Vec2).x, 0), y: numOr((p as Vec2).y, 0) }
      : { x: 0, y: 0 }));
  }
  if (typeof raw !== 'string') return [];
  return raw.split(/\s+/).map((pair) => {
    const [x, y] = pair.split(',');
    return { x: numOr(x, NaN), y: numOr(y, NaN) };
  }).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
}

/** "label:value, label:value" -> entries */
export function parsePairs(raw: unknown): { label: string; value: number }[] {
  if (typeof raw !== 'string') return [];
  return raw.split(/\s*[,;]\s*/).map((chunk) => {
    const idx = chunk.lastIndexOf(':');
    if (idx < 0) return null;
    const label = chunk.slice(0, idx).trim();
    const value = numOr(chunk.slice(idx + 1), NaN);
    return label && Number.isFinite(value) ? { label, value } : null;
  }).filter(Boolean) as { label: string; value: number }[];
}

/** "El:x,y El:x,y" -> atoms */
export function parseAtoms(raw: unknown): { el: string; x: number; y: number }[] {
  if (typeof raw !== 'string') return [];
  return raw.split(/\s+/).map((chunk) => {
    const m = chunk.match(/^([A-Z][a-z]?):(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
    return m ? { el: m[1], x: Number(m[2]), y: Number(m[3]) } : null;
  }).filter(Boolean) as { el: string; x: number; y: number }[];
}

/** "0-1:2 0-2:1" -> bonds */
export function parseBonds(raw: unknown, atomCount: number): { from: number; to: number; order?: 1 | 2 | 3 }[] {
  if (typeof raw !== 'string') return [];
  return raw.split(/\s+/).map((chunk) => {
    const m = chunk.match(/^(\d+)-(\d+)(?::([123]))?$/);
    if (!m) return null;
    const from = Number(m[1]);
    const to = Number(m[2]);
    if (from >= atomCount || to >= atomCount || from === to) return null;
    return { from, to, order: (m[3] ? Number(m[3]) : 1) as 1 | 2 | 3 };
  }).filter(Boolean) as { from: number; to: number; order?: 1 | 2 | 3 }[];
}

/** "label:x,y,r label:x,y,r" -> organelles */
export function parseOrganelles(raw: unknown): { kind: string; x: number; y: number; r: number; label: string }[] {
  if (typeof raw !== 'string') return [];
  return raw.split(/\s+/).map((chunk) => {
    const m = chunk.match(/^([\w-]+):(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/);
    return m ? { kind: m[1], label: m[1].replace(/[-_]/g, ' '), x: Number(m[2]), y: Number(m[3]), r: Number(m[4]) } : null;
  }).filter(Boolean) as { kind: string; x: number; y: number; r: number; label: string }[];
}

/** "value:label, value:label" -> number line marks / timeline events */
export function parseValueLabels(raw: unknown): { value: number; label: string }[] {
  if (typeof raw !== 'string') return [];
  return raw.split(/\s*[,;]\s*/).map((chunk) => {
    const idx = chunk.indexOf(':');
    if (idx < 0) return null;
    const value = numOr(chunk.slice(0, idx), NaN);
    const label = chunk.slice(idx + 1).trim();
    return Number.isFinite(value) ? { value, label } : null;
  }).filter(Boolean) as { value: number; label: string }[];
}

/* ---------------------------- element translation ------------------------- */

const colour = (v: unknown, fallback?: string): string | undefined => {
  if (typeof v !== 'string' || !v) return fallback;
  if (v === 'none') return 'none';
  return PALETTE[v] ? v : fallback;      // palette key, resolved at render time
};

/** Required props per kind. Anything missing is supplied, not guessed wildly. */
export function toPrimitive(
  spec: ElementSpec,
  canvas: { width: number; height: number },
  repairs: string[],
): PrimitiveProps | null {
  const kind = spec.kind as PrimitiveKind;
  if (!PRIMITIVE_KINDS.includes(kind)) return null;

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const px = (v: unknown, d: number) => clamp(numOr(v, d), -200, canvas.width + 200);
  const py = (v: unknown, d: number) => clamp(numOr(v, d), -200, canvas.height + 200);

  const base = {
    id: spec.id,
    x: px(spec.x, cx),
    y: py(spec.y, cy),
    color: colour(spec.color),
    fill: colour(spec.fill),
    stroke: colour(spec.stroke),
    strokeWidth: spec.strokeWidth !== undefined ? clamp(numOr(spec.strokeWidth, 2), 0.5, 10) : undefined,
    opacity: spec.opacity !== undefined ? clamp(numOr(spec.opacity, 1)) : undefined,
    describe: typeof spec.describe === 'string' ? spec.describe : undefined,
  };

  const need = (field: string, value: number | undefined, fallback: number): number => {
    if (value === undefined || !Number.isFinite(value)) {
      repairs.push(`${spec.id} (${kind}): missing "${field}", defaulted to ${fallback}`);
      return fallback;
    }
    return value;
  };

  switch (kind) {
    case 'label': {
      const text = typeof spec.text === 'string' && spec.text.trim()
        ? spec.text.trim()
        : (typeof spec.label === 'string' ? spec.label : '');
      if (!text) return null;
      return {
        kind, ...base, text,
        size: clamp(numOr(spec.size, 18), 10, 48),
        anchor: (['start', 'middle', 'end'] as const).includes(spec.anchor as 'start')
          ? (spec.anchor as 'start' | 'middle' | 'end') : 'start',
        weight: clamp(numOr(spec.weight, 500), 300, 800),
      };
    }
    case 'arrow':
      return {
        kind, ...base,
        x2: px(spec.x2, base.x + 90), y2: py(spec.y2, base.y),
        head: clamp(numOr(spec.r, 9), 4, 20),
        dashed: spec.dashed === true,
        label: typeof spec.label === 'string' ? spec.label : undefined,
      };
    case 'line':
      return { kind, ...base, x2: px(spec.x2, base.x + 90), y2: py(spec.y2, base.y), dashed: spec.dashed === true };
    case 'circle':
      return {
        kind, ...base,
        r: clamp(need('r', spec.r === undefined ? undefined : numOr(spec.r, NaN), 24), 2, 260),
        label: typeof spec.label === 'string' ? spec.label : undefined,
      };
    case 'particle':
      return {
        kind, ...base,
        r: clamp(numOr(spec.r, 9), 2, 40),
        charge: (['+', '-', 'neutral'] as const).includes(spec.charge as '+') ? (spec.charge as '+' | '-' | 'neutral') : undefined,
        label: typeof spec.label === 'string' ? spec.label : undefined,
      };
    case 'rect':
    case 'highlight': {
      const w = clamp(need('w', spec.w === undefined ? undefined : numOr(spec.w, NaN), 120), 4, canvas.width);
      const h = clamp(need('h', spec.h === undefined ? undefined : numOr(spec.h, NaN), 60), 4, canvas.height);
      if (kind === 'highlight') return { kind, ...base, w, h, radius: clamp(numOr(spec.radius, 6), 0, 40) };
      return {
        kind, ...base, w, h,
        radius: clamp(numOr(spec.radius, 4), 0, 40),
        label: typeof spec.label === 'string' ? spec.label : undefined,
      };
    }
    case 'grid':
      return {
        kind, ...base,
        w: clamp(numOr(spec.w, 300), 20, canvas.width),
        h: clamp(numOr(spec.h, 300), 20, canvas.height),
        cell: clamp(numOr(spec.cell, 30), 6, 120),
      };
    case 'polygon': {
      const points = parsePoints(spec.points);
      if (points.length < 3) {
        repairs.push(`${spec.id} (polygon): fewer than 3 points, dropped`);
        return null;
      }
      return { kind, ...base, points, label: typeof spec.label === 'string' ? spec.label : undefined };
    }
    case 'curve': {
      const points = parsePoints(spec.points);
      if (points.length < 2) {
        repairs.push(`${spec.id} (curve): fewer than 2 points, dropped`);
        return null;
      }
      return {
        kind, ...base, points,
        closed: spec.closed === true,
        label: typeof spec.label === 'string' ? spec.label : undefined,
      };
    }
    case 'numberLine': {
      const min = numOr(spec.min, 0);
      const max = numOr(spec.max, min + 10);
      const span = max - min || 1;
      let step = numOr(spec.step, span / 10);
      // A step that would draw hundreds of ticks is the most common model slip.
      if (!Number.isFinite(step) || step <= 0 || span / step > 80) {
        const fixed = span / 10;
        repairs.push(`${spec.id} (numberLine): step ${step} would draw ${Math.round(span / Math.max(step, 1e-6))} ticks, set to ${round(fixed, 4)}`);
        step = fixed;
      }
      return {
        kind, ...base,
        min, max: max > min ? max : min + 10, step,
        width: clamp(numOr(spec.width, canvas.width * 0.7), 100, canvas.width - 40),
        marks: parseValueLabels(spec.marks).map((m) => ({ value: m.value, label: m.label })),
        pointer: spec.pointer !== undefined ? numOr(spec.pointer, min) : undefined,
      };
    }
    case 'fractionBar': {
      const parts = clamp(Math.round(numOr(spec.parts, 4)), 1, 36);
      return {
        kind, ...base,
        parts,
        shaded: clamp(numOr(spec.shaded, 0), 0, parts),
        width: clamp(numOr(spec.width, 300), 60, canvas.width - 40),
        height: clamp(numOr(spec.height, 60), 20, 160),
        label: typeof spec.label === 'string' ? spec.label : undefined,
        showLabels: spec.showLabels === true && parts <= 12,
      };
    }
    case 'areaModel': {
      const rows = clamp(Math.round(numOr(spec.rows, 3)), 1, 24);
      const cols = clamp(Math.round(numOr(spec.cols, 3)), 1, 24);
      return {
        kind, ...base, rows, cols,
        cell: clamp(numOr(spec.cell, 30), 8, 70),
        shadedRows: spec.shadedRows !== undefined ? clamp(Math.round(numOr(spec.shadedRows, 0)), 0, rows) : undefined,
        shadedCols: spec.shadedCols !== undefined ? clamp(Math.round(numOr(spec.shadedCols, 0)), 0, cols) : undefined,
        label: typeof spec.label === 'string' ? spec.label : undefined,
      };
    }
    case 'barChart': {
      const bars = parsePairs(spec.bars);
      if (!bars.length) {
        repairs.push(`${spec.id} (barChart): no parseable bars, dropped`);
        return null;
      }
      return {
        kind, ...base,
        bars: bars.slice(0, 10).map((b) => ({ label: b.label, value: b.value })),
        width: clamp(numOr(spec.width, 360), 120, canvas.width - 40),
        height: clamp(numOr(spec.height, 180), 60, canvas.height - 80),
      };
    }
    case 'axes':
      return {
        kind, ...base,
        width: clamp(numOr(spec.width, 360), 120, canvas.width - 60),
        height: clamp(numOr(spec.height, 240), 80, canvas.height - 80),
        xMin: numOr(spec.xMin, 0), xMax: numOr(spec.xMax, 10),
        yMin: numOr(spec.yMin, 0), yMax: numOr(spec.yMax, 10),
        xLabel: typeof spec.xLabel === 'string' ? spec.xLabel : undefined,
        yLabel: typeof spec.yLabel === 'string' ? spec.yLabel : undefined,
        xTicks: clamp(Math.round(numOr(spec.cols, 5)), 2, 12),
        yTicks: clamp(Math.round(numOr(spec.rows, 5)), 2, 12),
      };
    case 'forceVector':
      return {
        kind, ...base,
        magnitude: clamp(numOr(spec.magnitude, 4), 0.1, 40),
        angleDeg: numOr(spec.angleDeg, 0),
        label: typeof spec.label === 'string' ? spec.label : undefined,
        scalePxPerUnit: 18,
      };
    case 'spring':
      return {
        kind, ...base,
        x2: px(spec.x2, base.x + 120), y2: py(spec.y2, base.y),
        coils: clamp(Math.round(numOr(spec.coils, 8)), 3, 20),
        amplitude: clamp(numOr(spec.amplitude, 12), 2, 40),
      };
    case 'wave':
      return {
        kind, ...base,
        width: clamp(numOr(spec.width, canvas.width * 0.72), 100, canvas.width - 40),
        amplitude: clamp(numOr(spec.amplitude, 50), 4, canvas.height / 3),
        wavelength: clamp(numOr(spec.wavelength, 160), 20, canvas.width),
        phase: numOr(spec.phase, 0),
      };
    case 'orbit':
      return {
        kind, ...base,
        rx: clamp(numOr(spec.rx, 160), 20, canvas.width / 2),
        ry: clamp(numOr(spec.ry, 90), 10, canvas.height / 2),
        bodyR: clamp(numOr(spec.r, 14), 3, 50),
        angleDeg: numOr(spec.angleDeg, 0),
      };
    case 'beam':
      return {
        kind, ...base,
        x2: px(spec.x2, base.x + 180), y2: py(spec.y2, base.y),
        rays: clamp(Math.round(numOr(spec.rays, 3)), 1, 9),
        spread: clamp(numOr(spec.spread, 14), 4, 60),
      };
    case 'molecule': {
      const atoms = parseAtoms(spec.atoms);
      if (!atoms.length) {
        repairs.push(`${spec.id} (molecule): no parseable atoms, dropped`);
        return null;
      }
      return {
        kind, ...base,
        atoms: atoms.slice(0, 20),
        bonds: parseBonds(spec.bonds, Math.min(atoms.length, 20)),
        label: typeof spec.label === 'string' ? spec.label : undefined,
      };
    }
    case 'cell':
      return {
        kind, ...base,
        rx: clamp(numOr(spec.rx, 170), 40, canvas.width / 2),
        ry: clamp(numOr(spec.ry, 110), 30, canvas.height / 2),
        organelles: parseOrganelles(spec.organelles).slice(0, 10),
      };
    case 'timeline': {
      const events = parseValueLabels(spec.events);
      if (!events.length) {
        repairs.push(`${spec.id} (timeline): no parseable events, dropped`);
        return null;
      }
      const values = events.map((e) => e.value);
      return {
        kind, ...base,
        width: clamp(numOr(spec.width, canvas.width * 0.75), 120, canvas.width - 40),
        events: events.slice(0, 8).map((e) => ({ at: e.value, label: e.label })),
        min: numOr(spec.min, Math.min(...values)),
        max: numOr(spec.max, Math.max(...values)) || Math.min(...values) + 1,
      };
    }
    case 'bracket':
      return {
        kind, ...base,
        x2: px(spec.x2, base.x + 140), y2: py(spec.y2, base.y),
        label: typeof spec.label === 'string' ? spec.label : undefined,
        side: 'bottom',
      };
    case 'angleArc':
      return {
        kind, ...base,
        r: clamp(numOr(spec.r, 44), 10, 160),
        startDeg: numOr(spec.startDeg, 0),
        endDeg: numOr(spec.endDeg, 60),
        label: typeof spec.label === 'string' ? spec.label : undefined,
      };
    case 'counter':
      return {
        kind, ...base,
        value: numOr(spec.value, 0),
        size: clamp(numOr(spec.size, 32), 14, 64),
        decimals: clamp(Math.round(numOr(spec.decimals, 0)), 0, 4),
        prefix: typeof spec.prefix === 'string' ? spec.prefix : undefined,
        suffix: typeof spec.suffix === 'string' ? spec.suffix : undefined,
      };
    case 'balance':
      return {
        kind, ...base,
        width: clamp(numOr(spec.width, 400), 120, canvas.width - 60),
        tilt: clamp(numOr(spec.tilt, 0), -20, 20),
        left: parsePairs(spec.left).map((p) => ({ label: p.label, weight: p.value })),
        right: parsePairs(spec.right).map((p) => ({ label: p.label, weight: p.value })),
      };
    default:
      return null;
  }
}

/* -------------------------------- sanitize -------------------------------- */

export interface SanitizeOptions {
  maxBeats?: number;
  maxElementsPerBeat?: number;
  maxTotalSeconds?: number;
  maxWordsPerBeat?: number;
}

/** Validate, repair and clamp a model-authored storyboard into something the
 *  compiler can build. Nothing here trusts the model: ids are made unique,
 *  animation targets must exist, geometry is clamped to the canvas, and every
 *  change is recorded so the result is auditable rather than mysterious. */
export function sanitizeStoryboard(raw: unknown, opts: SanitizeOptions = {}): SanitizeResult {
  const repairs: string[] = [];
  const rejected: string[] = [];
  const sb = (raw ?? {}) as Partial<Storyboard>;

  const width = clamp(Math.round(numOr(sb.width, 900)), 600, 1100);
  const height = clamp(Math.round(numOr(sb.height, 520)), 320, 680);
  const canvas = { width, height };

  const title = typeof sb.title === 'string' && sb.title.trim() ? sb.title.trim().slice(0, 120) : 'Explanation';
  const goal = typeof sb.goal === 'string' ? sb.goal.trim().slice(0, 300) : '';
  const misconception = typeof sb.misconception === 'string' && sb.misconception.trim()
    ? sb.misconception.trim().slice(0, 300) : undefined;

  const maxBeats = opts.maxBeats ?? 8;
  const maxElements = opts.maxElementsPerBeat ?? 8;
  const maxWords = opts.maxWordsPerBeat ?? 45;

  const rawBeats = Array.isArray(sb.beats) ? sb.beats : [];
  if (!rawBeats.length) rejected.push('storyboard contained no beats');
  if (rawBeats.length > maxBeats) repairs.push(`${rawBeats.length} beats trimmed to ${maxBeats}`);

  const knownIds = new Set<string>();
  const usedIds = new Set<string>();
  const beats: Beat[] = [];

  for (const [bi, rb] of rawBeats.slice(0, maxBeats).entries()) {
    const say = typeof rb?.say === 'string' ? rb.say.trim().replace(/\s+/g, ' ') : '';
    if (!say) {
      rejected.push(`beat ${bi + 1} dropped: no narration, which would leave it inaccessible without sight`);
      continue;
    }
    let narration = say;
    const words = narration.split(/\s+/);
    if (words.length > maxWords) {
      narration = `${words.slice(0, maxWords).join(' ')}…`;
      repairs.push(`beat ${bi + 1}: narration trimmed from ${words.length} to ${maxWords} words`);
    }

    const show: NonNullable<Beat['show']> = [];
    for (const el of (Array.isArray(rb.show) ? rb.show : []).slice(0, maxElements)) {
      if (!el || typeof el !== 'object') continue;
      let id = typeof el.id === 'string' && el.id.trim() ? slugify(el.id).slice(0, 32) : '';
      if (!id) id = `el${bi}_${show.length}`;
      if (usedIds.has(id)) {
        const unique = `${id}_${bi}${show.length}`;
        repairs.push(`duplicate element id "${id}" renamed to "${unique}"`);
        id = unique;
      }
      const primitive = toPrimitive({ ...(el as ElementSpec), id }, canvas, repairs);
      if (!primitive) {
        rejected.push(`beat ${bi + 1}: element "${el.id ?? '?'}" of kind "${el.kind ?? '?'}" could not be built`);
        continue;
      }
      usedIds.add(id);
      knownIds.add(id);
      show.push({ primitive, id, layer: 10 + show.length });
    }
    if ((Array.isArray(rb.show) ? rb.show.length : 0) > maxElements) {
      repairs.push(`beat ${bi + 1}: ${rb.show!.length} elements trimmed to ${maxElements}`);
    }

    const hide = (Array.isArray(rb.hide) ? rb.hide : [])
      .filter((h): h is string => typeof h === 'string')
      .map((h) => slugify(h).slice(0, 32))
      .filter((h) => {
        if (knownIds.has(h)) return true;
        rejected.push(`beat ${bi + 1}: cannot hide unknown element "${h}"`);
        return false;
      });

    const animate: NonNullable<Beat['animate']> = [];
    for (const a of (Array.isArray(rb.animate) ? rb.animate : [])) {
      if (!a || typeof a !== 'object') continue;
      const target = typeof a.target === 'string' ? slugify(a.target).slice(0, 32) : '';
      if (!knownIds.has(target)) {
        rejected.push(`beat ${bi + 1}: animation targets unknown element "${a.target ?? '?'}"`);
        continue;
      }
      const channel = a.channel as Channel;
      if (!ANIMATABLE_CHANNELS.includes(channel)) {
        rejected.push(`beat ${bi + 1}: "${String(a.channel)}" is not an animatable channel`);
        continue;
      }
      const to = numOr(a.to, NaN);
      if (!Number.isFinite(to)) {
        rejected.push(`beat ${bi + 1}: animation of "${target}.${channel}" has no finite target value`);
        continue;
      }
      animate.push({
        target,
        channel,
        ...(a.from !== undefined && Number.isFinite(numOr(a.from, NaN)) ? { from: numOr(a.from, 0) } : {}),
        to: channel === 'opacity' || channel === 'scale' ? clamp(to, 0, 3) : to,
        easing: EASINGS.includes(a.easing as Easing) ? (a.easing as Easing) : 'ease',
        delay: clamp(numOr(a.delay, 0), 0, 0.9),
        span: clamp(numOr(a.span, 1), 0.05, 1),
      });
    }

    const hold = rb.hold !== undefined && Number.isFinite(numOr(rb.hold, NaN))
      ? clamp(numOr(rb.hold, 4), 1.2, 20)
      : estimateHold(narration);

    beats.push({ say: narration, hold, show, hide, animate });
  }

  // Global duration ceiling: attention, not aesthetics.
  const maxTotal = opts.maxTotalSeconds ?? 110;
  const total = beats.reduce((a, b) => a + (b.hold ?? 0), 0);
  if (total > maxTotal) {
    const scale = maxTotal / total;
    for (const b of beats) b.hold = Math.max(1.2, round((b.hold ?? 4) * scale, 2));
    repairs.push(`total runtime ${round(total, 1)}s compressed to ${maxTotal}s to stay inside the attention budget`);
  }

  return { beats, width, height, title, goal, misconception, repairs, rejected };
}

/** Build a Scene from a sanitized storyboard. */
export function compileStoryboard(
  s: SanitizeResult,
  opts: { paceMultiplier?: number; reduceMotion?: boolean; background?: string; meta?: Record<string, unknown> } = {},
): Scene {
  const builder = new SceneBuilder({
    title: s.title,
    width: s.width,
    height: s.height,
    paceMultiplier: opts.paceMultiplier,
    reduceMotion: opts.reduceMotion,
    background: opts.background,
    meta: {
      ...(opts.meta ?? {}),
      goal: s.goal,
      misconception: s.misconception,
      repairs: s.repairs.length,
      rejected: s.rejected.length,
    },
  });
  for (const beat of s.beats) builder.beat(beat);
  return builder.build();
}
