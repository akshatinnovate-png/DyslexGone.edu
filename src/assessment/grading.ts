import type { ItemRecord } from '../domain/types.js';
import { answerMatches, parseFraction } from '../misconception/detectors.js';
import { clamp, round } from '../core/mathx.js';
import { jaroWinkler, stem, STOPWORDS, words } from '../core/textkit.js';

/** Grading that distinguishes "wrong" from "nearly right" from "right but
 *  phrased differently". A learner punished for writing 0.5 instead of 1/2
 *  learns that the system is arbitrary. */

export interface GradeResult {
  correct: boolean;
  score: number;             // 0..1, partial credit where it makes sense
  normalized: string;
  expected: string;
  matchKind: 'exact' | 'equivalent' | 'tolerance' | 'alias' | 'partial' | 'rubric' | 'none';
  feedback: string;
  /** For open responses: which rubric points were hit. */
  rubric?: { point: string; hit: boolean; evidence?: string }[];
  /** Flags worth passing to the misconception engine. */
  signals: string[];
}

const normalize = (s: string): string =>
  s.trim().toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '');

const stripUnits = (s: string): string =>
  s.replace(/\b(cm|mm|km|m|kg|g|ml|l|s|ms|n|j|w|v|a|ohms?|units?|square\s+\w+|degrees?|percent|%)\b/gi, '').trim();

export function grade(item: ItemRecord, raw: string): GradeResult {
  const given = normalize(raw);
  const signals: string[] = [];
  if (!given) {
    return {
      correct: false, score: 0, normalized: '', expected: String(item.answer.value),
      matchKind: 'none', feedback: 'No answer was given.', signals: ['blank'],
    };
  }

  switch (item.kind) {
    case 'mcq':
    case 'true_false':
      return gradeChoice(item, given, signals);
    case 'numeric':
      return gradeNumeric(item, given, raw, signals);
    case 'explain':
      return gradeOpen(item, raw, signals);
    case 'short_answer':
    default:
      return gradeShort(item, given, raw, signals);
  }
}

function gradeChoice(item: ItemRecord, given: string, signals: string[]): GradeResult {
  const expectedKey = String(item.answer.value).toLowerCase();
  const byKey = item.choices.find((c) => c.key.toLowerCase() === given);
  const byText = item.choices.find((c) => normalize(c.text) === given);
  const chosen = byKey ?? byText;

  if (!chosen) {
    return {
      correct: false, score: 0, normalized: given, expected: expectedKey,
      matchKind: 'none',
      feedback: `"${given}" is not one of the options.`,
      signals: [...signals, 'off_option'],
    };
  }
  const correct = chosen.key.toLowerCase() === expectedKey;
  if (!correct && chosen.misconceptionCode) signals.push(`distractor:${chosen.misconceptionCode}`);

  return {
    correct,
    score: correct ? 1 : 0,
    normalized: chosen.key,
    expected: expectedKey,
    matchKind: byKey ? 'exact' : 'equivalent',
    feedback: correct
      ? 'Correct.'
      : chosen.misconceptionCode
        ? 'Not quite - and that particular option tells me exactly what happened.'
        : 'Not quite.',
    signals,
  };
}

function gradeNumeric(item: ItemRecord, given: string, raw: string, signals: string[]): GradeResult {
  const expected = item.answer.value;
  const tolerance = item.answer.tolerance ?? 1e-6;
  const cleaned = stripUnits(given);

  if (typeof expected === 'number') {
    if (answerMatches(cleaned, expected, tolerance)) {
      return {
        correct: true, score: 1, normalized: cleaned, expected: String(expected),
        matchKind: cleaned === String(expected) ? 'exact' : 'equivalent',
        feedback: 'Correct.', signals,
      };
    }
    const n = Number(cleaned.replace(/[^\d.eE+-]/g, ''));
    if (Number.isFinite(n)) {
      // Near misses are worth distinguishing: a sign slip is not the same
      // mistake as having no idea.
      if (Math.abs(n + expected) < tolerance) signals.push('sign_error');
      else if (Math.abs(n - expected * 10) < tolerance || Math.abs(n - expected / 10) < tolerance) signals.push('place_value_error');
      else if (Math.abs(n - expected) <= Math.abs(expected) * 0.1) signals.push('close');

      const partial = signals.includes('sign_error') || signals.includes('place_value_error') ? 0.3 : 0;
      return {
        correct: false, score: partial, normalized: String(n), expected: String(expected),
        matchKind: partial > 0 ? 'partial' : 'none',
        feedback: signals.includes('sign_error')
          ? 'The size is right but the sign is not - check the direction.'
          : signals.includes('place_value_error')
            ? 'The digits are right but the place value is out by a factor of ten.'
            : 'Not quite.',
        signals,
      };
    }
    signals.push('non_numeric');
    return {
      correct: false, score: 0, normalized: cleaned, expected: String(expected),
      matchKind: 'none', feedback: 'That does not look like a number.', signals,
    };
  }
  return gradeShort(item, given, raw, signals);
}

