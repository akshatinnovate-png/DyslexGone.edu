import { sentences, words, syllables, stem, collapseWhitespace, truncate, STOPWORDS } from '../core/textkit.js';
import { clamp, round } from '../core/mathx.js';
import { EASY_WORDS, PLAIN_SWAPS, ACADEMIC_HEDGES } from './wordlists.js';
import { analyzeReadability, rankSentences } from './readability.js';

export interface SimplifyOptions {
  targetGrade?: number;
  maxSentenceWords?: number;
  splitClauses?: boolean;
  plainWords?: boolean;
  activeVoice?: boolean;
  defineHardWords?: boolean;
  bulletLongSentences?: boolean;
  keepTerms?: string[];     // never simplify these (the actual subject vocabulary)
}

export interface SimplifyResult {
  text: string;
  original: string;
  operations: { kind: string; from: string; to: string; reason: string }[];
  before: { grade: number; accessibilityIndex: number };
  after: { grade: number; accessibilityIndex: number };
  gradeDrop: number;
  preservedTerms: string[];
  glossary: { term: string; plain: string }[];
}

const SPLIT_CONNECTIVES = [
  'because', 'although', 'though', 'whereas', 'while', 'however', 'therefore',
  'so that', 'in order to', 'which means', 'but', 'and then', 'as a result',
];

/** Passive -> active only happens when we can name the verb with certainty.
 *  Guessing a conjugation is how simplifiers invent non-words like "utilizs",
 *  so an unknown verb is left alone. */
const PASSIVE_AGENT_RE =
  /^(.{2,}?)\s+\b(?:am|is|are|was|were|be|been|being)\b\s+(?:(?:not|also|often|usually|typically|then|later|subsequently|generally|largely|mainly|only|always)\s+)?([a-z]+(?:ed|en|wn|ne|nt|ut|lt|pt|ft|id))\s+by\s+((?:the|a|an)\s+)?([a-z][\w'-]*(?:\s+(?!in|on|at|to|for|of|by|with|from|as|into|onto|than|that|which|who|and|or|but|when|while|because|a|an|the)[a-z][\w'-]*)?)\b(.*)$/i;

