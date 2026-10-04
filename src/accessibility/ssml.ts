import { sentences, syllables, words } from '../core/textkit.js';
import { clamp, round } from '../core/mathx.js';
import { segmentGraphemes } from './phonics.js';
import { IRREGULAR_WORDS } from './wordlists.js';

/** The audio engine's text side: SSML with prosody, plus a word-timing map so a
 *  frontend can highlight exactly what is being spoken. */

export interface SsmlOptions {
  rate?: number;            // 0.5 .. 1.5, 1 = normal
  pitch?: number;           // semitones, -6 .. +6
  volume?: number;          // 0 .. 1
  voice?: string;
  lang?: string;
  emphasizeTerms?: string[];
  pauseAfterSentenceMs?: number;
  pauseAfterCommaMs?: number;
  spellOutHardWords?: boolean;
  mathReadAloud?: boolean;
  grade?: number;
}

export interface WordTiming { word: string; startMs: number; endMs: number; index: number; emphasized: boolean; }

export interface AudioScript {
  ssml: string;
  plain: string;
  timings: WordTiming[];
  totalMs: number;
  wordsPerMinute: number;
  voice: string;
  prosody: { rate: number; pitch: number; volume: number };
  pronunciations: { word: string; hint: string; phonemes: string }[];
  mathReadings: { source: string; spoken: string }[];
}

const MATH_SPEECH: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/(\d+)\s*\/\s*(\d+)/g, (m) => `${m[1]} over ${m[2]}`],
  [/(-?\d+(?:\.\d+)?)\s*\^\s*2\b/g, (m) => `${m[1]} squared`],
  [/(-?\d+(?:\.\d+)?)\s*\^\s*3\b/g, (m) => `${m[1]} cubed`],
  [/([a-zA-Z0-9.]+)\s*\^\s*([a-zA-Z0-9.]+)/g, (m) => `${m[1]} to the power of ${m[2]}`],
  [/\bsqrt\s*\(([^)]+)\)/gi, (m) => `the square root of ${m[1]}`],
  [/√\s*([a-zA-Z0-9.]+)/g, (m) => `the square root of ${m[1]}`],
  [/([a-zA-Z0-9)]+)\s*≤\s*([a-zA-Z0-9(]+)/g, (m) => `${m[1]} is less than or equal to ${m[2]}`],
  [/([a-zA-Z0-9)]+)\s*≥\s*([a-zA-Z0-9(]+)/g, (m) => `${m[1]} is greater than or equal to ${m[2]}`],
  [/([a-zA-Z0-9)]+)\s*=\s*([a-zA-Z0-9(-]+)/g, (m) => `${m[1]} equals ${m[2]}`],
  [/([a-zA-Z0-9)]+)\s*<\s*([a-zA-Z0-9(]+)/g, (m) => `${m[1]} is less than ${m[2]}`],
  [/([a-zA-Z0-9)]+)\s*>\s*([a-zA-Z0-9(]+)/g, (m) => `${m[1]} is greater than ${m[2]}`],
  [/(\d)\s*×\s*(\d)/g, (m) => `${m[1]} times ${m[2]}`],
  [/(\d)\s*÷\s*(\d)/g, (m) => `${m[1]} divided by ${m[2]}`],
  [/\bpi\b|π/gi, () => 'pie'],
  [/(\d+)\s*%/g, (m) => `${m[1]} percent`],
  [/(\d+)\s*°/g, (m) => `${m[1]} degrees`],
];

