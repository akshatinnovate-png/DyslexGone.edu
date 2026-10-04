import { hyphenate, sentences, syllables, words } from '../core/textkit.js';
import { clamp, round } from '../core/mathx.js';
import { CONFUSABLE_PAIRS, IRREGULAR_WORDS } from './wordlists.js';

/** Render plans for dyslexia-friendly presentation. These are *data*, not CSS -
 *  any frontend (web, native, e-ink, AR) can realise them. */

export interface TypographyPlan {
  fontStack: string[];
  fontSizePx: number;
  lineHeight: number;
  letterSpacingEm: number;
  wordSpacingEm: number;
  paragraphSpacingEm: number;
  maxLineChars: number;
  textAlign: 'left' | 'justify';
  weight: number;
  caseStyle: 'sentence' | 'upper' | 'preserve';
}

export interface ColorPlan {
  name: string;
  background: string;
  foreground: string;
  accent: string;
  highlight: string;
  muted: string;
  contrastRatio: number;
  wcag: 'AAA' | 'AA' | 'fail';
}

export interface ReadingChunk {
  index: number;
  text: string;
  words: number;
  syllables: number;
  estimatedMs: number;
  hardWords: string[];
  bionic: { word: string; bold: string; rest: string }[];
  syllableSplit: string[][];
}

export interface DyslexiaRenderPlan {
  typography: TypographyPlan;
  color: ColorPlan;
  chunks: ReadingChunk[];
  rulerHeightPx: number;
  pacing: { wordsPerMinute: number; totalMs: number; pauseAfterChunkMs: number };
  supports: {
    syllableMarks: boolean;
    bionicEmphasis: boolean;
    readingRuler: boolean;
    wordByWordHighlight: boolean;
    ttsSync: boolean;
    confusableWatch: { pair: string; words: string[] }[];
    irregularWords: string[];
  };
  totalWords: number;
}

/* ------------------------------- colour --------------------------------- */

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return round((hi + 0.05) / (lo + 0.05), 2);
}

/** Tinted-overlay palettes: low-contrast cream/pastel backgrounds reduce
 *  visual stress far more reliably than pure black-on-white. */
export const COLOR_PROFILES: Record<string, Omit<ColorPlan, 'contrastRatio' | 'wcag'>> = {
  cream: { name: 'cream', background: '#FDF6E3', foreground: '#2A2520', accent: '#8C5A2B', highlight: '#FFE08A', muted: '#6E655A' },
  peach: { name: 'peach', background: '#FFEFE4', foreground: '#33261D', accent: '#B5562E', highlight: '#FFD2B0', muted: '#7A6558' },
  mint: { name: 'mint', background: '#E8F6EF', foreground: '#1E2E27', accent: '#27705A', highlight: '#BDEBD7', muted: '#5A6E66' },
  sky: { name: 'sky', background: '#E8F1FA', foreground: '#1C2733', accent: '#2A5E8C', highlight: '#C2DFF7', muted: '#5A6878' },
  lavender: { name: 'lavender', background: '#F2EDFA', foreground: '#271E33', accent: '#5C3F8C', highlight: '#DCCCF5', muted: '#675A78' },
  grey: { name: 'grey', background: '#EDEDED', foreground: '#232323', accent: '#444444', highlight: '#D2D2D2', muted: '#5E5E5E' },
  dark: { name: 'dark', background: '#1B1B1F', foreground: '#E8E6E1', accent: '#F0B86E', highlight: '#3A3A42', muted: '#9B9890' },
  high_contrast: { name: 'high_contrast', background: '#000000', foreground: '#FFFFFF', accent: '#FFD400', highlight: '#005BBB', muted: '#BFBFBF' },
};

export function colorPlan(name = 'cream'): ColorPlan {
  const p = COLOR_PROFILES[name] ?? COLOR_PROFILES.cream;
  const ratio = contrastRatio(p.background, p.foreground);
  return { ...p, contrastRatio: ratio, wcag: ratio >= 7 ? 'AAA' : ratio >= 4.5 ? 'AA' : 'fail' };
}

/* ----------------------------- typography -------------------------------- */

export function typographyPlan(opts: {
  grade?: number;
  severity?: number;           // 0..1 how much support is needed
  lowVision?: boolean;
  preferredFont?: string;
} = {}): TypographyPlan {
  const grade = opts.grade ?? 6;
  const sev = clamp(opts.severity ?? 0.5);
  const base = opts.lowVision ? 26 : 17 + (1 - clamp((grade - 1) / 11)) * 5 + sev * 4;
  const fontStack = [
    opts.preferredFont ?? 'Lexend',
    'Atkinson Hyperlegible',
    'OpenDyslexic',
    'Verdana',
    'Tahoma',
    'system-ui',
    'sans-serif',
  ].filter((v, i, a) => a.indexOf(v) === i);
  return {
    fontStack,
    fontSizePx: Math.round(base),
    lineHeight: round(1.5 + sev * 0.4, 2),
    letterSpacingEm: round(0.03 + sev * 0.07, 3),
    wordSpacingEm: round(0.1 + sev * 0.15, 3),
    paragraphSpacingEm: round(1.0 + sev * 0.8, 2),
    maxLineChars: Math.round(64 - sev * 20 - (opts.lowVision ? 12 : 0)),
    textAlign: 'left',          // never justify: rivers of whitespace hurt tracking
    weight: sev > 0.6 ? 500 : 400,
    caseStyle: 'sentence',      // ALL CAPS removes word-shape cues
  };
}

