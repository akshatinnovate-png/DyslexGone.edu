import { sentences, syllables, words, STOPWORDS, stem } from '../core/textkit.js';
import { clamp, mean, round, stdev } from '../core/mathx.js';
import { ACADEMIC_HEDGES, EASY_WORDS, IRREGULAR_WORDS } from './wordlists.js';

export interface ReadabilityReport {
  words: number;
  sentences: number;
  syllables: number;
  characters: number;
  avgWordsPerSentence: number;
  avgSyllablesPerWord: number;
  polysyllabicRatio: number;
  longWordRatio: number;
  hardWordRatio: number;
  typeTokenRatio: number;
  lexicalDensity: number;
  sentenceLengthStdev: number;
  passiveRatio: number;
  nominalizationRatio: number;
  irregularWordRatio: number;
  hedgeCount: number;
  scores: {
    fleschReadingEase: number;
    fleschKincaidGrade: number;
    gunningFog: number;
    smog: number;
    colemanLiau: number;
    automatedReadability: number;
    daleChall: number;
    lix: number;
  };
  /** Consensus US grade level (median of the grade-valued formulas). */
  gradeLevel: number;
  /** 0..1, higher = easier to access. Blends grade fit, density and structure. */
  accessibilityIndex: number;
  flags: string[];
}

const PASSIVE = /\b(?:am|is|are|was|were|be|been|being)\b\s+(?:\w+ly\s+)?\w+(?:ed|en|wn|ne|ung|ought|aid)\b/gi;
const NOMINALIZATION = /\b\w{4,}(?:tion|sion|ment|ness|ity|ance|ence|ancy|ency|ism|ure)\b/gi;

export function analyzeReadability(text: string, targetGrade = 6): ReadabilityReport {
  const sents = sentences(text);
  const ws = words(text);
  const nW = Math.max(1, ws.length);
  const nS = Math.max(1, sents.length);
  const syl = ws.reduce((a, w) => a + syllables(w), 0);
  const chars = ws.join('').length;

  const polysyllabic = ws.filter((w) => syllables(w) >= 3).length;
  const longWords = ws.filter((w) => w.length > 6).length;
  const hardWords = ws.filter((w) => !EASY_WORDS.has(w) && !EASY_WORDS.has(stem(w)) && w.length > 4).length;
  const irregular = ws.filter((w) => IRREGULAR_WORDS.has(w)).length;
  const hedges = ws.filter((w) => ACADEMIC_HEDGES.has(w)).length;
  const types = new Set(ws).size;
  const content = ws.filter((w) => !STOPWORDS.has(w)).length;

  const asl = nW / nS;                       // average sentence length
  const asw = syl / nW;                      // average syllables per word
  const sentLens = sents.map((s) => words(s).length);

  const fleschReadingEase = 206.835 - 1.015 * asl - 84.6 * asw;
  const fleschKincaidGrade = 0.39 * asl + 11.8 * asw - 15.59;
  const pctHard = (hardWords / nW) * 100;
  const gunningFog = 0.4 * (asl + (polysyllabic / nW) * 100);
  const smog = 1.0430 * Math.sqrt(polysyllabic * (30 / nS)) + 3.1291;
  const L = (chars / nW) * 100;
  const Sr = (nS / nW) * 100;
  const colemanLiau = 0.0588 * L - 0.296 * Sr - 15.8;
  const automatedReadability = 4.71 * (chars / nW) + 0.5 * asl - 21.43;
  const rawDaleChall = 0.1579 * pctHard + 0.0496 * asl;
  const daleChall = pctHard > 5 ? rawDaleChall + 3.6365 : rawDaleChall;
  const longRatioPct = (ws.filter((w) => w.length > 6).length / nW) * 100;
  const lix = asl + longRatioPct;

  const gradeCandidates = [fleschKincaidGrade, gunningFog, smog, colemanLiau, automatedReadability, daleChall * 2.2]
    .map((g) => clamp(g, 0, 18));
  const sorted = [...gradeCandidates].sort((a, b) => a - b);
  const gradeLevel = round((sorted[2] + sorted[3]) / 2, 2);

  const passiveRatio = ((text.match(PASSIVE) ?? []).length) / nS;
  const nominalizationRatio = ((text.match(NOMINALIZATION) ?? []).length) / nW;

  const gradeGap = Math.abs(gradeLevel - targetGrade);
  const accessibilityIndex = round(clamp(
    1
    - clamp(gradeGap / 8) * 0.38
    - clamp((asl - 12) / 22) * 0.18
    - clamp(hardWords / nW / 0.35) * 0.18
    - clamp(passiveRatio / 0.5) * 0.12
    - clamp(nominalizationRatio / 0.12) * 0.08
    - clamp((stdev(sentLens) - 4) / 14) * 0.06,
  ), 3);

  const flags: string[] = [];
  if (gradeLevel > targetGrade + 2) flags.push(`reads ${round(gradeLevel - targetGrade, 1)} grades above target`);
  if (asl > 20) flags.push('sentences are long (>20 words average)');
  if (sentLens.some((l) => l > 35)) flags.push('contains a sentence over 35 words');
  if (hardWords / nW > 0.25) flags.push('over a quarter of words are outside core vocabulary');
  if (passiveRatio > 0.35) flags.push('heavy passive voice');
  if (nominalizationRatio > 0.08) flags.push('heavy nominalisation (verbs hidden as nouns)');
  if (hedges > 3) flags.push('academic connectives increase processing load');
  if (polysyllabic / nW > 0.22) flags.push('many 3+ syllable words');
  if (types / nW < 0.35 && nW > 80) flags.push('repetitive vocabulary');

  return {
    words: ws.length,
    sentences: sents.length,
    syllables: syl,
    characters: chars,
    avgWordsPerSentence: round(asl, 2),
    avgSyllablesPerWord: round(asw, 3),
    polysyllabicRatio: round(polysyllabic / nW, 3),
    longWordRatio: round(longWords / nW, 3),
    hardWordRatio: round(hardWords / nW, 3),
    typeTokenRatio: round(types / nW, 3),
    lexicalDensity: round(content / nW, 3),
    sentenceLengthStdev: round(stdev(sentLens), 2),
    passiveRatio: round(passiveRatio, 3),
    nominalizationRatio: round(nominalizationRatio, 4),
    irregularWordRatio: round(irregular / nW, 3),
    hedgeCount: hedges,
    scores: {
      fleschReadingEase: round(clamp(fleschReadingEase, -40, 121), 1),
      fleschKincaidGrade: round(clamp(fleschKincaidGrade, 0, 20), 2),
      gunningFog: round(clamp(gunningFog, 0, 25), 2),
      smog: round(clamp(smog, 0, 20), 2),
      colemanLiau: round(clamp(colemanLiau, 0, 20), 2),
      automatedReadability: round(clamp(automatedReadability, 0, 22), 2),
      daleChall: round(clamp(daleChall, 0, 12), 2),
      lix: round(clamp(lix, 0, 80), 1),
    },
    gradeLevel,
    accessibilityIndex,
    flags,
  };
}

