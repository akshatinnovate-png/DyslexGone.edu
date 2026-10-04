import {
  EASING_CSS, PALETTE, type AngleArcProps, type AreaModelProps, type ArrowProps, type AxesProps,
  type BalanceProps, type BarChartProps, type BeamProps, type BracketProps, type CellProps,
  type CircleProps, type CounterProps, type CurveProps, type ForceVectorProps, type FractionBarProps,
  type GridProps, type HighlightProps, type LabelProps, type LineProps, type MoleculeProps,
  type NumberLineProps, type OrbitProps, type ParticleProps, type PathProps, type PolygonProps,
  type PrimitiveProps, type RectProps, type Scene, type SceneNode, type SpringProps,
  type TimelineProps, type Track, type WaveProps,
} from './primitives.js';

/** Renders a Scene to a single self-contained animated SVG.
 *
 *  Not a frame sequence and not a video pipeline: SMIL <animate> elements mean
 *  the output is one text file that animates in any browser, scales to any
 *  screen, stays crisp at any zoom (which matters for low vision), carries its
 *  own <title>/<desc> for screen readers, and is a few kilobytes. */

const esc = (s: string): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const n = (v: number | undefined, d = 0): number => (Number.isFinite(v as number) ? (v as number) : d);
const r2 = (v: number): string => (Math.round(v * 100) / 100).toString();
/** Timeline fractions need far more precision than geometry: a 2-decimal
 *  keyTime on a 60-second scene quantises to 0.6s, which smears cuts into
 *  cross-fades and blends two states together on screen. */
const rt = (v: number): string => Number(v.toFixed(6)).toString();

const col = (c: string | undefined, fallback: string): string => {
  if (!c) return fallback;
  return PALETTE[c] ?? c;
};

/* ------------------------------- animation ------------------------------- */

const CHANNEL_ATTR: Record<string, { attr: string; kind: 'attr' | 'transform' | 'virtual' }> = {
  x: { attr: 'translateX', kind: 'transform' },
  y: { attr: 'translateY', kind: 'transform' },
  rotate: { attr: 'rotate', kind: 'transform' },
  scale: { attr: 'scale', kind: 'transform' },
  opacity: { attr: 'opacity', kind: 'attr' },
  shaded: { attr: 'shaded', kind: 'virtual' },
  pointer: { attr: 'pointer', kind: 'virtual' },
  phase: { attr: 'phase', kind: 'virtual' },
  angleDeg: { attr: 'angleDeg', kind: 'virtual' },
  magnitude: { attr: 'magnitude', kind: 'virtual' },
  value: { attr: 'value', kind: 'virtual' },
  tilt: { attr: 'tilt', kind: 'virtual' },
  amplitude: { attr: 'amplitude', kind: 'virtual' },
};

function trackToSmil(track: Track, duration: number, nodeId: string): string {
  const info = CHANNEL_ATTR[track.channel];
  if (!info || info.kind === 'virtual') return '';
  const kfs = [...track.keyframes].sort((a, b) => a.t - b.t);
  if (kfs.length < 2) return '';
  const times = kfs.map((k) => rt(Math.min(1, Math.max(0, k.t / Math.max(0.001, duration))))).join(';');
  const values = kfs.map((k) => r2(k.value)).join(';');
  const splines = kfs.slice(1).map((k) => easingToSpline(k.easing ?? 'ease')).join(';');
  const common = `dur="${r2(duration)}s" repeatCount="indefinite" keyTimes="${times}" values="${values}" `
    + `calcMode="spline" keySplines="${splines}" fill="freeze"`;

  if (info.kind === 'attr') {
    return `<animate attributeName="${info.attr}" ${common}/>`;
  }
  const type = track.channel === 'rotate' ? 'rotate' : track.channel === 'scale' ? 'scale' : 'translate';
  if (type === 'translate') {
    const vals = kfs.map((k) => (track.channel === 'x' ? `${r2(k.value)} 0` : `0 ${r2(k.value)}`)).join(';');
    return `<animateTransform attributeName="transform" type="translate" additive="sum" `
      + `dur="${r2(duration)}s" repeatCount="indefinite" keyTimes="${times}" values="${vals}" `
      + `calcMode="spline" keySplines="${splines}" fill="freeze"/>`;
  }
  return `<animateTransform attributeName="transform" type="${type}" additive="sum" ${common}/>`;
}

const SPLINES: Record<string, string> = {
  linear: '0 0 1 1',
  ease: '.42 0 .58 1',
  ease_in: '.42 0 1 1',
  ease_out: '0 0 .58 1',
  bounce: '.68 0 .27 1',
  elastic: '.17 .67 .35 1',
};
const easingToSpline = (e: string): string => SPLINES[e] ?? SPLINES.ease;

/** Visibility window as SMIL, so nodes appear and disappear on cue. */
function visibilitySmil(node: SceneNode, duration: number): string {
  if (node.enter <= 0 && node.exit >= duration) return '';
  const d = Math.max(0.001, duration);
  const fade = Math.min(0.35, d * 0.06);
  const pts: { t: number; v: number }[] = [];
  pts.push({ t: 0, v: node.enter <= 0 ? 1 : 0 });
  if (node.enter > 0) {
    pts.push({ t: Math.max(0, node.enter - fade), v: 0 });
    pts.push({ t: node.enter, v: 1 });
  }
  if (node.exit < d) {
    pts.push({ t: Math.max(node.enter + 0.01, node.exit - fade), v: 1 });
    pts.push({ t: node.exit, v: 0 });
  }
  pts.push({ t: d, v: node.exit < d ? 0 : 1 });
  const uniq = pts.filter((p, i, a) => i === 0 || p.t > a[i - 1].t);
  return `<animate attributeName="opacity" dur="${rt(d)}s" repeatCount="indefinite" `
    + `keyTimes="${uniq.map((p) => rt(p.t / d)).join(';')}" values="${uniq.map((p) => r2(p.v)).join(';')}" fill="freeze"/>`;
}

