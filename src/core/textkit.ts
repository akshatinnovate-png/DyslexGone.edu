/** Language utilities: tokenising, syllables, stemming, similarity, keyphrases. */

export const STOPWORDS = new Set<string>([
  'a','about','above','after','again','against','all','am','an','and','any','are','as','at','be','because','been',
  'before','being','below','between','both','but','by','can','did','do','does','doing','down','during','each','few',
  'for','from','further','had','has','have','having','he','her','here','hers','herself','him','himself','his','how',
  'i','if','in','into','is','it','its','itself','just','me','more','most','my','myself','no','nor','not','now','of',
  'off','on','once','only','or','other','our','ours','ourselves','out','over','own','s','same','she','should','so',
  'some','such','t','than','that','the','their','theirs','them','themselves','then','there','these','they','this',
  'those','through','to','too','under','until','up','very','was','we','were','what','when','where','which','while',
  'who','whom','why','will','with','you','your','yours','yourself','yourselves','also','may','might','must','shall',
]);

const ABBREV = new Set(['mr','mrs','ms','dr','prof','sr','jr','st','vs','etc','fig','eq','approx','e.g','i.e','no']);

export function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z]+(?:['’][a-z]+)?/g) ?? []);
}

export function tokens(text: string): string[] {
  return (text.match(/[A-Za-z]+(?:['’][A-Za-z]+)?|\d+(?:\.\d+)?|[^\sA-Za-z\d]/g) ?? []);
}

/** Sentence splitter that respects abbreviations, decimals and quotes. */
export function sentences(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    buf += c;
    if (c === '.' || c === '!' || c === '?') {
      const next = chars[i + 1] ?? ' ';
      const prevWord = (buf.match(/([A-Za-z.]+)[.!?]$/)?.[1] ?? '').toLowerCase().replace(/\.$/, '');
      const isDecimal = c === '.' && /\d/.test(chars[i - 1] ?? '') && /\d/.test(next);
      const isAbbrev = c === '.' && ABBREV.has(prevWord);
      const isInitial = c === '.' && /^[A-Z]$/.test(chars[i - 1] ?? '') && /\s/.test(next);
      if (isDecimal || isAbbrev || isInitial) continue;
      // consume trailing quotes/brackets
      while (/[”"')\]]/.test(chars[i + 1] ?? '')) { buf += chars[++i]; }
      if (/\s|$/.test(chars[i + 1] ?? '')) { out.push(buf.trim()); buf = ''; }
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

export function paragraphs(text: string): string[] {
  return text.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
}

/* ------------------------------- syllables ------------------------------- */

const SUBTRACT = [
  /cial/, /tia/, /cius/, /cious/, /[^aeiou]giu/, /[aeiou]qu/, /[^aeiou]ely/,
  /sia$/, /\.ely$/, /[^td]ed$/, /[aeiou]le$/,
];
const ADD = [
  /ia/, /riet/, /dien/, /iu/, /io/, /ii/, /[aeiouym]bl$/, /[aeiou]{3}/,
  /^mc/, /ism$/, /([^aeiouy])\1l$/, /[^l]lien/, /^coa[dglx]./,
  /[^gq]ua[^auieo]/, /dnt$/, /uity$/, /[^aeiouy]ying$/, /ie(r|st)$/,
];

/** Heuristic English syllable counter (good enough for readability + chunking). */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
  let count = groups ? groups.length : 1;
  for (const r of SUBTRACT) if (r.test(w)) count--;
  for (const r of ADD) if (r.test(w)) count++;
  return Math.max(1, count);
}

export const syllablesInText = (text: string): number => words(text).reduce((a, w) => a + syllables(w), 0);

/** Split a word into pronounceable chunks for dyslexia-friendly rendering. */
export function hyphenate(word: string): string[] {
  const w = word;
  if (w.length <= 4) return [w];
  const target = syllables(w);
  if (target <= 1) return [w];
  const vowels = /[aeiouyAEIOUY]/;
  const parts: string[] = [];
  let cur = '';
  let seenVowel = false;
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    cur += c;
    const isV = vowels.test(c);
    if (isV) seenVowel = true;
    const nextV = vowels.test(w[i + 1] ?? '');
    // break after a vowel-consonant pair when a vowel follows (VC|V)
    if (seenVowel && !isV && nextV && cur.length >= 2 && parts.length < target - 1 && i < w.length - 2) {
      parts.push(cur);
      cur = '';
      seenVowel = false;
    }
  }
  if (cur) { if (parts.length && cur.length < 2) parts[parts.length - 1] += cur; else parts.push(cur); }
  return parts.length ? parts : [w];
}

/* -------------------------------- stemming ------------------------------- */

/** Compact Porter-style stemmer: enough for term matching and frequency counts. */
export function stem(wordIn: string): string {
  let w = wordIn.toLowerCase();
  if (w.length <= 3) return w;
  const measure = (s: string): number => {
    const seq = s.replace(/[^a-z]/g, '').replace(/[aeiouy]+/g, 'V').replace(/[^V]+/g, 'C');
    return (seq.match(/VC/g) ?? []).length;
  };
  // step 1a
  if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('ies')) w = w.slice(0, -2);
  else if (w.endsWith('ss')) { /* keep */ }
  else if (w.endsWith('s')) w = w.slice(0, -1);
  // step 1b
  if (w.endsWith('eed')) { if (measure(w.slice(0, -3)) > 0) w = w.slice(0, -1); }
  else if (/(ed|ing)$/.test(w)) {
    const base = w.replace(/(ed|ing)$/, '');
    if (/[aeiouy]/.test(base)) {
      w = base;
      if (/(at|bl|iz)$/.test(w)) w += 'e';
      else if (/([^aeiouylsz])\1$/.test(w)) w = w.slice(0, -1);
      else if (measure(w) === 1 && /[^aeiou][aeiouy][^aeiouwxy]$/.test(w)) w += 'e';
    }
  }
  // step 1c
  if (/y$/.test(w) && /[aeiou]/.test(w.slice(0, -1))) w = `${w.slice(0, -1)}i`;
  // step 2/3 (subset)
  const map: [RegExp, string][] = [
    [/ational$/, 'ate'], [/tional$/, 'tion'], [/fulness$/, 'ful'], [/ousness$/, 'ous'],
    [/iveness$/, 'ive'], [/ization$/, 'ize'], [/ation$/, 'ate'], [/ator$/, 'ate'],
    [/alism$/, 'al'], [/aliti$/, 'al'], [/iviti$/, 'ive'], [/biliti$/, 'ble'],
    [/icate$/, 'ic'], [/ative$/, ''], [/alize$/, 'al'], [/iciti$/, 'ic'], [/ical$/, 'ic'], [/ness$/, ''],
  ];
  for (const [re, rep] of map) {
    if (re.test(w) && measure(w.replace(re, '')) > 0) { w = w.replace(re, rep); break; }
  }
  // step 4 (subset)
  const step4 = [/al$/, /ance$/, /ence$/, /er$/, /ic$/, /able$/, /ible$/, /ant$/, /ement$/, /ment$/, /ent$/, /ism$/, /ate$/, /iti$/, /ous$/, /ive$/, /ize$/];
  for (const re of step4) {
    if (re.test(w) && measure(w.replace(re, '')) > 1) { w = w.replace(re, ''); break; }
  }
  if (w.endsWith('e') && measure(w.slice(0, -1)) > 1) w = w.slice(0, -1);
  if (/ll$/.test(w) && measure(w) > 1) w = w.slice(0, -1);
  return w;
}

/* ------------------------------- similarity ------------------------------ */

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aFlags = new Array(a.length).fill(false);
  const bFlags = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - window), hi = Math.min(i + window + 1, b.length);
    for (let j = lo; j < hi; j++) {
      if (!bFlags[j] && a[i] === b[j]) { aFlags[i] = bFlags[j] = true; matches++; break; }
    }
  }
  if (!matches) return 0;
  let k = 0, transpositions = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aFlags[i]) continue;
    while (!bFlags[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const t = transpositions / 2;
  const jaro = (matches / a.length + matches / b.length + (matches - t) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const A = new Set(a), B = new Set(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/* ------------------------------- extraction ------------------------------ */

export function ngrams(xs: readonly string[], n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + n <= xs.length; i++) out.push(xs.slice(i, i + n).join(' '));
  return out;
}

export function wordFrequency(text: string, opts: { stopwords?: boolean; stemmed?: boolean } = {}): Map<string, number> {
  const useStop = opts.stopwords ?? true;
  const m = new Map<string, number>();
  for (const w of words(text)) {
    if (useStop && STOPWORDS.has(w)) continue;
    if (w.length < 3) continue;
    const k = opts.stemmed ? stem(w) : w;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/** RAKE-ish keyphrase extraction: co-occurrence degree / frequency ratio. */
export function keyphrases(text: string, limit = 12): { phrase: string; score: number }[] {
  const candidates: string[][] = [];
  for (const s of sentences(text)) {
    let cur: string[] = [];
    for (const w of (s.toLowerCase().match(/[a-z][a-z'’-]*|\d+/g) ?? [])) {
      if (STOPWORDS.has(w) || w.length < 3) {
        if (cur.length) candidates.push(cur);
        cur = [];
      } else cur.push(w);
    }
    if (cur.length) candidates.push(cur);
  }
  const freq = new Map<string, number>();
  const degree = new Map<string, number>();
  for (const phrase of candidates) {
    for (const w of phrase) {
      freq.set(w, (freq.get(w) ?? 0) + 1);
      degree.set(w, (degree.get(w) ?? 0) + phrase.length - 1);
    }
  }
  const scored = new Map<string, number>();
  for (const phrase of candidates) {
    if (phrase.length > 4) continue;
    const key = phrase.join(' ');
    const score = phrase.reduce((acc, w) => acc + (degree.get(w)! + freq.get(w)!) / freq.get(w)!, 0);
    scored.set(key, Math.max(scored.get(key) ?? 0, score));
  }
  return [...scored.entries()]
    .map(([phrase, score]) => ({ phrase, score: Math.round(score * 100) / 100 }))
    .sort((a, b) => b.score - a.score || a.phrase.localeCompare(b.phrase))
    .slice(0, limit);
}

export function tfidf(docs: readonly string[]): Map<string, number>[] {
  const tfs = docs.map((d) => wordFrequency(d));
  const df = new Map<string, number>();
  for (const tf of tfs) for (const k of tf.keys()) df.set(k, (df.get(k) ?? 0) + 1);
  return tfs.map((tf) => {
    const total = [...tf.values()].reduce((a, b) => a + b, 0) || 1;
    const out = new Map<string, number>();
    for (const [k, v] of tf) out.set(k, (v / total) * Math.log((docs.length + 1) / ((df.get(k) ?? 0) + 1)));
    return out;
  });
}

/* -------------------------------- shaping -------------------------------- */

export const titleCase = (s: string): string =>
  s.replace(/\w[^\s-]*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

export const slugify = (s: string): string =>
  s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 80);

export function truncate(s: string, max: number, suffix = '…'): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - suffix.length);
  const sp = cut.lastIndexOf(' ');
  return `${sp > max * 0.6 ? cut.slice(0, sp) : cut}${suffix}`;
}

export const collapseWhitespace = (s: string): string => s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

export function dedupeAdjacent<T>(xs: readonly T[], key: (x: T) => string = (x) => String(x)): T[] {
  const out: T[] = [];
  let last = '\u0000';
  for (const x of xs) {
    const k = key(x);
    if (k !== last) out.push(x);
    last = k;
  }
  return out;
}