export function speakMath(text: string): { spoken: string; readings: { source: string; spoken: string }[] } {
  let out = text;
  const readings: { source: string; spoken: string }[] = [];
  for (const [re, fn] of MATH_SPEECH) {
    out = out.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpMatchArray;
      const spoken = fn(m);
      readings.push({ source: String(m[0]), spoken });
      return spoken;
    });
  }
  return { spoken: out, readings };
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function buildAudioScript(text: string, opts: SsmlOptions = {}): AudioScript {
  const grade = opts.grade ?? 6;
  const rate = clamp(opts.rate ?? (grade <= 3 ? 0.78 : grade <= 6 ? 0.88 : 0.95), 0.4, 1.6);
  const pitch = opts.pitch ?? 0;
  const volume = clamp(opts.volume ?? 1, 0, 1);
  const voice = opts.voice ?? 'narrator-warm';
  const lang = opts.lang ?? 'en-US';
  const sentencePause = opts.pauseAfterSentenceMs ?? Math.round(420 + (8 - Math.min(8, grade)) * 55);
  const commaPause = opts.pauseAfterCommaMs ?? Math.round(sentencePause * 0.45);
  const emphasize = new Set((opts.emphasizeTerms ?? []).map((t) => t.toLowerCase()));

  const mathed = opts.mathReadAloud === false ? { spoken: text, readings: [] } : speakMath(text);
  const plain = mathed.spoken;

  const baseWpm = 165 * rate;
  const msPerWord = 60_000 / baseWpm;

  const timings: WordTiming[] = [];
  const pronunciations: AudioScript['pronunciations'] = [];
  const parts: string[] = [];
  let cursor = 0;
  let wIndex = 0;

  for (const sentence of sentences(plain)) {
    const segs = sentence.split(/(?<=,|;|:)\s+/);
    for (const seg of segs) {
      const segWords = seg.split(/\s+/).filter(Boolean);
      const rendered: string[] = [];
      for (const raw of segWords) {
        const core = raw.replace(/[^A-Za-z'’-]/g, '').toLowerCase();
        const syl = Math.max(1, syllables(core || raw));
        const dur = Math.round(msPerWord * (0.55 + syl * 0.3));
        const emph = emphasize.has(core);
        timings.push({ word: raw, startMs: cursor, endMs: cursor + dur, index: wIndex++, emphasized: emph });
        cursor += dur;

        if (emph) {
          rendered.push(`<emphasis level="strong">${esc(raw)}</emphasis>`);
        } else if (opts.spellOutHardWords && core.length > 7 && IRREGULAR_WORDS.has(core)) {
          const gs = segmentGraphemes(core);
          pronunciations.push({ word: core, hint: gs.filter((g) => g.hint).map((g) => g.hint!).join(' '), phonemes: gs.map((g) => g.phoneme).join(' ') });
          rendered.push(`${esc(raw)}<break time="180ms"/><prosody rate="0.7">${esc(core.split('').join(' '))}</prosody>`);
          cursor += 600;
        } else {
          rendered.push(esc(raw));
        }
      }
      parts.push(rendered.join(' '));
      if (/[,;:]$/.test(seg)) {
        parts.push(`<break time="${commaPause}ms"/>`);
        cursor += commaPause;
      }
    }
    parts.push(`<break time="${sentencePause}ms"/>`);
    cursor += sentencePause;
  }

  const inner = parts.join(' ');
  const ssml =
    `<speak version="1.1" xml:lang="${lang}">` +
    `<voice name="${esc(voice)}">` +
    `<prosody rate="${round(rate, 2)}" pitch="${pitch >= 0 ? '+' : ''}${pitch}st" volume="${Math.round(volume * 100)}%">` +
    inner +
    `</prosody></voice></speak>`;

  const wordCount = words(plain).length;
  return {
    ssml,
    plain,
    timings,
    totalMs: cursor,
    wordsPerMinute: cursor > 0 ? Math.round((wordCount / cursor) * 60_000) : 0,
    voice,
    prosody: { rate: round(rate, 2), pitch, volume: round(volume, 2) },
    pronunciations,
    mathReadings: mathed.readings,
  };
}

/** WebVTT captions derived from the word timings - deaf/HoH support for free. */
export function toWebVtt(script: AudioScript, maxWordsPerCue = 7): string {
  const fmt = (ms: number): string => {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    const cs = Math.floor(ms % 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(3, '0')}`;
  };
  const lines = ['WEBVTT', ''];
  for (let i = 0; i < script.timings.length; i += maxWordsPerCue) {
    const group = script.timings.slice(i, i + maxWordsPerCue);
    if (!group.length) break;
    lines.push(`${Math.floor(i / maxWordsPerCue) + 1}`);
    lines.push(`${fmt(group[0].startMs)} --> ${fmt(group[group.length - 1].endMs)}`);
    lines.push(group.map((g) => g.word).join(' '));
    lines.push('');
  }
  return lines.join('\n');
}

/** Audio description track for a visual asset - blind/low-vision support. */
export function describeVisual(spec: { kind: string; title?: string; labels?: string[]; summary?: string }): string {
  const bits = [
    spec.title ? `A ${spec.kind} titled "${spec.title}".` : `A ${spec.kind}.`,
    spec.summary ?? '',
    spec.labels?.length ? `It is labelled: ${spec.labels.join(', ')}.` : '',
  ].filter(Boolean);
  return bits.join(' ');
}