/* ------------------------------- primitives ------------------------------ */

function renderPrimitive(p: PrimitiveProps): string {
  switch (p.kind) {
    case 'label': return label(p);
    case 'arrow': return arrow(p);
    case 'circle': return circle(p);
    case 'rect': return rect(p);
    case 'line': return line(p);
    case 'path': return path(p);
    case 'polygon': return polygon(p);
    case 'numberLine': return numberLine(p);
    case 'fractionBar': return fractionBar(p);
    case 'areaModel': return areaModel(p);
    case 'barChart': return barChart(p);
    case 'axes': return axes(p);
    case 'curve': return curve(p);
    case 'forceVector': return forceVector(p);
    case 'particle': return particle(p);
    case 'spring': return spring(p);
    case 'wave': return wave(p);
    case 'orbit': return orbit(p);
    case 'beam': return beam(p);
    case 'molecule': return molecule(p);
    case 'cell': return cellShape(p);
    case 'timeline': return timeline(p);
    case 'bracket': return bracket(p);
    case 'angleArc': return angleArc(p);
    case 'grid': return grid(p);
    case 'counter': return counter(p);
    case 'highlight': return highlight(p);
    case 'balance': return balance(p);
    default: return '';
  }
}

const label = (p: LabelProps): string =>
  `<text x="${n(p.x)}" y="${n(p.y)}" font-size="${n(p.size, 18)}" font-weight="${n(p.weight, 500)}" `
  + `text-anchor="${p.anchor ?? 'start'}" fill="${col(p.color, PALETTE.ink)}" `
  + `font-family="Lexend, 'Atkinson Hyperlegible', Verdana, system-ui, sans-serif">${esc(p.text)}</text>`;

function arrow(p: ArrowProps): string {
  const stroke = col(p.stroke ?? p.color, PALETTE.primary);
  const head = n(p.head, 9);
  const dx = n(p.x2) - n(p.x);
  const dy = n(p.y2) - n(p.y);
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const tipX = n(p.x2);
  const tipY = n(p.y2);
  const baseX = tipX - ux * head;
  const baseY = tipY - uy * head;
  const perpX = -uy * head * 0.55;
  const perpY = ux * head * 0.55;
  return `<g>`
    + `<line x1="${r2(n(p.x))}" y1="${r2(n(p.y))}" x2="${r2(baseX)}" y2="${r2(baseY)}" `
    + `stroke="${stroke}" stroke-width="${n(p.strokeWidth, 3)}" stroke-linecap="round"`
    + `${p.dashed ? ' stroke-dasharray="7 5"' : ''}/>`
    + `<polygon points="${r2(tipX)},${r2(tipY)} ${r2(baseX + perpX)},${r2(baseY + perpY)} ${r2(baseX - perpX)},${r2(baseY - perpY)}" fill="${stroke}"/>`
    + (p.label ? label({ text: p.label, x: (n(p.x) + tipX) / 2, y: (n(p.y) + tipY) / 2 - 10, size: 15, anchor: 'middle', color: stroke }) : '')
    + `</g>`;
}

const circle = (p: CircleProps): string =>
  `<g><circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(p.r, 20)}" fill="${col(p.fill, 'none')}" `
  + `stroke="${col(p.stroke ?? p.color, PALETTE.primary)}" stroke-width="${n(p.strokeWidth, 2.5)}"/>`
  + (p.label ? label({ text: p.label, x: n(p.x), y: n(p.y) + 5, anchor: 'middle', size: 15 }) : '')
  + `</g>`;

const rect = (p: RectProps): string =>
  `<g><rect x="${n(p.x)}" y="${n(p.y)}" width="${n(p.w, 40)}" height="${n(p.h, 40)}" `
  + `rx="${n(p.radius, 4)}" fill="${col(p.fill, 'none')}" stroke="${col(p.stroke ?? p.color, PALETTE.ink)}" `
  + `stroke-width="${n(p.strokeWidth, 2)}"/>`
  + (p.label ? label({ text: p.label, x: n(p.x) + n(p.w, 40) / 2, y: n(p.y) + n(p.h, 40) / 2 + 5, anchor: 'middle', size: 15 }) : '')
  + `</g>`;

const line = (p: LineProps): string =>
  `<line x1="${n(p.x)}" y1="${n(p.y)}" x2="${n(p.x2)}" y2="${n(p.y2)}" `
  + `stroke="${col(p.stroke ?? p.color, PALETTE.muted)}" stroke-width="${n(p.strokeWidth, 2)}" `
  + `stroke-linecap="round"${p.dashed ? ' stroke-dasharray="6 5"' : ''}/>`;

const path = (p: PathProps): string =>
  `<path d="${esc(p.d)}" fill="${col(p.fill, 'none')}" stroke="${col(p.stroke ?? p.color, PALETTE.primary)}" `
  + `stroke-width="${n(p.strokeWidth, 2.5)}" stroke-linejoin="round"/>`;

const polygon = (p: PolygonProps): string =>
  `<g><polygon points="${p.points.map((q) => `${r2(q.x)},${r2(q.y)}`).join(' ')}" `
  + `fill="${col(p.fill, 'none')}" stroke="${col(p.stroke ?? p.color, PALETTE.ink)}" stroke-width="${n(p.strokeWidth, 2.5)}"/>`
  + (p.label ? label({
      text: p.label, anchor: 'middle', size: 15,
      x: p.points.reduce((a, q) => a + q.x, 0) / Math.max(1, p.points.length),
      y: p.points.reduce((a, q) => a + q.y, 0) / Math.max(1, p.points.length),
    }) : '')
  + `</g>`;

