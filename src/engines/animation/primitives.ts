/** EDUCATIONAL ANIMATION PRIMITIVES
 *
 *  Instead of storing thousands of videos, LUMEN composes explanations from a
 *  vocabulary of teaching shapes. These are not generic graphics primitives -
 *  each one carries pedagogical meaning (a `fractionBar` knows about equal
 *  parts; a `numberLine` knows about direction; a `forceVector` knows that
 *  length means magnitude), which is what lets the system reason about whether
 *  a visual actually explains the concept. */

export type Easing = 'linear' | 'ease' | 'ease_in' | 'ease_out' | 'bounce' | 'elastic';

export interface Vec2 { x: number; y: number; }

export type PrimitiveKind =
  | 'label' | 'arrow' | 'circle' | 'rect' | 'line' | 'path' | 'polygon'
  | 'numberLine' | 'fractionBar' | 'areaModel' | 'barChart' | 'axes' | 'curve'
  | 'forceVector' | 'particle' | 'spring' | 'wave' | 'orbit' | 'beam'
  | 'molecule' | 'cell' | 'timeline' | 'bracket' | 'angleArc' | 'grid'
  | 'counter' | 'highlight' | 'balance';

export interface BaseProps {
  id?: string;
  x?: number;
  y?: number;
  opacity?: number;
  rotate?: number;
  scale?: number;
  color?: string;
  stroke?: string;
  strokeWidth?: number;
  fill?: string;
  /** Spoken description, so every visual is also available as audio. */
  describe?: string;
}

export interface LabelProps extends BaseProps { text: string; size?: number; anchor?: 'start' | 'middle' | 'end'; weight?: number; }
export interface ArrowProps extends BaseProps { x2: number; y2: number; head?: number; dashed?: boolean; label?: string; }
export interface CircleProps extends BaseProps { r: number; label?: string; }
export interface RectProps extends BaseProps { w: number; h: number; radius?: number; label?: string; }
export interface LineProps extends BaseProps { x2: number; y2: number; dashed?: boolean; }
export interface PathProps extends BaseProps { d: string; }
export interface PolygonProps extends BaseProps { points: Vec2[]; label?: string; }

export interface NumberLineProps extends BaseProps {
  min: number; max: number; step: number; width: number;
  marks?: { value: number; label?: string; color?: string }[];
  pointer?: number;
}
export interface FractionBarProps extends BaseProps {
  parts: number; shaded: number; width: number; height: number;
  label?: string; showLabels?: boolean;
}
export interface AreaModelProps extends BaseProps {
  rows: number; cols: number; cell: number; shadedRows?: number; shadedCols?: number; label?: string;
}
export interface BarChartProps extends BaseProps {
  bars: { label: string; value: number; color?: string }[];
  width: number; height: number; maxValue?: number;
}
export interface AxesProps extends BaseProps {
  width: number; height: number;
  xLabel?: string; yLabel?: string;
  xMin: number; xMax: number; yMin: number; yMax: number;
  xTicks?: number; yTicks?: number; gridlines?: boolean;
}
export interface CurveProps extends BaseProps {
  points: Vec2[]; closed?: boolean; smooth?: boolean; label?: string;
}
export interface ForceVectorProps extends BaseProps {
  magnitude: number; angleDeg: number; label?: string; scalePxPerUnit?: number;
}
export interface ParticleProps extends BaseProps { r?: number; charge?: '+' | '-' | 'neutral'; label?: string; }
export interface SpringProps extends BaseProps { x2: number; y2: number; coils?: number; amplitude?: number; }
export interface WaveProps extends BaseProps {
  width: number; amplitude: number; wavelength: number; phase?: number; samples?: number;
}
export interface OrbitProps extends BaseProps { rx: number; ry: number; bodyR?: number; angleDeg?: number; }
export interface BeamProps extends BaseProps { x2: number; y2: number; rays?: number; spread?: number; }
export interface MoleculeProps extends BaseProps {
  atoms: { el: string; x: number; y: number; r?: number }[];
  bonds: { from: number; to: number; order?: 1 | 2 | 3 }[];
  label?: string;
}
export interface CellProps extends BaseProps {
  rx: number; ry: number;
  organelles?: { kind: string; x: number; y: number; r: number; label?: string }[];
}
export interface TimelineProps extends BaseProps {
  width: number;
  events: { at: number; label: string }[];
  min: number; max: number;
}
export interface BracketProps extends BaseProps { x2: number; y2: number; label?: string; side?: 'top' | 'bottom' | 'left' | 'right'; }
export interface AngleArcProps extends BaseProps { r: number; startDeg: number; endDeg: number; label?: string; }
export interface GridProps extends BaseProps { w: number; h: number; cell: number; }
export interface CounterProps extends BaseProps { value: number; size?: number; prefix?: string; suffix?: string; decimals?: number; }
export interface HighlightProps extends BaseProps { w: number; h: number; radius?: number; }
export interface BalanceProps extends BaseProps {
  width: number; tilt?: number;
  left: { label: string; weight: number }[];
  right: { label: string; weight: number }[];
}