/** participle -> third-person-singular present. Curated: no invented words. */
const ACTIVE_VERB: Record<string, string> = {
  used: 'uses', utilized: 'uses', utilised: 'uses', made: 'makes', taken: 'takes',
  given: 'gives', seen: 'sees', eaten: 'eats', written: 'writes', driven: 'drives',
  known: 'knows', grown: 'grows', shown: 'shows', thrown: 'throws', broken: 'breaks',
  chosen: 'chooses', frozen: 'freezes', drawn: 'draws', worn: 'wears', done: 'does',
  held: 'holds', built: 'builds', sent: 'sends', kept: 'keeps', left: 'leaves',
  felt: 'feels', found: 'finds', lost: 'loses', paid: 'pays', said: 'says',
  sold: 'sells', told: 'tells', brought: 'brings', bought: 'buys', caught: 'catches',
  taught: 'teaches', thought: 'thinks', fed: 'feeds', led: 'leads', read: 'reads',
  absorbed: 'absorbs', added: 'adds', allowed: 'allows', applied: 'applies',
  arranged: 'arranges', attached: 'attaches', balanced: 'balances', blocked: 'blocks',
  called: 'calls', carried: 'carries', caused: 'causes', changed: 'changes',
  combined: 'combines', compared: 'compares', completed: 'completes', connected: 'connects',
  consumed: 'consumes', contained: 'contains', controlled: 'controls', converted: 'converts',
  cooled: 'cools', copied: 'copies', counted: 'counts', covered: 'covers',
  created: 'creates', crossed: 'crosses', cut: 'cuts', defined: 'defines',
  delivered: 'delivers', described: 'describes', designed: 'designs', destroyed: 'destroys',
  detected: 'detects', developed: 'develops', divided: 'divides', driven_by: 'drives',
  explained: 'explains', expressed: 'expresses', filled: 'fills', filtered: 'filters',
  followed: 'follows', formed: 'forms', generated: 'generates', heated: 'heats',
  held_by: 'holds', identified: 'identifies', increased: 'increases', joined: 'joins',
  learned: 'learns', lifted: 'lifts', limited: 'limits', linked: 'links',
  marked: 'marks', measured: 'measures', mixed: 'mixes', modelled: 'models',
  moved: 'moves', multiplied: 'multiplies', named: 'names', needed: 'needs',
  observed: 'observes', opened: 'opens', ordered: 'orders', passed: 'passes',
  performed: 'performs', placed: 'places', planned: 'plans', powered: 'powers',
  produced: 'produces', pulled: 'pulls', pushed: 'pushes', reached: 'reaches',
  received: 'receives', recorded: 'records', reduced: 'reduces', reflected: 'reflects',
  released: 'releases', removed: 'removes', repeated: 'repeats', replaced: 'replaces',
  represented: 'represents', required: 'requires', released_by: 'releases',
  rounded: 'rounds', separated: 'separates', shaped: 'shapes', shared: 'shares',
  solved: 'solves', sorted: 'sorts', started: 'starts', stored: 'stores',
  studied: 'studies', supported: 'supports', surrounded: 'surrounds', trapped: 'traps',
  turned: 'turns', transported: 'transports', transformed: 'transforms', treated: 'treats',
  triggered: 'triggers', updated: 'updates', warmed: 'warms', weighed: 'weighs',
  pollinated: 'pollinates', digested: 'digests', powered_by: 'powers', emitted: 'emits',
  released_into: 'releases', captured: 'captures', collected: 'collects', labelled: 'labels',
  labeled: 'labels', calculated: 'calculates', simplified: 'simplifies', balanced_by: 'balances',
};

/** Rule-based text simplification.
 *
 *  Deliberately not a model call: it is deterministic, instant, auditable, and
 *  it never changes the subject vocabulary a student must actually learn. A
 *  hosted model can polish the result afterwards, but the pedagogy is here. */