function numberLine(p: NumberLineProps): string {
  const x0 = n(p.x);
  const y0 = n(p.y);
  const w = n(p.width, 400);
  const span = p.max - p.min || 1;
  const toX = (v: number) => x0 + ((v - p.min) / span) * w;
  const parts: string[] = [
    `<line x1="${r2(x0 - 10)}" y1="${y0}" x2="${r2(x0 + w + 10)}" y2="${y0}" stroke="${PALETTE.ink}" stroke-width="2.5"/>`,
    arrow({ x: x0 + w, y: y0, x2: x0 + w + 18, y2: y0, head: 8, stroke: PALETTE.ink, strokeWidth: 2.5 }),
    arrow({ x: x0, y: y0, x2: x0 - 18, y2: y0, head: 8, stroke: PALETTE.ink, strokeWidth: 2.5 }),
  ];
  for (let v = p.min; v <= p.max + 1e-9; v += p.step) {
    const x = toX(v);
    const major = Math.abs(v % (p.step * 5)) < 1e-9 || v === p.min || v === p.max;
    parts.push(`<line x1="${r2(x)}" y1="${y0 - (major ? 10 : 6)}" x2="${r2(x)}" y2="${y0 + (major ? 10 : 6)}" stroke="${PALETTE.ink}" stroke-width="${major ? 2 : 1.2}"/>`);
    if (major) {
      parts.push(label({ text: formatNum(v), x, y: y0 + 30, anchor: 'middle', size: 14, color: PALETTE.muted }));
    }
  }
  for (const m of p.marks ?? []) {
    const x = toX(m.value);
    parts.push(`<circle cx="${r2(x)}" cy="${y0}" r="7" fill="${col(m.color, PALETTE.secondary)}"/>`);
    if (m.label) parts.push(label({ text: m.label, x, y: y0 - 18, anchor: 'middle', size: 15, color: col(m.color, PALETTE.secondary), weight: 600 }));
  }
  if (p.pointer !== undefined) {
    const x = toX(p.pointer);
    parts.push(`<polygon points="${r2(x)},${y0 - 12} ${r2(x - 8)},${y0 - 28} ${r2(x + 8)},${y0 - 28}" fill="${PALETTE.secondary}"/>`);
  }
  return `<g>${parts.join('')}</g>`;
}

function fractionBar(p: FractionBarProps): string {
  const x0 = n(p.x);
  const y0 = n(p.y);
  const w = n(p.width, 320);
  const h = n(p.height, 56);
  const parts = Math.max(1, Math.round(p.parts));
  const cw = w / parts;
  const shaded = Math.max(0, Math.min(parts, p.shaded));
  const out: string[] = [];
  for (let i = 0; i < parts; i++) {
    const filled = i < Math.floor(shaded);
    const partial = i === Math.floor(shaded) ? shaded - Math.floor(shaded) : 0;
    out.push(`<rect x="${r2(x0 + i * cw)}" y="${y0}" width="${r2(cw)}" height="${h}" `
      + `fill="${filled ? col(p.fill, PALETTE.primary) : PALETTE.paper}" stroke="${PALETTE.ink}" stroke-width="2"/>`);
    if (partial > 0.01) {
      out.push(`<rect x="${r2(x0 + i * cw)}" y="${y0}" width="${r2(cw * partial)}" height="${h}" fill="${col(p.fill, PALETTE.primary)}"/>`);
    }
    if (p.showLabels) {
      out.push(label({
        text: `1/${parts}`, x: x0 + i * cw + cw / 2, y: y0 + h / 2 + 5, anchor: 'middle', size: Math.min(15, cw * 0.4),
        color: filled ? PALETTE.paper : PALETTE.muted,
      }));
    }
  }
  if (p.label) out.push(label({ text: p.label, x: x0, y: y0 - 12, size: 17, weight: 600 }));
  return `<g>${out.join('')}</g>`;
}

function areaModel(p: AreaModelProps): string {
  const x0 = n(p.x);
  const y0 = n(p.y);
  const c = n(p.cell, 34);
  const out: string[] = [];
  for (let r = 0; r < p.rows; r++) {
    for (let k = 0; k < p.cols; k++) {
      const inShade = r < (p.shadedRows ?? 0) && k < (p.shadedCols ?? 0);
      const inRow = p.shadedRows !== undefined && r < p.shadedRows && p.shadedCols === undefined;
      out.push(`<rect x="${r2(x0 + k * c)}" y="${r2(y0 + r * c)}" width="${r2(c)}" height="${r2(c)}" `
        + `fill="${inShade ? PALETTE.secondary : inRow ? PALETTE.primary : PALETTE.paper}" `
        + `fill-opacity="${inShade ? 0.85 : inRow ? 0.5 : 1}" stroke="${PALETTE.grid}" stroke-width="1.5"/>`);
    }
  }
  out.push(`<rect x="${x0}" y="${y0}" width="${r2(p.cols * c)}" height="${r2(p.rows * c)}" fill="none" stroke="${PALETTE.ink}" stroke-width="2.5"/>`);
  if (p.label) out.push(label({ text: p.label, x: x0, y: y0 - 12, size: 17, weight: 600 }));
  return `<g>${out.join('')}</g>`;
}

function barChart(p: BarChartProps): string {
  const x0 = n(p.x);
  const y0 = n(p.y);
  const w = n(p.width, 360);
  const h = n(p.height, 200);
  const max = p.maxValue ?? Math.max(1, ...p.bars.map((b) => b.value));
  const bw = w / Math.max(1, p.bars.length) * 0.62;
  const gap = w / Math.max(1, p.bars.length);
  const out: string[] = [
    `<line x1="${x0}" y1="${y0 + h}" x2="${r2(x0 + w)}" y2="${y0 + h}" stroke="${PALETTE.ink}" stroke-width="2"/>`,
  ];
  p.bars.forEach((b, i) => {
    const bh = (b.value / max) * h;
    const bx = x0 + i * gap + (gap - bw) / 2;
    out.push(`<rect x="${r2(bx)}" y="${r2(y0 + h - bh)}" width="${r2(bw)}" height="${r2(bh)}" `
      + `fill="${col(b.color, PALETTE.primary)}" rx="3"/>`);
    out.push(label({ text: b.label, x: bx + bw / 2, y: y0 + h + 22, anchor: 'middle', size: 13, color: PALETTE.muted }));
    out.push(label({ text: formatNum(b.value), x: bx + bw / 2, y: y0 + h - bh - 8, anchor: 'middle', size: 14, weight: 600 }));
  });
  return `<g>${out.join('')}</g>`;
}