/** Per-sentence difficulty, so the transformer knows exactly what to rewrite. */
export interface SentenceDifficulty {
  index: number;
  text: string;
  words: number;
  grade: number;
  difficulty: number;    // 0..1
  reasons: string[];
}

export function rankSentences(text: string, targetGrade = 6): SentenceDifficulty[] {
  return sentences(text).map((s, index) => {
    const ws = words(s);
    const n = Math.max(1, ws.length);
    const syl = ws.reduce((a, w) => a + syllables(w), 0);
    const grade = clamp(0.39 * n + 11.8 * (syl / n) - 15.59, 0, 20);
    const hard = ws.filter((w) => !EASY_WORDS.has(w) && !EASY_WORDS.has(stem(w)) && w.length > 4);
    const clauses = (s.match(/,|;|\band\b|\bbut\b|\bwhich\b|\bthat\b|\bbecause\b/gi) ?? []).length;
    const reasons: string[] = [];
    if (n > 22) reasons.push(`${n} words long`);
    if (clauses >= 3) reasons.push(`${clauses} clause breaks`);
    if (hard.length >= 3) reasons.push(`unfamiliar words: ${hard.slice(0, 4).join(', ')}`);
    if (PASSIVE.test(s)) reasons.push('passive voice');
    if (grade > targetGrade + 3) reasons.push(`reads at grade ${round(grade, 1)}`);
    const difficulty = clamp(
      clamp((grade - targetGrade) / 8) * 0.45
      + clamp(n / 34) * 0.2
      + clamp(hard.length / 7) * 0.2
      + clamp(clauses / 5) * 0.15,
    );
    return { index, text: s, words: n, grade: round(grade, 2), difficulty: round(difficulty, 3), reasons };
  });
}

/** Mean of sentence-level means - a stable proxy for "how hard is this page". */
export function textDifficulty(text: string, targetGrade = 6): number {
  const ranked = rankSentences(text, targetGrade);
  return ranked.length ? round(mean(ranked.map((r) => r.difficulty)), 3) : 0;
}