export function simplify(input: string, opts: SimplifyOptions = {}): SimplifyResult {
  const targetGrade = opts.targetGrade ?? 6;
  const maxWords = opts.maxSentenceWords ?? Math.max(8, Math.round(6 + targetGrade * 1.1));
  const keep = new Set((opts.keepTerms ?? []).map((t) => t.toLowerCase()));
  const ops: SimplifyResult['operations'] = [];
  const glossary: SimplifyResult['glossary'] = [];

  const before = analyzeReadability(input, targetGrade);
  let out: string[] = [];

  for (const sentence of sentences(collapseWhitespace(input))) {
    let working = sentence;

    if (opts.activeVoice !== false) {
      working = depassivize(working, ops);
    }
    if (opts.plainWords !== false) {
      working = plainify(working, keep, ops, glossary);
    }

    const pieces = opts.splitClauses === false ? [working] : splitLongSentence(working, maxWords, ops);
    out.push(...pieces);
  }

  // Bullet out any sentence that is still a list in disguise.
  if (opts.bulletLongSentences !== false) {
    out = out.flatMap((s) => {
      const items = extractInlineList(s);
      if (!items) return [s];
      ops.push({ kind: 'bulleted', from: truncate(s, 60), to: `${items.items.length} bullets`, reason: 'inline list unpacked' });
      return [items.lead, ...items.items.map((i) => `- ${i}`)];
    });
  }

  const text = out.map((s) => s.trim()).filter(Boolean).join(' ')
    .replace(/\s+-\s/g, '\n- ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const after = analyzeReadability(text, targetGrade);
  return {
    text,
    original: input,
    operations: ops,
    before: { grade: before.gradeLevel, accessibilityIndex: before.accessibilityIndex },
    after: { grade: after.gradeLevel, accessibilityIndex: after.accessibilityIndex },
    gradeDrop: round(before.gradeLevel - after.gradeLevel, 2),
    preservedTerms: [...keep],
    glossary,
  };
}

function depassivize(sentence: string, ops: SimplifyResult['operations']): string {
  const m = sentence.match(PASSIVE_AGENT_RE);
  if (!m) return sentence;
  const [, subjectRaw, participle, agentDet, agentHead, tail] = m;
  const third = ACTIVE_VERB[participle.toLowerCase()];
  if (!third) return sentence;                        // unknown verb: leave it alone

  const subject = subjectRaw.trim().replace(/^[,;:]\s*/, '');
  if (!subject || words(subject).length > 9) return sentence;

  const agent = `${agentDet ?? ''}${agentHead}`.trim();
  const active = isPlural(agentHead) ? baseVerb(third) : third;
  const object = subject[0].toLowerCase() + subject.slice(1);
  const rebuilt = `${capitalize(agent)} ${active} ${object}${tail ?? ''}`.replace(/\s{2,}/g, ' ').trim();

  ops.push({ kind: 'active_voice', from: sentence, to: rebuilt, reason: 'passive voice hides who does the action' });
  return rebuilt;
}

const capitalize = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

const SINGULAR_S = new Set(['gas', 'glass', 'mass', 'class', 'process', 'bus', 'lens', 'physics', 'mathematics', 'news', 'species', 'analysis', 'basis', 'axis']);
const ALWAYS_PLURAL = new Set(['people', 'they', 'we', 'you', 'children', 'men', 'women', 'data', 'media']);

function isPlural(noun: string): boolean {
  const n = noun.toLowerCase().trim().split(/\s+/).pop() ?? '';
  if (ALWAYS_PLURAL.has(n)) return true;
  if (SINGULAR_S.has(n) || /(?:ss|us|is|ous|ics)$/.test(n)) return false;
  return n.endsWith('s');
}

/** 'uses' -> 'use', 'carries' -> 'carry', 'pushes' -> 'push', 'does' -> 'do'. */
function baseVerb(third: string): string {
  if (third === 'has') return 'have';
  if (third === 'does') return 'do';
  if (third === 'goes') return 'go';
  if (third.endsWith('ies')) return `${third.slice(0, -3)}y`;
  if (third.endsWith('es') && /(?:ss|x|z|ch|sh|o)es$/.test(third)) return third.slice(0, -2);
  return third.endsWith('s') ? third.slice(0, -1) : third;
}

function plainify(
  sentence: string,
  keep: Set<string>,
  ops: SimplifyResult['operations'],
  glossary: SimplifyResult['glossary'],
): string {
  let s = sentence;

  // multi-word phrases first (longest match wins)
  const phrases = Object.keys(PLAIN_SWAPS).filter((k) => k.includes(' ')).sort((a, b) => b.length - a.length);
  for (const phrase of phrases) {
    const re = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    if (re.test(s)) {
      ops.push({ kind: 'plain_phrase', from: phrase, to: PLAIN_SWAPS[phrase], reason: 'wordy phrase' });
      s = s.replace(re, PLAIN_SWAPS[phrase]);
    }
  }

  s = s.replace(/\b[A-Za-z][\w'-]*\b/g, (w) => {
    const lower = w.toLowerCase();
    if (keep.has(lower)) return w;
    const swap = PLAIN_SWAPS[lower];
    if (swap) {
      ops.push({ kind: 'plain_word', from: w, to: swap, reason: 'simpler synonym available' });
      return matchCase(w, swap);
    }
    if (ACADEMIC_HEDGES.has(lower) && !PLAIN_SWAPS[lower]) {
      glossary.push({ term: w, plain: 'a signpost word - it tells you how the next idea connects' });
    }
    if (syllables(lower) >= 4 && !EASY_WORDS.has(lower) && !EASY_WORDS.has(stem(lower)) && lower.length > 8) {
      if (!glossary.some((g) => g.term.toLowerCase() === lower)) {
        glossary.push({ term: w, plain: unpackNominalization(lower) });
      }
    }
    return w;
  });

  return s;
}

const NOMINAL_ROOTS: Record<string, string> = {
  absorption: 'absorb', description: 'describe', production: 'produce', reaction: 'react',
  creation: 'create', division: 'divide', decision: 'decide', transmission: 'transmit',
  conversion: 'convert', reflection: 'reflect', expansion: 'expand', explanation: 'explain',
  comparison: 'compare', separation: 'separate', formation: 'form', evaporation: 'evaporate',
  condensation: 'condense', respiration: 'breathe', circulation: 'circulate',
  multiplication: 'multiply', subtraction: 'subtract', addition: 'add', equation: 'make equal',
  rotation: 'rotate', revolution: 'go around', vibration: 'vibrate', radiation: 'radiate',
  conduction: 'conduct', insulation: 'insulate', pollination: 'pollinate', digestion: 'digest',
  measurement: 'measure', movement: 'move', development: 'develop', statement: 'state',
  pressure: 'press', mixture: 'mix', structure: 'build', temperature: 'how hot or cold',
  density: 'how tightly packed', velocity: 'speed with a direction', gravity: 'pull toward a mass',
  resistance: 'push back against a flow', difference: 'how far apart two things are',
};

/** Turn 'the transformation of X' into something a reader can picture.
 *  If the root cannot be named with confidence, give a decoding hint instead of
 *  a confidently wrong definition. */
function unpackNominalization(word: string): string {
  const known = NOMINAL_ROOTS[word];
  if (known) return `the "${known}" idea, turned into a noun`;
  const m = word.match(/^(.{3,}?)(ation|tion|sion|ment|ness|ity|ance|ence|ism|ure)$/);
  if (m) {
    const stemPart = m[1];
    for (const cand of [stemPart, `${stemPart}e`, `${stemPart}y`]) {
      if (/^[a-z]{4,}$/.test(cand) && EASY_WORDS.has(cand)) return `the act or result of "${cand}"`;
    }
  }
  const chunks = word.match(/.{1,4}/g)?.join('-') ?? word;
  return `a long word - read it in chunks: ${chunks}`;
}

function matchCase(source: string, replacement: string): string {
  if (source === source.toUpperCase() && source.length > 1) return replacement.toUpperCase();
  if (source[0] === source[0].toUpperCase()) return replacement[0].toUpperCase() + replacement.slice(1);
  return replacement;
}

/** Split on connectives and relative clauses until every piece fits the budget.
 *  Every piece must be a real sentence - a fragment is harder to read than the
 *  long sentence it came from. */
export function splitLongSentence(sentence: string, maxWords: number, ops: SimplifyResult['operations'] = []): string[] {
  if (words(sentence).length <= maxWords) return [sentence];

  for (const conn of SPLIT_CONNECTIVES) {
    const re = new RegExp(`(.{12,}?)[,;]?\\s+${conn}\\s+(.{12,})`, 'i');
    const m = sentence.match(re);
    if (!m) continue;
    const leftRaw = m[1];
    const rightRaw = m[2].trim();
    if (!hasFiniteVerb(leftRaw) || !hasFiniteVerb(rightRaw)) continue;
    const left = punctuate(leftRaw);
    const right = punctuate(bridge(conn, derelativize(rightRaw)));
    ops.push({ kind: 'split', from: truncate(sentence, 70), to: `2 sentences at "${conn}"`, reason: 'sentence over length budget' });
    return [...splitLongSentence(left, maxWords, ops), ...splitLongSentence(right, maxWords, ops)];
  }

  // Relative clause: ", which ..." becomes its own sentence with a real subject.
  const rel = sentence.match(/^(.{14,}?),\s+(which|who|that|where|whose)\s+(.{12,})$/i);
  if (rel && hasFiniteVerb(rel[1]) && hasFiniteVerb(rel[3])) {
    const left = punctuate(rel[1]);
    const right = punctuate(derelativize(`${rel[2]} ${rel[3]}`));
    ops.push({ kind: 'split_relative', from: truncate(sentence, 70), to: 'relative clause promoted to its own sentence', reason: 'embedded clause adds memory load' });
    return [...splitLongSentence(left, maxWords, ops), ...splitLongSentence(right, maxWords, ops)];
  }

  // Last resort: the comma nearest the middle, but only if both halves stand alone.
  const commaIdx = [...sentence.matchAll(/,/g)].map((m) => m.index!);
  if (commaIdx.length) {
    const mid = sentence.length / 2;
    const ordered = [...commaIdx].sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
    for (const at of ordered) {
      const leftRaw = sentence.slice(0, at);
      const rightRaw = sentence.slice(at + 1).trim();
      if (words(leftRaw).length < 4 || words(rightRaw).length < 4) continue;
      if (!hasFiniteVerb(leftRaw) || !hasFiniteVerb(rightRaw)) continue;
      if (isAppositive(rightRaw)) continue;
      // A comma separating a subject from its verb is not a sentence boundary.
      if (VERB_START.test(rightRaw.trim())) continue;
      const left = punctuate(leftRaw);
      const right = punctuate(derelativize(rightRaw));
      ops.push({ kind: 'split', from: truncate(sentence, 70), to: '2 sentences at comma', reason: 'no connective available' });
      return [...splitLongSentence(left, maxWords, ops), ...splitLongSentence(right, maxWords, ops)];
    }
  }
  return [sentence];
}

const VERB_START = /^(?:is|are|was|were|has|have|had|do|does|did|can|could|will|would|should|may|might|must|makes?|gives?|takes?|uses?|shows?|needs?|gets?|goes|comes?|helps?|moves?|works?|happens?|means?|becomes?|turns?|holds?|keeps?|lets?|puts?|forms?|grows?|carries|adds?|pulls?|pushes|changes?|stays?|stands?|falls?|rises?|flows?|stores?|reacts?|absorbs?|reflects?|converts?|combines?|depends?|equals?|appears?|seems?|allows?|causes?|creates?|produces?|requires?|includes?|contains?|describes?|explains?|divides?|multiplies|subtracts?|measures?|facilitates?|represents?|provides?|supports?|affects?)\b/i;

const AUXILIARIES = /\b(?:am|is|are|was|were|be|been|being|has|have|had|do|does|did|can|could|will|would|shall|should|may|might|must)\b/i;
const COMMON_VERBS = /\b(?:make|makes|made|give|gives|gave|take|takes|took|use|uses|used|show|shows|need|needs|get|gets|got|go|goes|went|come|comes|came|help|helps|move|moves|work|works|happen|happens|mean|means|become|becomes|turn|turns|hold|holds|keep|keeps|let|lets|put|puts|form|forms|grow|grows|carry|carries|add|adds|pull|pulls|push|pushes|change|changes|stay|stays|stand|stands|fall|falls|rise|rises|flow|flows|store|stores|react|reacts|absorb|absorbs|reflect|reflects|convert|converts|combine|combines|depend|depends|equal|equals|appear|appears|seem|seems|allow|allows|cause|causes|create|creates|produce|produces|require|requires|include|includes|contain|contains|describe|describes|explain|explains|divide|divides|multiply|multiplies|subtract|subtracts|measure|measures)\b/i;

/** Does this span contain something that can act as a main verb? */
export function hasFiniteVerb(span: string): boolean {
  if (AUXILIARIES.test(span) || COMMON_VERBS.test(span)) return true;
  // a lone -s / -ed token that is not an obvious plural noun or adjective
  return words(span).some((w) =>
    (w.endsWith('ed') && w.length > 4 && !/(?:ness|less|ward|hund)ed$/.test(w))
    || (w.endsWith('s') && w.length > 4 && !/(?:ss|us|is|ous|ics)$/.test(w) && !STOPWORDS.has(w)));
}

/** ", the main pigment ..." is a description of the subject, not a new sentence. */
function isAppositive(right: string): boolean {
  return /^(?:the|a|an|which|who|whose|including|such as|e\.g\.|i\.e\.)\b/i.test(right.trim())
    && !AUXILIARIES.test(right.split(/[,;]/)[0] ?? '');
}

/** Give a promoted relative clause a subject it can stand on. */
function derelativize(span: string): string {
  return span
    .replace(/^which\s+(?:is|are|was|were)\b/i, 'This is')
    .replace(/^which\s+/i, 'This ')
    .replace(/^who\s+/i, 'That person ')
    .replace(/^whose\s+/i, 'Its ')
    .replace(/^that\s+(?:is|are)\b/i, 'That is')
    .replace(/^where\s+/i, 'There ');
}

const BRIDGES: Record<string, string> = {
  because: 'Here is why: ', although: 'But ', though: 'But ', whereas: 'On the other hand, ',
  while: 'At the same time, ', however: 'But ', therefore: 'So ', 'so that': 'That way, ',
  'in order to': 'The goal is to ', 'which means': 'That means ', but: 'But ',
  'and then': 'Then ', 'as a result': 'So ',
};

function bridge(conn: string, rest: string): string {
  const lead = BRIDGES[conn.toLowerCase()] ?? '';
  const body = rest.replace(/^([a-z])/, (c) => (lead ? c : c.toUpperCase()));
  return `${lead}${body}`;
}

function punctuate(s: string): string {
  const t = s.trim().replace(/[,;:]$/, '');
  if (!t) return t;
  const capped = t[0].toUpperCase() + t.slice(1);
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}

/** 'A, B, and C' buried inside a sentence becomes a real list. */
export function extractInlineList(sentence: string): { lead: string; items: string[] } | null {
  const m = sentence.match(/^(.*?[:;]\s*)(.+)$/) ?? sentence.match(/^(.*?\b(?:include|includes|are|were)\b\s*)(.+)$/i);
  if (!m) return null;
  const tail = m[2].replace(/\.$/, '');
  const parts = tail.split(/,\s*(?:and\s+|or\s+)?|\s+and\s+|\s+or\s+/).map((p) => p.trim()).filter((p) => p.length > 2);
  if (parts.length < 3) return null;
  return { lead: m[1].trim().replace(/[:;]$/, ':') || 'These are the parts:', items: parts };
}

/** Rewrite into short, concrete "explain like I'm N" prose, deterministically.
 *  Keeps only the load-bearing sentences and caps them hard. */
export function elementarize(text: string, grade: number): string {
  const g = Math.max(1, grade);
  const r = simplify(text, {
    targetGrade: g,
    maxSentenceWords: Math.max(6, Math.round(4 + g * 0.9)),
    bulletLongSentences: false,
  });
  const ranked = rankSentences(r.text, g);
  if (ranked.length <= 2) return r.text;
  const cutoff = ranked.map((s) => s.difficulty).sort((a, b) => a - b)[Math.floor(ranked.length * 0.7)];
  const kept = ranked
    .filter((s) => s.difficulty <= cutoff && s.words >= 4)
    .slice(0, Math.max(3, Math.ceil(ranked.length * 0.6)))
    .map((s) => s.text);
  const opener = ranked[0].text;   // never drop the sentence that names the topic
  const body = [opener, ...(kept.length ? kept : ranked.slice(1, 3).map((s) => s.text))]
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(' ');
  return `Here is the big idea. ${body}`;
}

/** Score how much easier `after` is than `before`, 0..1. */
export function simplificationGain(before: string, after: string, targetGrade = 6): number {
  const b = analyzeReadability(before, targetGrade);
  const a = analyzeReadability(after, targetGrade);
  return round(clamp((a.accessibilityIndex - b.accessibilityIndex) * 0.6 + clamp((b.gradeLevel - a.gradeLevel) / 6) * 0.4), 3);
}