function axes(p: AxesProps): string {
  const x0 = n(p.x);
  const y0 = n(p.y);
  const w = n(p.width, 360);
  const h = n(p.height, 260);
  const out: string[] = [];
  const xTicks = p.xTicks ?? 5;
  const yTicks = p.yTicks ?? 5;
  if (p.gridlines !== false) {
    for (let i = 0; i <= xTicks; i++) {
      const x = x0 + (i / xTicks) * w;
      out.push(`<line x1="${r2(x)}" y1="${y0}" x2="${r2(x)}" y2="${r2(y0 + h)}" stroke="${PALETTE.grid}" stroke-width="1"/>`);
    }
    for (let i = 0; i <= yTicks; i++) {
      const y = y0 + (i / yTicks) * h;
      out.push(`<line x1="${x0}" y1="${r2(y)}" x2="${r2(x0 + w)}" y2="${r2(y)}" stroke="${PALETTE.grid}" stroke-width="1"/>`);
    }
  }
  const zeroY = p.yMin <= 0 && p.yMax >= 0 ? y0 + h - ((0 - p.yMin) / (p.yMax - p.yMin || 1)) * h : y0 + h;
  const zeroX = p.xMin <= 0 && p.xMax >= 0 ? x0 + ((0 - p.xMin) / (p.xMax - p.xMin || 1)) * w : x0;
  out.push(`<line x1="${x0}" y1="${r2(zeroY)}" x2="${r2(x0 + w)}" y2="${r2(zeroY)}" stroke="${PALETTE.ink}" stroke-width="2.5"/>`);
  out.push(`<line x1="${r2(zeroX)}" y1="${y0}" x2="${r2(zeroX)}" y2="${r2(y0 + h)}" stroke="${PALETTE.ink}" stroke-width="2.5"/>`);
  for (let i = 0; i <= xTicks; i++) {
    const v = p.xMin + (i / xTicks) * (p.xMax - p.xMin);
    out.push(label({ text: formatNum(v), x: x0 + (i / xTicks) * w, y: zeroY + 20, anchor: 'middle', size: 12, color: PALETTE.muted }));
  }
  for (let i = 0; i <= yTicks; i++) {
    const v = p.yMax - (i / yTicks) * (p.yMax - p.yMin);
    out.push(label({ text: formatNum(v), x: zeroX - 8, y: y0 + (i / yTicks) * h + 4, anchor: 'end', size: 12, color: PALETTE.muted }));
  }
  if (p.xLabel) out.push(label({ text: p.xLabel, x: x0 + w / 2, y: y0 + h + 44, anchor: 'middle', size: 15, weight: 600 }));
  if (p.yLabel) out.push(`<g transform="translate(${r2(x0 - 44)},${r2(y0 + h / 2)}) rotate(-90)">${label({ text: p.yLabel, x: 0, y: 0, anchor: 'middle', size: 15, weight: 600 })}</g>`);
  return `<g>${out.join('')}</g>`;
}

function curve(p: CurveProps): string {
  if (!p.points.length) return '';
  const d = p.smooth === false || p.points.length < 3
    ? `M ${p.points.map((q) => `${r2(q.x)} ${r2(q.y)}`).join(' L ')}`
    : smoothPath(p.points);
  return `<g><path d="${d}${p.closed ? ' Z' : ''}" fill="${col(p.fill, 'none')}" `
    + `stroke="${col(p.stroke ?? p.color, PALETTE.secondary)}" stroke-width="${n(p.strokeWidth, 3)}" stroke-linejoin="round"/>`
    + (p.label ? label({ text: p.label, x: p.points[p.points.length - 1].x + 8, y: p.points[p.points.length - 1].y, size: 14, color: col(p.stroke ?? p.color, PALETTE.secondary) }) : '')
    + `</g>`;
}

function smoothPath(pts: { x: number; y: number }[]): string {
  let d = `M ${r2(pts[0].x)} ${r2(pts[0].y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${r2(c1x)} ${r2(c1y)}, ${r2(c2x)} ${r2(c2y)}, ${r2(p2.x)} ${r2(p2.y)}`;
  }
  return d;
}

function forceVector(p: ForceVectorProps): string {
  const scale = n(p.scalePxPerUnit, 18);
  const rad = (n(p.angleDeg) * Math.PI) / 180;
  const len = Math.max(6, n(p.magnitude, 1) * scale);
  return arrow({
    x: n(p.x), y: n(p.y),
    x2: n(p.x) + Math.cos(rad) * len,
    y2: n(p.y) - Math.sin(rad) * len,
    stroke: col(p.stroke ?? p.color, PALETTE.secondary),
    strokeWidth: 4, head: 11,
    label: p.label ? `${p.label} (${formatNum(n(p.magnitude, 1))} N)` : undefined,
  });
}

const particle = (p: ParticleProps): string =>
  `<g><circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(p.r, 10)}" fill="${col(p.fill ?? p.color, p.charge === '+' ? PALETTE.secondary : p.charge === '-' ? PALETTE.primary : PALETTE.muted)}"/>`
  + (p.charge && p.charge !== 'neutral'
    ? label({ text: p.charge, x: n(p.x), y: n(p.y) + 5, anchor: 'middle', size: 14, color: PALETTE.paper, weight: 700 })
    : '')
  + (p.label ? label({ text: p.label, x: n(p.x), y: n(p.y) - n(p.r, 10) - 6, anchor: 'middle', size: 13 }) : '')
  + `</g>`;

