/* A single-series line chart: one hue, no legend (the title names the series),
   one y-axis, recessive grid, hover crosshair + tooltip, and a table view for
   anyone the chart does not serve. Nothing here is specific to a dataset. */

const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

/** Axis ticks on 1/2/5 x 10^n so labels land on numbers people recognise. */
function niceTicks(min, max, count = 5) {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out.length >= 2 ? out : [min, max];
}

const fmt = (v) => {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 10000 || a < 0.01) return v.toExponential(1).replace('e+', 'e');
  return String(Number(v.toFixed(a < 1 ? 3 : a < 10 ? 2 : a < 100 ? 1 : 0)));
};

/**
 * @param {HTMLElement} host
 * @param {{x:number[], y:number[], xLabel:string, yLabel:string, name:string, unit?:string}} s
 */
export function lineChart(host, s) {
  host.textContent = '';
  const n = Math.min(s.x.length, s.y.length);
  if (n < 2) {
    host.innerHTML = '<p class="muted">Not enough points to plot.</p>';
    return;
  }

  const W = 680, H = 300;
  const pad = { t: 10, r: 14, b: 38, l: 56 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;

  const xs = s.x.slice(0, n), ys = s.y.slice(0, n);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  // Include zero when the data sits near it, so the curve is not floating.
  if (y0 > 0 && y0 < (y1 - y0) * 0.45) y0 = 0;
  const yTicks = niceTicks(y0, y1);
  y0 = Math.min(y0, yTicks[0]); y1 = Math.max(y1, yTicks[yTicks.length - 1]);

  const X = (v) => pad.l + (x1 === x0 ? iw / 2 : ((v - x0) / (x1 - x0)) * iw);
  const Y = (v) => pad.t + ih - ((v - y0) / (y1 - y0)) * ih;

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': `${s.name}: ${s.yLabel} against ${s.xLabel}`,
  });

  // Recessive chrome first, so marks sit on top of it.
  const g = el('g');
  for (const t of yTicks) {
    g.append(el('line', { x1: pad.l, x2: W - pad.r, y1: Y(t), y2: Y(t), stroke: 'var(--grid)', 'stroke-width': 1 }));
    const lab = el('text', { x: pad.l - 8, y: Y(t) + 3.5, 'text-anchor': 'end', fill: 'var(--muted)', 'font-size': 11 });
    lab.textContent = fmt(t);
    g.append(lab);
  }
  for (const t of niceTicks(x0, x1, 6)) {
    if (t < x0 || t > x1) continue;
    const lab = el('text', { x: X(t), y: H - pad.b + 16, 'text-anchor': 'middle', fill: 'var(--muted)', 'font-size': 11 });
    lab.textContent = fmt(t);
    g.append(lab);
  }
  g.append(el('line', { x1: pad.l, x2: W - pad.r, y1: pad.t + ih, y2: pad.t + ih, stroke: 'var(--axis)', 'stroke-width': 1 }));
  const xcap = el('text', { x: pad.l + iw / 2, y: H - 4, 'text-anchor': 'middle', fill: 'var(--muted)', 'font-size': 11.5 });
  xcap.textContent = s.xLabel;
  g.append(xcap);
  const ycap = el('text', { x: 11, y: pad.t + ih / 2, fill: 'var(--muted)', 'font-size': 11.5, transform: `rotate(-90 11 ${pad.t + ih / 2})`, 'text-anchor': 'middle' });
  ycap.textContent = s.yLabel;
  g.append(ycap);
  svg.append(g);

  // The series: 2px, round joins, one hue.
  const d = xs.map((v, i) => `${i ? 'L' : 'M'}${X(v).toFixed(2)} ${Y(ys[i]).toFixed(2)}`).join('');
  svg.append(el('path', {
    d, fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 2,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }));

  // Hover layer: a crosshair and a dot that snap to the nearest sample.
  const cross = el('line', { y1: pad.t, y2: pad.t + ih, stroke: 'var(--axis)', 'stroke-width': 1, opacity: 0 });
  const dot = el('circle', { r: 4.5, fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': 2, opacity: 0 });
  svg.append(cross, dot);

  const tip = document.createElement('div');
  tip.className = 'tip';
  host.append(svg, tip);

  const hide = () => { cross.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); tip.style.opacity = 0; };
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    if (px < pad.l - 6 || px > W - pad.r + 6) return hide();
    const want = x0 + ((px - pad.l) / iw) * (x1 - x0);
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(xs[i] - want) < Math.abs(xs[best] - want)) best = i;
    const cx = X(xs[best]), cy = Y(ys[best]);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('opacity', 1);
    dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('opacity', 1);
    tip.innerHTML = `${s.xLabel} <b>${fmt(xs[best])}</b><br>${s.yLabel} <b>${fmt(ys[best])}</b>`;
    tip.style.left = `${(cx / W) * 100}%`;
    tip.style.top = `${(cy / H) * r.height}px`;
    tip.style.opacity = 1;
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', hide);
}

/** The table view. Identity never rests on color alone, and a screen reader
 *  gets real numbers rather than a path. */
export function seriesTable(s, maxRows = 14) {
  const n = Math.min(s.x.length, s.y.length);
  const stride = Math.max(1, Math.ceil(n / maxRows));
  const rows = [];
  for (let i = 0; i < n; i += stride) rows.push([fmt(s.x[i]), fmt(s.y[i])]);
  if (rows.length && (n - 1) % stride !== 0) rows.push([fmt(s.x[n - 1]), fmt(s.y[n - 1])]);
  return `<div class="scroll"><table><thead><tr><th class="num">${s.xLabel}</th><th class="num">${s.yLabel}</th></tr></thead><tbody>${
    rows.map((r) => `<tr><td class="num">${r[0]}</td><td class="num">${r[1]}</td></tr>`).join('')
  }</tbody></table></div>`;
}