/* ------------------------------- chunking -------------------------------- */

/** Split text into eye-span-sized chunks that never break mid-clause. */
export function chunkForReading(text: string, maxWords = 9, wpm = 120): ReadingChunk[] {
  const chunks: ReadingChunk[] = [];
  let index = 0;
  for (const sentence of sentences(text)) {
    const tokens = sentence.split(/\s+/).filter(Boolean);
    const groups: string[][] = [];
    let cur: string[] = [];
    for (const tok of tokens) {
      cur.push(tok);
      const atBreak = /[,;:—–)]$/.test(tok) || cur.length >= maxWords;
      if (atBreak && cur.length >= Math.max(3, Math.floor(maxWords / 2))) {
        groups.push(cur);
        cur = [];
      }
    }
    if (cur.length) {
      if (cur.length <= 2 && groups.length) groups[groups.length - 1].push(...cur);
      else groups.push(cur);
    }
    for (const g of groups) {
      const txt = g.join(' ');
      const ws = words(txt);
      const syl = ws.reduce((a, w) => a + syllables(w), 0);
      chunks.push({
        index: index++,
        text: txt,
        words: ws.length,
        syllables: syl,
        estimatedMs: Math.round((ws.length / Math.max(40, wpm)) * 60_000),
        hardWords: ws.filter((w) => syllables(w) >= 3 || IRREGULAR_WORDS.has(w)),
        bionic: bionic(txt),
        syllableSplit: ws.map((w) => hyphenate(w)),
      });
    }
  }
  return chunks;
}

/** Bold the fixation half of each word - the eye only needs the leading cue. */
export function bionic(text: string, ratio = 0.45): { word: string; bold: string; rest: string }[] {
  return text.split(/\s+/).filter(Boolean).map((raw) => {
    const m = raw.match(/^(\W*)([\w'’-]+)(\W*)$/);
    if (!m) return { word: raw, bold: raw, rest: '' };
    const [, pre, core, post] = m;
    const cut = Math.max(1, Math.min(core.length - 1, Math.ceil(core.length * ratio)));
    return { word: raw, bold: pre + core.slice(0, cut), rest: core.slice(cut) + post };
  });
}

/** Which confusable letter pairs actually appear here, and in which words. */
export function confusableWatch(text: string): { pair: string; words: string[] }[] {
  const ws = [...new Set(words(text))];
  const out: { pair: string; words: string[] }[] = [];
  for (const [a, b] of CONFUSABLE_PAIRS) {
    const hits = ws.filter((w) => w.includes(a) && w.includes(b));
    if (hits.length) out.push({ pair: `${a}/${b}`, words: hits.slice(0, 8) });
  }
  return out.sort((x, y) => y.words.length - x.words.length).slice(0, 6);
}

/* ------------------------------ full plan -------------------------------- */

export function buildRenderPlan(text: string, opts: {
  grade?: number;
  severity?: number;
  colorProfile?: string;
  lowVision?: boolean;
  wpm?: number;
  maxChunkWords?: number;
  preferredFont?: string;
} = {}): DyslexiaRenderPlan {
  const sev = clamp(opts.severity ?? 0.5);
  const wpm = opts.wpm ?? Math.round(170 - sev * 80);
  const typography = typographyPlan({
    grade: opts.grade, severity: sev, lowVision: opts.lowVision, preferredFont: opts.preferredFont,
  });
  const chunks = chunkForReading(text, opts.maxChunkWords ?? Math.max(5, Math.round(11 - sev * 5)), wpm);
  const totalWords = chunks.reduce((a, c) => a + c.words, 0);
  const ws = words(text);
  return {
    typography,
    color: colorPlan(opts.colorProfile ?? (sev > 0.6 ? 'peach' : 'cream')),
    chunks,
    rulerHeightPx: Math.round(typography.fontSizePx * typography.lineHeight * 1.2),
    pacing: {
      wordsPerMinute: wpm,
      totalMs: chunks.reduce((a, c) => a + c.estimatedMs, 0),
      pauseAfterChunkMs: Math.round(120 + sev * 380),
    },
    supports: {
      syllableMarks: sev > 0.35,
      bionicEmphasis: sev > 0.2,
      readingRuler: sev > 0.4,
      wordByWordHighlight: sev > 0.55,
      ttsSync: true,
      confusableWatch: confusableWatch(text),
      irregularWords: [...new Set(ws.filter((w) => IRREGULAR_WORDS.has(w)))].slice(0, 20),
    },
    totalWords,
  };
}