function spring(p: SpringProps): string {
  const coils = Math.max(3, n(p.coils, 8));
  const amp = n(p.amplitude, 12);
  const x1 = n(p.x);
  const y1 = n(p.y);
  const x2 = n(p.x2);
  const y2 = n(p.y2);
  const pts: string[] = [`${r2(x1)},${r2(y1)}`];
  for (let i = 1; i < coils * 2; i++) {
    const t = i / (coils * 2);
    const bx = x1 + (x2 - x1) * t;
    const by = y1 + (y2 - y1) * t;
    const dx = -(y2 - y1);
    const dy = x2 - x1;
    const l = Math.hypot(dx, dy) || 1;
    const sign = i % 2 === 0 ? 1 : -1;
    pts.push(`${r2(bx + (dx / l) * amp * sign)},${r2(by + (dy / l) * amp * sign)}`);
  }
  pts.push(`${r2(x2)},${r2(y2)}`);
  return `<polyline points="${pts.join(' ')}" fill="none" stroke="${col(p.stroke ?? p.color, PALETTE.muted)}" stroke-width="${n(p.strokeWidth, 2.5)}"/>`;
}

function wave(p: WaveProps): string {
  const samples = Math.max(16, n(p.samples, 120));
  const w = n(p.width, 360);
  const amp = n(p.amplitude, 40);
  const wl = Math.max(8, n(p.wavelength, 120));
  const phase = n(p.phase, 0);
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= samples; i++) {
    const x = (i / samples) * w;
    pts.push({ x: n(p.x) + x, y: n(p.y) - amp * Math.sin((2 * Math.PI * x) / wl + phase) });
  }
  return curve({ points: pts, stroke: col(p.stroke ?? p.color, PALETTE.primary), strokeWidth: n(p.strokeWidth, 3), smooth: false });
}

function orbit(p: OrbitProps): string {
  const rad = (n(p.angleDeg) * Math.PI) / 180;
  const bx = n(p.x) + Math.cos(rad) * n(p.rx, 100);
  const by = n(p.y) + Math.sin(rad) * n(p.ry, 60);
  return `<g><ellipse cx="${n(p.x)}" cy="${n(p.y)}" rx="${n(p.rx, 100)}" ry="${n(p.ry, 60)}" fill="none" `
    + `stroke="${PALETTE.grid}" stroke-width="1.5" stroke-dasharray="5 5"/>`
    + `<circle cx="${r2(bx)}" cy="${r2(by)}" r="${n(p.bodyR, 11)}" fill="${col(p.fill ?? p.color, PALETTE.primary)}"/></g>`;
}

function beam(p: BeamProps): string {
  const rays = Math.max(1, n(p.rays, 3));
  const spread = n(p.spread, 14);
  const out: string[] = [];
  for (let i = 0; i < rays; i++) {
    const off = (i - (rays - 1) / 2) * spread;
    out.push(arrow({
      x: n(p.x), y: n(p.y) + off, x2: n(p.x2), y2: n(p.y2) + off,
      stroke: col(p.stroke ?? p.color, PALETTE.highlight), strokeWidth: 2.5, head: 8,
    }));
  }
  return `<g>${out.join('')}</g>`;
}

const ATOM_COLORS: Record<string, string> = {
  H: '#E8E6E1', C: '#3A3A42', O: '#BC4B2B', N: '#2A6F97', S: '#D4A017',
  Cl: '#5C7B2F', Na: '#8C5A2B', Ca: '#6B7684', P: '#A8471C', Fe: '#7A4E2D',
};

function molecule(p: MoleculeProps): string {
  const out: string[] = [];
  for (const b of p.bonds) {
    const a1 = p.atoms[b.from];
    const a2 = p.atoms[b.to];
    if (!a1 || !a2) continue;
    const order = b.order ?? 1;
    for (let k = 0; k < order; k++) {
      const off = (k - (order - 1) / 2) * 5;
      const dx = a2.x - a1.x;
      const dy = a2.y - a1.y;
      const l = Math.hypot(dx, dy) || 1;
      out.push(`<line x1="${r2(n(p.x) + a1.x - (dy / l) * off)}" y1="${r2(n(p.y) + a1.y + (dx / l) * off)}" `
        + `x2="${r2(n(p.x) + a2.x - (dy / l) * off)}" y2="${r2(n(p.y) + a2.y + (dx / l) * off)}" `
        + `stroke="${PALETTE.ink}" stroke-width="2.5"/>`);
    }
  }
  for (const a of p.atoms) {
    const r = a.r ?? (a.el === 'H' ? 11 : 17);
    out.push(`<circle cx="${r2(n(p.x) + a.x)}" cy="${r2(n(p.y) + a.y)}" r="${r}" `
      + `fill="${ATOM_COLORS[a.el] ?? PALETTE.muted}" stroke="${PALETTE.ink}" stroke-width="1.5"/>`);
    out.push(label({
      text: a.el, x: n(p.x) + a.x, y: n(p.y) + a.y + 5, anchor: 'middle', size: r * 0.8,
      color: a.el === 'H' ? PALETTE.ink : PALETTE.paper, weight: 700,
    }));
  }
  if (p.label) out.push(label({ text: p.label, x: n(p.x), y: n(p.y) - 52, anchor: 'middle', size: 17, weight: 600 }));
  return `<g>${out.join('')}</g>`;
}

function cellShape(p: CellProps): string {
  const out: string[] = [
    `<ellipse cx="${n(p.x)}" cy="${n(p.y)}" rx="${n(p.rx, 150)}" ry="${n(p.ry, 100)}" `
    + `fill="${PALETTE.paper}" stroke="${PALETTE.tertiary}" stroke-width="4"/>`,
  ];
  for (const o of p.organelles ?? []) {
    out.push(`<ellipse cx="${r2(n(p.x) + o.x)}" cy="${r2(n(p.y) + o.y)}" rx="${o.r}" ry="${r2(o.r * 0.78)}" `
      + `fill="${PALETTE.primary}" fill-opacity="0.75" stroke="${PALETTE.ink}" stroke-width="1.5"/>`);
    if (o.label) {
      out.push(label({ text: o.label, x: n(p.x) + o.x, y: n(p.y) + o.y - o.r - 6, anchor: 'middle', size: 12, color: PALETTE.ink }));
    }
  }
  return `<g>${out.join('')}</g>`;
}