function gradeShort(item: ItemRecord, given: string, raw: string, signals: string[]): GradeResult {
  const expected = String(item.answer.value);
  const aliases = [expected, ...(item.answer.aliases ?? [])].map(normalize);
  const cleaned = normalize(stripUnits(given));

  for (const a of aliases) {
    if (cleaned === normalize(stripUnits(a))) {
      return {
        correct: true, score: 1, normalized: cleaned, expected,
        matchKind: cleaned === normalize(expected) ? 'exact' : 'alias',
        feedback: 'Correct.', signals,
      };
    }
  }

  // Fractions and decimals naming the same quantity are the same answer.
  const givenFrac = parseFraction(cleaned);
  for (const a of aliases) {
    const aliasFrac = parseFraction(a);
    const aliasNum = Number(a);
    if (givenFrac && aliasFrac && givenFrac.n * aliasFrac.d === aliasFrac.n * givenFrac.d) {
      return {
        correct: true, score: 1, normalized: cleaned, expected,
        matchKind: 'equivalent',
        feedback: 'Correct - that is the same value written differently.', signals,
      };
    }
    if (givenFrac && Number.isFinite(aliasNum) && Math.abs(givenFrac.n / givenFrac.d - aliasNum) < 1e-6) {
      return {
        correct: true, score: 1, normalized: cleaned, expected,
        matchKind: 'equivalent', feedback: 'Correct.', signals,
      };
    }
  }

  // Spelling slips should not read as not knowing the answer.
  const sim = Math.max(...aliases.map((a) => jaroWinkler(cleaned, a)));
  if (sim > 0.92) {
    signals.push('spelling');
    return {
      correct: true, score: 0.9, normalized: cleaned, expected,
      matchKind: 'equivalent',
      feedback: 'Correct - check the spelling, but the answer is right.', signals,
    };
  }
  if (sim > 0.8) {
    signals.push('near_miss');
    return {
      correct: false, score: 0.4, normalized: cleaned, expected,
      matchKind: 'partial',
      feedback: 'Very close. Look at it once more.', signals,
    };
  }
  return {
    correct: false, score: 0, normalized: cleaned, expected,
    matchKind: 'none', feedback: 'Not quite.', signals,
  };
}

/* ------------------------------ open response ----------------------------- */

export interface Rubric {
  /** Ideas that must appear. Each is a set of acceptable surface forms. */
  points: { point: string; any: string[] }[];
  minWords?: number;
  /** Phrases that indicate a misconception rather than an answer. */
  redFlags?: { phrase: string; misconceptionCode?: string; note: string }[];
}

/** Score an explanation against a rubric of IDEAS, not wording.
 *
 *  Deliberately generous on phrasing and strict on substance: a learner who
 *  says "the bottom number is how many pieces you cut it into" has the idea,
 *  even though they used none of the textbook words. */
export function gradeOpen(item: ItemRecord, raw: string, signals: string[]): GradeResult {
  const rubric = buildRubric(item);
  const text = raw.toLowerCase();
  const tokens = new Set(words(text).map((w) => stem(w)));
  const contentWords = words(text).filter((w) => !STOPWORDS.has(w));

  const results = rubric.points.map((p) => {
    const hit = p.any.some((phrase) => {
      const ph = phrase.toLowerCase().trim();
      if (ph.includes(' ')) return text.includes(ph);
      return tokens.has(stem(ph));
    });
    return { point: p.point, hit, evidence: hit ? p.any.find((a) => text.includes(a.toLowerCase())) : undefined };
  });

  const hits = results.filter((r) => r.hit).length;
  const coverage = rubric.points.length ? hits / rubric.points.length : 0;

  const tooShort = contentWords.length < (rubric.minWords ?? 6);
  if (tooShort) signals.push('too_brief');

  for (const flag of rubric.redFlags ?? []) {
    if (text.includes(flag.phrase.toLowerCase())) {
      signals.push(flag.misconceptionCode ? `distractor:${flag.misconceptionCode}` : `red_flag:${flag.phrase}`);
    }
  }

  const score = round(clamp(coverage * (tooShort ? 0.6 : 1)), 3);
  const correct = score >= 0.6 && !tooShort;

  const missing = results.filter((r) => !r.hit).map((r) => r.point);
  const feedback = correct
    ? hits === rubric.points.length
      ? 'That covers it - you have the whole idea.'
      : `Good - you have the main idea. One thing to add: ${missing[0]}.`
    : tooShort
      ? 'Say a bit more. What would you tell someone who had never heard of this?'
      : missing.length
        ? `Part of it is there. Still missing: ${missing.slice(0, 2).join('; ')}.`
        : 'Have another go at putting it in your own words.';

  return {
    correct,
    score,
    normalized: raw.trim().slice(0, 200),
    expected: rubric.points.map((p) => p.point).join('; '),
    matchKind: 'rubric',
    feedback,
    rubric: results,
    signals,
  };
}

