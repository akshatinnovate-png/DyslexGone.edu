import { hyphenate, syllables, words } from '../core/textkit.js';
import { IRREGULAR_WORDS } from './wordlists.js';

/** Grapheme -> phoneme mapping for decoding support, minimal pairs and rhyme. */

export interface Grapheme { text: string; phoneme: string; type: 'consonant' | 'vowel' | 'digraph' | 'blend' | 'silent'; hint?: string; }

const DIGRAPHS: Record<string, { p: string; hint: string }> = {
  ch: { p: '/ch/', hint: 'c and h team up: "chip"' },
  sh: { p: '/sh/', hint: 's and h team up: "ship"' },
  th: { p: '/th/', hint: 'tongue between teeth: "thin"' },
  ph: { p: '/f/', hint: 'ph sounds like f: "phone"' },
  wh: { p: '/w/', hint: 'wh starts like w: "when"' },
  ck: { p: '/k/', hint: 'ck is one /k/ at the end: "duck"' },
  ng: { p: '/ng/', hint: 'back of the throat: "sing"' },
  nk: { p: '/ngk/', hint: '"think" ends with a hum plus k' },
  qu: { p: '/kw/', hint: 'q always brings u: "queen"' },
  gh: { p: '/g/ or silent', hint: 'often silent: "night"' },
  kn: { p: '/n/', hint: 'k is silent: "knee"' },
  wr: { p: '/r/', hint: 'w is silent: "write"' },
  mb: { p: '/m/', hint: 'b is silent at the end: "thumb"' },
  ai: { p: '/ay/', hint: 'two vowels, first one talks: "rain"' },
  ay: { p: '/ay/', hint: 'ay at the end: "play"' },
  ea: { p: '/ee/ or /e/', hint: 'tricky: "bead" vs "bread"' },
  ee: { p: '/ee/', hint: 'long e: "feet"' },
  oa: { p: '/oh/', hint: 'first vowel talks: "boat"' },
  oo: { p: '/oo/ or /u/', hint: '"moon" vs "book"' },
  ou: { p: '/ow/', hint: '"loud"' },
  ow: { p: '/ow/ or /oh/', hint: '"cow" vs "snow"' },
  oi: { p: '/oy/', hint: '"coin"' },
  oy: { p: '/oy/', hint: '"boy"' },
  ie: { p: '/ee/ or /eye/', hint: '"field" vs "pie"' },
  igh: { p: '/eye/', hint: '"light"' },
  ar: { p: '/ar/', hint: 'r changes the vowel: "car"' },
  er: { p: '/er/', hint: '"her"' },
  ir: { p: '/er/', hint: '"bird"' },
  or: { p: '/or/', hint: '"fork"' },
  ur: { p: '/er/', hint: '"turn"' },
  au: { p: '/aw/', hint: '"haul"' },
  aw: { p: '/aw/', hint: '"saw"' },
  ew: { p: '/yoo/', hint: '"few"' },
};

const BLENDS = ['str', 'spr', 'scr', 'spl', 'thr', 'shr', 'squ', 'bl', 'br', 'cl', 'cr', 'dr', 'fl', 'fr', 'gl', 'gr', 'pl', 'pr', 'sc', 'sk', 'sl', 'sm', 'sn', 'sp', 'st', 'sw', 'tr', 'tw'];

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);

export function segmentGraphemes(wordIn: string): Grapheme[] {
  const w = wordIn.toLowerCase().replace(/[^a-z]/g, '');
  const out: Grapheme[] = [];
  let i = 0;
  while (i < w.length) {
    const three = w.slice(i, i + 3);
    const two = w.slice(i, i + 2);
    if (DIGRAPHS[three]) {
      out.push({ text: three, phoneme: DIGRAPHS[three].p, type: 'digraph', hint: DIGRAPHS[three].hint });
      i += 3;
      continue;
    }
    if (DIGRAPHS[two]) {
      out.push({ text: two, phoneme: DIGRAPHS[two].p, type: 'digraph', hint: DIGRAPHS[two].hint });
      i += 2;
      continue;
    }
    if (BLENDS.includes(three)) { out.push({ text: three, phoneme: `/${three}/`, type: 'blend' }); i += 3; continue; }
    if (BLENDS.includes(two)) { out.push({ text: two, phoneme: `/${two}/`, type: 'blend' }); i += 2; continue; }
    const c = w[i];
    if (c === 'e' && i === w.length - 1 && w.length > 3 && !VOWELS.has(w[i - 1])) {
      out.push({ text: 'e', phoneme: 'silent', type: 'silent', hint: 'magic e: it makes the earlier vowel say its name' });
    } else {
      out.push({ text: c, phoneme: `/${c}/`, type: VOWELS.has(c) ? 'vowel' : 'consonant' });
    }
    i += 1;
  }
  return out;
}