function timeline(p: TimelineProps): string {
  const w = n(p.width, 420);
  const span = p.max - p.min || 1;
  const out: string[] = [
    `<line x1="${n(p.x)}" y1="${n(p.y)}" x2="${r2(n(p.x) + w)}" y2="${n(p.y)}" stroke="${PALETTE.ink}" stroke-width="3"/>`,
  ];
  p.events.forEach((e, i) => {
    const x = n(p.x) + ((e.at - p.min) / span) * w;
    const up = i % 2 === 0;
    out.push(`<line x1="${r2(x)}" y1="${n(p.y)}" x2="${r2(x)}" y2="${r2(n(p.y) + (up ? -26 : 26))}" stroke="${PALETTE.muted}" stroke-width="2"/>`);
    out.push(`<circle cx="${r2(x)}" cy="${n(p.y)}" r="6" fill="${PALETTE.secondary}"/>`);
    out.push(label({ text: e.label, x, y: n(p.y) + (up ? -34 : 44), anchor: 'middle', size: 13 }));
    out.push(label({ text: formatNum(e.at), x, y: n(p.y) + (up ? -50 : 60), anchor: 'middle', size: 11, color: PALETTE.muted }));
  });
  return `<g>${out.join('')}</g>`;
}

function bracket(p: BracketProps): string {
  const x1 = n(p.x);
  const y1 = n(p.y);
  const x2 = n(p.x2);
  const y2 = n(p.y2);
  const lip = 10;
  const vertical = p.side === 'left' || p.side === 'right';
  const d = vertical
    ? `M ${r2(x1 + lip)} ${r2(y1)} L ${r2(x1)} ${r2(y1)} L ${r2(x1)} ${r2(y2)} L ${r2(x1 + lip)} ${r2(y2)}`
    : `M ${r2(x1)} ${r2(y1 + lip)} L ${r2(x1)} ${r2(y1)} L ${r2(x2)} ${r2(y1)} L ${r2(x2)} ${r2(y1 + lip)}`;
  return `<g><path d="${d}" fill="none" stroke="${col(p.stroke ?? p.color, PALETTE.muted)}" stroke-width="2.5"/>`
    + (p.label ? label({ text: p.label, x: (x1 + x2) / 2, y: vertical ? (y1 + y2) / 2 : y1 - 8, anchor: 'middle', size: 14 }) : '')
    + `</g>`;
}

function angleArc(p: AngleArcProps): string {
  const r = n(p.r, 40);
  const a0 = (p.startDeg * Math.PI) / 180;
  const a1 = (p.endDeg * Math.PI) / 180;
  const x0 = n(p.x) + Math.cos(a0) * r;
  const y0 = n(p.y) - Math.sin(a0) * r;
  const x1 = n(p.x) + Math.cos(a1) * r;
  const y1 = n(p.y) - Math.sin(a1) * r;
  const large = Math.abs(p.endDeg - p.startDeg) > 180 ? 1 : 0;
  const mid = ((p.startDeg + p.endDeg) / 2 * Math.PI) / 180;
  return `<g><path d="M ${r2(x0)} ${r2(y0)} A ${r} ${r} 0 ${large} 0 ${r2(x1)} ${r2(y1)}" `
    + `fill="none" stroke="${col(p.stroke ?? p.color, PALETTE.secondary)}" stroke-width="2.5"/>`
    + (p.label ? label({
        text: p.label, anchor: 'middle', size: 14,
        x: n(p.x) + Math.cos(mid) * (r + 18), y: n(p.y) - Math.sin(mid) * (r + 18) + 5,
      }) : '')
    + `</g>`;
}

function grid(p: GridProps): string {
  const out: string[] = [];
  const c = n(p.cell, 30);
  for (let x = 0; x <= n(p.w, 300); x += c) {
    out.push(`<line x1="${r2(n(p.x) + x)}" y1="${n(p.y)}" x2="${r2(n(p.x) + x)}" y2="${r2(n(p.y) + n(p.h, 300))}" stroke="${PALETTE.grid}" stroke-width="1"/>`);
  }
  for (let y = 0; y <= n(p.h, 300); y += c) {
    out.push(`<line x1="${n(p.x)}" y1="${r2(n(p.y) + y)}" x2="${r2(n(p.x) + n(p.w, 300))}" y2="${r2(n(p.y) + y)}" stroke="${PALETTE.grid}" stroke-width="1"/>`);
  }
  return `<g>${out.join('')}</g>`;
}

const counter = (p: CounterProps): string =>
  label({
    text: `${p.prefix ?? ''}${n(p.value).toFixed(n(p.decimals, 0))}${p.suffix ?? ''}`,
    x: n(p.x), y: n(p.y), size: n(p.size, 34), anchor: 'middle', weight: 700,
    color: col(p.color, PALETTE.ink),
  });

const highlight = (p: HighlightProps): string =>
  `<rect x="${n(p.x)}" y="${n(p.y)}" width="${n(p.w, 100)}" height="${n(p.h, 30)}" rx="${n(p.radius, 6)}" `
  + `fill="${col(p.fill ?? p.color, PALETTE.highlight)}" fill-opacity="${n(p.opacity, 0.55)}"/>`;