/** Derive a rubric from the item, or from the concept text behind it. */
function buildRubric(item: ItemRecord): Rubric {
  const stored = item.rubric as Partial<Rubric>;
  if (stored?.points?.length) return stored as Rubric;

  // Fall back to the expected answer text: its content words become the ideas
  // the learner is expected to touch.
  const expected = String(item.answer.value ?? '');
  const content = words(expected)
    .filter((w) => !STOPWORDS.has(w) && w.length > 3)
    .filter((w, i, a) => a.indexOf(w) === i)
    .slice(0, 5);

  return {
    points: content.map((w) => ({ point: `mentions "${w}"`, any: [w] })),
    minWords: 6,
  };
}

/** Self-explanation quality: does the learner's own account hold together?
 *  Used after a lesson, where there is no single right answer. */
export interface SelfExplanationScore {
  score: number;
  depth: 'none' | 'restatement' | 'paraphrase' | 'reasoning' | 'transfer';
  usesCausalLanguage: boolean;
  usesKeyTerms: string[];
  missingTerms: string[];
  wordCount: number;
  feedback: string;
  prompt: string;
}

const CAUSAL = /\b(because|so|therefore|since|that means|which causes|leads to|as a result|if .* then|the reason)\b/i;
const TRANSFER = /\b(like|similar to|same as|for example|in the same way|just as|imagine|think of)\b/i;

export function scoreSelfExplanation(
  response: string,
  opts: { keyTerms?: string[]; sourceText?: string },
): SelfExplanationScore {
  const text = response.trim();
  const wordCount = words(text).length;
  const keyTerms = (opts.keyTerms ?? []).map((t) => t.toLowerCase());
  const tokens = new Set(words(text.toLowerCase()).map((w) => stem(w)));
  const used = keyTerms.filter((t) => t.includes(' ') ? text.toLowerCase().includes(t) : tokens.has(stem(t)));
  const missing = keyTerms.filter((t) => !used.includes(t));

  const causal = CAUSAL.test(text);
  const transfer = TRANSFER.test(text);

  // Copying the source back is not understanding, and should not score as it.
  const copied = opts.sourceText
    ? overlapRatio(text.toLowerCase(), opts.sourceText.toLowerCase()) > 0.75
    : false;

  let depth: SelfExplanationScore['depth'] = 'none';
  if (wordCount < 4) depth = 'none';
  else if (copied) depth = 'restatement';
  else if (transfer && causal) depth = 'transfer';
  else if (causal) depth = 'reasoning';
  else depth = 'paraphrase';

  const depthScore = { none: 0, restatement: 0.2, paraphrase: 0.5, reasoning: 0.8, transfer: 1 }[depth];
  // With no key terms to check, term coverage is vacuously satisfied - so it
  // must not pay out on its own, or an empty answer scores for saying nothing.
  const termScore = keyTerms.length ? used.length / keyTerms.length : 1;
  const score = depth === 'none'
    ? 0
    : round(clamp(depthScore * 0.65 + termScore * 0.25 + clamp(wordCount / 40) * 0.1), 3);

  const feedback =
    depth === 'none' ? 'Have a go - even one sentence helps me see what you are thinking.'
    : depth === 'restatement' ? 'That is close to the words I used. Try saying it without looking - in your own words.'
    : depth === 'paraphrase' ? 'Good start. Now add a "because" - why does it work that way?'
    : depth === 'reasoning' ? 'That is real reasoning. Can you think of another situation where the same idea applies?'
    : 'Excellent - you explained why AND connected it to something else. That is understanding.';

  const prompt =
    depth === 'transfer' ? 'Where would this idea stop working?'
    : depth === 'reasoning' ? 'Give me an example from outside this subject.'
    : missing.length ? `Try again using the word "${missing[0]}".`
    : 'Add one sentence starting with "because".';

  return {
    score, depth,
    usesCausalLanguage: causal,
    usesKeyTerms: used,
    missingTerms: missing,
    wordCount,
    feedback,
    prompt,
  };
}

function overlapRatio(a: string, b: string): number {
  const A = new Set(words(a).filter((w) => !STOPWORDS.has(w)));
  const B = new Set(words(b).filter((w) => !STOPWORDS.has(w)));
  if (!A.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / A.size;
}