export interface DecodeSupport {
  word: string;
  syllables: string[];
  syllableCount: number;
  graphemes: Grapheme[];
  onset: string;
  rime: string;
  isIrregular: boolean;
  strategy: 'sound_it_out' | 'chunk_it' | 'sight_word' | 'find_the_base';
  steps: string[];
  rhymes: string[];
  minimalPairs: string[];
}

export function decodeSupport(wordIn: string): DecodeSupport {
  const word = wordIn.replace(/[^A-Za-z'-]/g, '');
  const lower = word.toLowerCase();
  const syls = hyphenate(lower);
  const graphemes = segmentGraphemes(lower);
  const firstVowel = [...lower].findIndex((c) => VOWELS.has(c));
  const onset = firstVowel > 0 ? lower.slice(0, firstVowel) : '';
  const rime = firstVowel >= 0 ? lower.slice(firstVowel) : lower;
  const irregular = IRREGULAR_WORDS.has(lower);
  const count = syllables(lower);

  const strategy: DecodeSupport['strategy'] = irregular ? 'sight_word'
    : count >= 3 ? 'find_the_base'
    : count === 2 ? 'chunk_it'
    : 'sound_it_out';

  const steps: string[] = [];
  if (strategy === 'sight_word') {
    steps.push(`"${word}" does not follow the rules - learn it by shape.`,
      `Trace it, say it, cover it, write it.`);
  } else if (strategy === 'find_the_base') {
    const base = lower.replace(/^(un|re|dis|pre|mis|non|over|sub|inter|trans)/, '')
      .replace(/(ing|ed|er|est|ly|ness|ment|tion|sion|able|ible|ful|less)$/, '');
    steps.push(`Find the base word: ${base || lower}.`,
      `Now add the pieces back: ${syls.join(' + ')}.`,
      `Say each chunk, then run them together.`);
  } else {
    steps.push(`Break it: ${syls.join(' - ')}.`,
      `Sound each part: ${graphemes.map((g) => g.phoneme).join(' ')}.`,
      `Blend it fast: ${word}.`);
  }
  for (const g of graphemes) if (g.hint) steps.push(`Watch "${g.text}": ${g.hint}`);

  return {
    word,
    syllables: syls,
    syllableCount: count,
    graphemes,
    onset,
    rime,
    isIrregular: irregular,
    strategy,
    steps: [...new Set(steps)].slice(0, 6),
    rhymes: rhymesFor(rime),
    minimalPairs: minimalPairs(lower).slice(0, 5),
  };
}

const RHYME_ONSETS = ['b', 'c', 'd', 'f', 'g', 'h', 'j', 'l', 'm', 'n', 'p', 'r', 's', 't', 'w', 'br', 'cl', 'st', 'tr', 'sh', 'ch'];

export function rhymesFor(rime: string): string[] {
  if (rime.length < 2) return [];
  return RHYME_ONSETS.map((o) => o + rime).slice(0, 8);
}

/** Words that differ by exactly one letter - the classic discrimination drill. */
export function minimalPairs(word: string): string[] {
  const out: string[] = [];
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < word.length; i++) {
    for (const c of alphabet) {
      if (c === word[i]) continue;
      const cand = word.slice(0, i) + c + word.slice(i + 1);
      if (/^(?=.*[aeiou])[a-z]{2,8}$/.test(cand) && plausible(cand)) out.push(cand);
    }
  }
  return [...new Set(out)];
}

const COMMON_RIMES = new Set(['at','an','ap','ad','ag','am','ab','ed','en','et','eg','ell','est','in','it','ip','ig','id','ill','ing','ink','op','ot','og','ob','ock','ug','un','ut','up','ub','ump','ake','ame','ate','ine','ike','ime','ope','ore','oke','old','ail','ain','ead','eat','eep']);

function plausible(w: string): boolean {
  if (/[^a-z]/.test(w)) return false;
  if (/(.)\1\1/.test(w)) return false;
  if (/^[bcdfghjklmnpqrstvwxz]{4}/.test(w)) return false;
  for (const r of COMMON_RIMES) if (w.endsWith(r)) return true;
  return /^[bcdfghjklmnpqrstvwxyz]{1,2}[aeiou]{1,2}[bcdfghjklmnpqrstvwxyz]{1,2}$/.test(w);
}

/** Flag the hardest words in a passage and attach decoding support to each. */
export function decodingReport(text: string, limit = 8): DecodeSupport[] {
  const candidates = [...new Set(words(text))]
    .filter((w) => w.length > 3)
    .map((w) => ({ w, score: syllables(w) * 1.5 + (IRREGULAR_WORDS.has(w) ? 3 : 0) + w.length * 0.2 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return candidates.map((c) => decodeSupport(c.w));
}