function balance(p: BalanceProps): string {
  const w = n(p.width, 320);
  const tilt = n(p.tilt, 0);
  const x0 = n(p.x);
  const y0 = n(p.y);
  const rad = (tilt * Math.PI) / 180;
  const lx = x0 - (w / 2) * Math.cos(rad);
  const ly = y0 + (w / 2) * Math.sin(rad);
  const rx = x0 + (w / 2) * Math.cos(rad);
  const ry = y0 - (w / 2) * Math.sin(rad);
  const pan = (px: number, py: number, items: { label: string; weight: number }[]): string =>
    `<g><line x1="${r2(px)}" y1="${r2(py)}" x2="${r2(px)}" y2="${r2(py + 30)}" stroke="${PALETTE.ink}" stroke-width="2"/>`
    + `<rect x="${r2(px - 46)}" y="${r2(py + 30)}" width="92" height="30" rx="5" fill="${PALETTE.paper}" stroke="${PALETTE.ink}" stroke-width="2"/>`
    + label({ text: items.map((i) => i.label).join(' + ') || '0', x: px, y: py + 50, anchor: 'middle', size: 15, weight: 600 })
    + `</g>`;
  return `<g>`
    + `<polygon points="${r2(x0)},${r2(y0)} ${r2(x0 - 22)},${r2(y0 + 70)} ${r2(x0 + 22)},${r2(y0 + 70)}" fill="${PALETTE.muted}"/>`
    + `<line x1="${r2(lx)}" y1="${r2(ly)}" x2="${r2(rx)}" y2="${r2(ry)}" stroke="${PALETTE.ink}" stroke-width="4" stroke-linecap="round"/>`
    + pan(lx, ly, p.left) + pan(rx, ry, p.right)
    + `</g>`;
}