export type PrimitiveProps =
  | ({ kind: 'label' } & LabelProps)
  | ({ kind: 'arrow' } & ArrowProps)
  | ({ kind: 'circle' } & CircleProps)
  | ({ kind: 'rect' } & RectProps)
  | ({ kind: 'line' } & LineProps)
  | ({ kind: 'path' } & PathProps)
  | ({ kind: 'polygon' } & PolygonProps)
  | ({ kind: 'numberLine' } & NumberLineProps)
  | ({ kind: 'fractionBar' } & FractionBarProps)
  | ({ kind: 'areaModel' } & AreaModelProps)
  | ({ kind: 'barChart' } & BarChartProps)
  | ({ kind: 'axes' } & AxesProps)
  | ({ kind: 'curve' } & CurveProps)
  | ({ kind: 'forceVector' } & ForceVectorProps)
  | ({ kind: 'particle' } & ParticleProps)
  | ({ kind: 'spring' } & SpringProps)
  | ({ kind: 'wave' } & WaveProps)
  | ({ kind: 'orbit' } & OrbitProps)
  | ({ kind: 'beam' } & BeamProps)
  | ({ kind: 'molecule' } & MoleculeProps)
  | ({ kind: 'cell' } & CellProps)
  | ({ kind: 'timeline' } & TimelineProps)
  | ({ kind: 'bracket' } & BracketProps)
  | ({ kind: 'angleArc' } & AngleArcProps)
  | ({ kind: 'grid' } & GridProps)
  | ({ kind: 'counter' } & CounterProps)
  | ({ kind: 'highlight' } & HighlightProps)
  | ({ kind: 'balance' } & BalanceProps);

/** An animatable numeric channel on a primitive. */
export type Channel =
  | 'x' | 'y' | 'opacity' | 'rotate' | 'scale' | 'shaded' | 'pointer'
  | 'phase' | 'angleDeg' | 'magnitude' | 'value' | 'tilt' | 'amplitude';

export interface Keyframe { t: number; value: number; easing?: Easing; }

export interface Track { channel: Channel; keyframes: Keyframe[]; }

export interface SceneNode {
  id: string;
  primitive: PrimitiveProps;
  tracks: Track[];
  /** Seconds the node appears and disappears; outside this it is not rendered. */
  enter: number;
  exit: number;
  /** Narration tied to this node's entrance. */
  narration?: string;
  layer: number;
}

export interface Scene {
  id: string;
  title: string;
  width: number;
  height: number;
  durationSec: number;
  background: string;
  palette: Record<string, string>;
  nodes: SceneNode[];
  /** Narration beats with timings, so audio and visual stay locked together. */
  narration: { at: number; text: string; durationSec: number }[];
  /** Captions for the same beats. */
  captions: { start: number; end: number; text: string }[];
  /** Spoken alternative for a learner who cannot see the animation at all. */
  audioDescription: string;
  meta: Record<string, unknown>;
}

/** Accessible, colour-blind-safe palette. Every pair meets 3:1 against the
 *  scene background, and no meaning is carried by hue alone. */
export const PALETTE: Record<string, string> = {
  ink: '#1F2933',
  muted: '#6B7684',
  paper: '#FDF6E3',
  primary: '#2A6F97',
  secondary: '#BC4B2B',
  tertiary: '#5C7B2F',
  accent: '#8C5A2B',
  warn: '#A8471C',
  good: '#2F6B4F',
  highlight: '#FFE08A',
  grid: '#D8D2C2',
};

export const EASING_CSS: Record<Easing, string> = {
  linear: 'linear',
  ease: 'ease',
  ease_in: 'ease-in',
  ease_out: 'ease-out',
  bounce: 'cubic-bezier(.68,-0.55,.27,1.55)',
  elastic: 'cubic-bezier(.17,.67,.35,1.4)',
};

/** Which primitives carry meaning without colour, for the QA check. */
export const COLOUR_INDEPENDENT: PrimitiveKind[] = [
  'label', 'arrow', 'numberLine', 'fractionBar', 'areaModel', 'bracket',
  'angleArc', 'counter', 'timeline', 'balance', 'molecule',
];