/** Greedy word wrap so a caption never runs off its own band. */
export function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (candidate.length <= maxChars) { cur = candidate; continue; }
    if (cur) lines.push(cur);
    cur = w;
    if (lines.length === maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines) {
    const consumed = lines.join(' ').length;
    if (consumed < text.length - 1) {
      lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, Math.max(0, maxChars - 1))}…`;
    }
  }
  return lines.length ? lines : [text.slice(0, maxChars)];
}

function formatNum(v: number): string {
  if (Number.isInteger(v)) return String(v);
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) < 0.01 && v !== 0) return v.toExponential(1);
  return String(Math.round(v * 100) / 100);
}

/* ---------------------------- virtual channels ---------------------------- */

const VIRTUAL_CHANNELS = new Set(
  Object.entries(CHANNEL_ATTR).filter(([, v]) => v.kind === 'virtual').map(([k]) => k),
);

/** SMIL can animate an SVG attribute, but not "how many parts of this fraction
 *  bar are shaded" - that changes the geometry itself. So those channels are
 *  BAKED: sample the track, render each distinct state once, and cross-fade
 *  between them with visibility windows. Adaptive deduplication means a
 *  discrete channel (shaded 0 -> 3) costs 4 variants, not 40. */
function bakeVirtualTrack(node: SceneNode, duration: number, maxSamples = 56): { svg: string; from: number; to: number }[] {
  const start = Math.max(0, node.enter);
  const end = Math.min(duration, Number.isFinite(node.exit) ? node.exit : duration);
  if (end <= start) return [];

  // Sample where the motion actually is. A `shaded` track that completes in the
  // first 3 seconds of a 60-second scene needs its resolution spent there, not
  // spread evenly across a minute of nothing happening.
  const critical = new Set<number>([start, end]);
  for (const tr of node.tracks) {
    if (!VIRTUAL_CHANNELS.has(tr.channel)) continue;
    for (const k of tr.keyframes) {
      if (k.t >= start && k.t <= end) critical.add(k.t);
    }
  }
  const anchors = [...critical].sort((a, b) => a - b);

  const times: number[] = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    const steps = Math.max(1, Math.min(24, Math.round((b - a) * 9)));
    for (let k = 0; k < steps; k++) times.push(a + ((b - a) * k) / steps);
  }
  times.push(end);

  // Cap total work while keeping the anchors.
  const stride = Math.max(1, Math.ceil(times.length / maxSamples));
  const sampled = times.filter((t, i) => i % stride === 0 || critical.has(t));

  const out: { svg: string; from: number; to: number }[] = [];
  let lastSvg = '';
  for (const t of sampled) {
    const svg = renderPrimitive(applyTracksAt(node, t));
    if (svg === lastSvg) continue;
    if (out.length) out[out.length - 1].to = t;
    out.push({ svg, from: t, to: end });
    lastSvg = svg;
  }
  if (out.length) out[out.length - 1].to = end;
  return out;
}

/** Visibility SMIL for one baked slice: hard off, on, off - never a slow fade
 *  through intermediate states, which would show two states at once. */
function sliceSmil(from: number, to: number, duration: number): string {
  const d = Math.max(0.001, duration);
  const eps = 1 / (d * 60);   // one frame at 60fps: an instant cut, not a fade
  const k = (t: number) => Math.min(1, Math.max(0, t / d));
  const pts: [number, number][] = [[0, 0]];
  const a = k(from);
  const b = k(to);
  if (a > eps) pts.push([a - eps, 0]);
  pts.push([a, 1]);
  if (b < 1 - eps) {
    pts.push([b, 1]);
    pts.push([Math.min(1, b + eps), 0]);
    pts.push([1, 0]);
  } else {
    pts.push([1, 1]);
  }
  const uniq = pts.filter((p, i, arr) => i === 0 || p[0] > arr[i - 1][0] + 1e-7);
  return `<animate attributeName="opacity" dur="${rt(d)}s" repeatCount="indefinite" `
    + `keyTimes="${uniq.map((p) => rt(p[0])).join(';')}" values="${uniq.map((p) => p[1]).join(';')}" fill="freeze"/>`;
}

/* --------------------------------- scene --------------------------------- */

export interface RenderOptions {
  /** Emit a still frame at this time instead of an animation. */
  frozenAt?: number;
  /** Respect reduced-motion: render the final state with no <animate>. */
  reduceMotion?: boolean;
  showCaptions?: boolean;
  /** Override the background, e.g. to match a learner's colour profile. */
  background?: string;
}

export function renderSvg(scene: Scene, opts: RenderOptions = {}): string {
  const bg = opts.background ?? scene.background;
  const still = opts.reduceMotion || opts.frozenAt !== undefined;
  const t = opts.frozenAt ?? scene.durationSec;

  const nodes = [...scene.nodes].sort((a, b) => a.layer - b.layer);
  const body = nodes.map((node) => {
    if (still && (t < node.enter || t > node.exit)) return '';
    const hasVirtual = !still && node.tracks.some((tr) => VIRTUAL_CHANNELS.has(tr.channel));
    const resolved = still ? applyTracksAt(node, t) : node.primitive;
    let inner: string;
    let anims: string;

    if (hasVirtual) {
      const slices = bakeVirtualTrack(node, scene.durationSec);
      if (!slices.length) return '';
      inner = slices
        .map((sl) => `<g opacity="0">${sliceSmil(sl.from, sl.to, scene.durationSec)}${sl.svg}</g>`)
        .join('');
      // Attribute tracks (x, y, opacity, rotate, scale) still animate normally.
      anims = node.tracks
        .filter((tr) => !VIRTUAL_CHANNELS.has(tr.channel))
        .map((tr) => trackToSmil(tr, scene.durationSec, node.id))
        .join('');
    } else {
      inner = renderPrimitive(resolved);
      if (!inner) return '';
      anims = still ? '' : [visibilitySmil(node, scene.durationSec),
        ...node.tracks.map((tr) => trackToSmil(tr, scene.durationSec, node.id))].join('');
    }
    const base = node.primitive;
    const transform = (base.rotate || base.scale)
      ? ` transform="${base.rotate ? `rotate(${r2(base.rotate)} ${n(base.x)} ${n(base.y)})` : ''}${base.scale ? ` translate(${n(base.x)} ${n(base.y)}) scale(${r2(base.scale)}) translate(${-n(base.x)} ${-n(base.y)})` : ''}"`
      : '';
    const opacity = base.opacity !== undefined ? ` opacity="${r2(base.opacity)}"` : '';
    const title = base.describe ? `<title>${esc(base.describe)}</title>` : '';
    return `<g id="${esc(node.id)}"${transform}${opacity}>${title}${inner}${anims}</g>`;
  }).join('\n  ');

  // Captions get their own strip below the artwork rather than sitting on top
  // of it: a caption that covers the thing it is describing helps nobody.
  const capSize = 16;
  const capLineH = capSize * 1.35;
  const capMaxChars = Math.floor((scene.width * 0.84) / (capSize * 0.52));
  const wrapped = opts.showCaptions
    ? scene.captions.map((c) => ({ ...c, lines: wrapText(c.text, capMaxChars, 3) }))
    : [];
  const bandHeight = wrapped.length
    ? Math.max(...wrapped.map((c) => c.lines.length)) * capLineH + 22
    : 0;
  const totalHeight = scene.height + bandHeight;

  const captionBand = wrapped.length
    ? `<g id="captions">`
      + `<rect x="0" y="${r2(scene.height)}" width="${scene.width}" height="${r2(bandHeight)}" fill="${PALETTE.ink}"/>`
      + wrapped.map((c) => {
          const vis = still ? (t >= c.start && t <= c.end ? 1 : 0) : 0;
          const anim = still ? '' : sliceSmil(c.start, c.end, scene.durationSec);
          const top = scene.height + (bandHeight - c.lines.length * capLineH) / 2;
          return `<g opacity="${vis}">${anim}`
            + c.lines.map((ln, li) => label({
                text: ln, x: scene.width / 2, y: top + li * capLineH + capSize * 0.8,
                anchor: 'middle', size: capSize, color: PALETTE.paper, weight: 500,
              })).join('')
            + `</g>`;
        }).join('')
      + `</g>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${scene.width} ${r2(totalHeight)}" `
    + `width="${scene.width}" height="${r2(totalHeight)}" role="img" aria-labelledby="t-${esc(scene.id)} d-${esc(scene.id)}">\n`
    + `  <title id="t-${esc(scene.id)}">${esc(scene.title)}</title>\n`
    + `  <desc id="d-${esc(scene.id)}">${esc(scene.audioDescription)}</desc>\n`
    + `  <rect width="${scene.width}" height="${scene.height}" fill="${bg}"/>\n  `
    + body
    + (captionBand ? `\n  ${captionBand}` : '')
    + `\n</svg>\n`;
}

/** Evaluate every track at time t and fold the results into the primitive. */
export function applyTracksAt(node: SceneNode, t: number): PrimitiveProps {
  const out = { ...node.primitive } as PrimitiveProps & Record<string, unknown>;
  for (const track of node.tracks) {
    const v = sampleTrack(track, t);
    if (v !== undefined) out[track.channel] = v;
  }
  return out as PrimitiveProps;
}

export function sampleTrack(track: Track, t: number): number | undefined {
  const kfs = [...track.keyframes].sort((a, b) => a.t - b.t);
  if (!kfs.length) return undefined;
  if (t <= kfs[0].t) return kfs[0].value;
  if (t >= kfs[kfs.length - 1].t) return kfs[kfs.length - 1].value;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t || 1;
      const raw = (t - a.t) / span;
      return a.value + (b.value - a.value) * ease(raw, b.easing ?? 'ease');
    }
  }
  return kfs[kfs.length - 1].value;
}

function ease(x: number, kind: string): number {
  switch (kind) {
    case 'linear': return x;
    case 'ease_in': return x * x;
    case 'ease_out': return 1 - (1 - x) ** 2;
    case 'bounce': return x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2;
    case 'elastic': return x === 0 || x === 1 ? x : -(2 ** (10 * x - 10)) * Math.sin((x * 10 - 10.75) * ((2 * Math.PI) / 3));
    default: return x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2;
  }
}

export { EASING_CSS };
