import type { ItemRecord, ResponseRecord } from '../domain/types.js';
import { clamp, round } from '../core/mathx.js';
import { words } from '../core/textkit.js';

/** Mines *what kind* of question this learner gets wrong, not just how many.
 *
 *  "61% on algebra" is not actionable. "Fails whenever the question has three
 *  or more steps, regardless of topic" is. */

export type PatternKey =
  | 'multi_step' | 'long_instruction' | 'unfamiliar_vocabulary' | 'negative_numbers'
  | 'fraction_notation' | 'units_required' | 'word_problem' | 'visual_required'
  | 'open_response' | 'recall_only' | 'timed_pressure' | 'multi_part'
  | 'symbolic_notation' | 'inverse_operation' | 'large_numbers' | 'decimals_present';

export interface PatternHit { key: PatternKey; label: string; }

const DETECTORS: { key: PatternKey; label: string; test: (item: ItemRecord) => boolean }[] = [
  { key: 'multi_step', label: 'questions needing three or more steps',
    test: (i) => (i.meta.steps as number ?? countSteps(i.stem)) >= 3 },
  { key: 'long_instruction', label: 'long instructions',
    test: (i) => words(i.stem).length > 35 },
  { key: 'unfamiliar_vocabulary', label: 'unfamiliar subject vocabulary',
    test: (i) => words(i.stem).filter((w) => w.length > 9).length >= 2 },
  { key: 'negative_numbers', label: 'negative numbers',
    test: (i) => /(?:^|[\s(=])-\s?\d/.test(i.stem) || /negative/i.test(i.stem) },
  { key: 'fraction_notation', label: 'fraction notation',
    test: (i) => /\d\s*\/\s*\d/.test(i.stem) || /\bfraction/i.test(i.stem) },
  { key: 'decimals_present', label: 'decimal numbers',
    test: (i) => /\d\.\d/.test(i.stem) },
  { key: 'large_numbers', label: 'numbers above a thousand',
    test: (i) => (i.stem.match(/\d{4,}/g) ?? []).length > 0 },
  { key: 'units_required', label: 'answers that need units',
    test: (i) => /\b(cm|mm|km|m|kg|g|ml|l|s|ms|n|j|w|v|a|ohms?|degrees?|percent)\b/i.test(i.stem) },
  { key: 'word_problem', label: 'word problems (story to equation)',
    // A word problem is a story with numbers in it - it does not have to be long.
    test: (i) => words(i.stem).length >= 10 && /\d/.test(i.stem)
      && /\b(?:has|have|had|buys|bought|sells|sold|needs|travels|costs|shares|gives|gave|spends|walks|runs|drives|fills|cuts|earns|saves|packs|arrives|left|remain|altogether|each|per)\b/i.test(i.stem) },
  { key: 'visual_required', label: 'questions that depend on a diagram',
    test: (i) => /\b(?:diagram|figure|graph|chart|image|shown|picture|table)\b/i.test(i.stem) },
  { key: 'open_response', label: 'open written responses',
    test: (i) => i.kind === 'short_answer' || i.kind === 'explain' },
  { key: 'recall_only', label: 'pure recall questions',
    test: (i) => i.bloom === 'remember' },
  { key: 'multi_part', label: 'multi-part questions',
    test: (i) => /\b(?:and then|also|finally)\b/i.test(i.stem) || (i.stem.match(/\?/g) ?? []).length > 1 },
  { key: 'symbolic_notation', label: 'algebraic or symbolic notation',
    test: (i) => /[a-z]\s*[=+\-*/^]\s*\d|[∑∫√π≤≥≠±×÷]|\^/.test(i.stem) },
  { key: 'inverse_operation', label: 'working backwards (inverse operations)',
    test: (i) => /\bsolve for\b|\bwhat was\b|\boriginal\b|\bbefore\b|\binverse\b/i.test(i.stem) },
  { key: 'timed_pressure', label: 'questions answered under time pressure',
    test: (i) => Boolean(i.meta.timed) },
];

function countSteps(stem: string): number {
  const ops = (stem.match(/[+\-*/=×÷]/g) ?? []).length;
  const connectives = (stem.match(/\b(?:then|after that|next|and then|finally)\b/gi) ?? []).length;
  return Math.max(1, Math.round(ops * 0.6) + connectives + 1);
}

export function featuresOf(item: ItemRecord): PatternHit[] {
  return DETECTORS.filter((d) => {
    try { return d.test(item); } catch { return false; }
  }).map((d) => ({ key: d.key, label: d.label }));
}

export interface PatternStat {
  key: PatternKey;
  label: string;
  attempts: number;
  errors: number;
  errorRate: number;
  /** How much worse than this learner's overall rate, in rate points. */
  lift: number;
  significance: number;  // 0..1, grows with sample size and lift
  verdict: 'confirmed' | 'suspected' | 'insufficient_data';
}

/** Compare each feature's error rate against the learner's own baseline. */
export function minePatterns(
  responses: ResponseRecord[],
  itemLookup: (id: string) => ItemRecord | undefined,
  opts: { minAttempts?: number } = {},
): { patterns: PatternStat[]; baselineErrorRate: number; sample: number } {
  const minAttempts = opts.minAttempts ?? 3;
  const graded = responses.filter((r) => r.itemId);
  const baselineErrors = graded.filter((r) => !r.correct).length;
  const baseline = graded.length ? baselineErrors / graded.length : 0;

  const tally = new Map<PatternKey, { label: string; attempts: number; errors: number }>();
  for (const r of graded) {
    const item = itemLookup(r.itemId!);
    if (!item) continue;
    for (const f of featuresOf(item)) {
      const t = tally.get(f.key) ?? { label: f.label, attempts: 0, errors: 0 };
      t.attempts++;
      if (!r.correct) t.errors++;
      tally.set(f.key, t);
    }
  }

  const patterns: PatternStat[] = [...tally.entries()].map(([key, t]) => {
    const errorRate = t.attempts ? t.errors / t.attempts : 0;
    const lift = errorRate - baseline;
    // Significance needs both a real gap and enough attempts to trust it.
    const significance = clamp((lift / 0.3) * Math.min(1, t.attempts / 8));
    return {
      key,
      label: t.label,
      attempts: t.attempts,
      errors: t.errors,
      errorRate: round(errorRate, 3),
      lift: round(lift, 3),
      significance: round(significance, 3),
      verdict: t.attempts < minAttempts ? 'insufficient_data'
        : significance > 0.4 ? 'confirmed'
        : significance > 0.15 ? 'suspected'
        : 'insufficient_data',
    };
  });

  return {
    patterns: patterns.sort((a, b) => b.significance - a.significance || b.lift - a.lift),
    baselineErrorRate: round(baseline, 3),
    sample: graded.length,
  };
}

/** The presentation changes each confirmed pattern argues for. */
export const PATTERN_REMEDIES: Record<PatternKey, { remedy: string; presentation: string[] }> = {
  multi_step: { remedy: 'Decompose every task into numbered single-action steps.', presentation: ['faded worked examples', 'step checklist visible throughout'] },
  long_instruction: { remedy: 'Chunk instructions to one action per line.', presentation: ['max 8 words per instruction line', 'read-aloud on by default'] },
  unfamiliar_vocabulary: { remedy: 'Pre-teach vocabulary before the task, not inside it.', presentation: ['glossary-first layout', 'syllable marks on long words'] },
  negative_numbers: { remedy: 'Anchor every signed operation to a number line.', presentation: ['number-line manipulative', 'direction arrows'] },
  fraction_notation: { remedy: 'Pair every fraction with a bar or area model.', presentation: ['bar model alongside symbols', 'equal-parts animation'] },
  units_required: { remedy: 'Make the unit part of the answer box, not an afterthought.', presentation: ['unit picker', 'dimension tracking'] },
  word_problem: { remedy: 'Separate comprehension from computation: model first, solve second.', presentation: ['highlight quantities', 'sentence-to-equation scaffold'] },
  visual_required: { remedy: 'Provide a described, high-contrast version of every figure.', presentation: ['alt text + spoken description', 'simplified redraw'] },
  open_response: { remedy: 'Offer sentence starters and let the learner answer by voice.', presentation: ['sentence frames', 'voice response'] },
  recall_only: { remedy: 'Build retrieval with spaced practice, not re-reading.', presentation: ['spaced flashcards', 'retrieval cue ladder'] },
  timed_pressure: { remedy: 'Remove timers entirely for this learner.', presentation: ['untimed mode', 'progress not speed'] },
  multi_part: { remedy: 'Split into separate questions delivered one at a time.', presentation: ['one question per screen'] },
  symbolic_notation: { remedy: 'Introduce each symbol with a spoken name and a concrete meaning.', presentation: ['symbol glossary', 'read-aloud maths'] },
  inverse_operation: { remedy: 'Teach forward and backward together using the same model.', presentation: ['reversible animation', 'balance model'] },
  large_numbers: { remedy: 'Group digits and keep place value visible.', presentation: ['digit grouping', 'place-value columns'] },
  decimals_present: { remedy: 'Align by decimal point and anchor to money.', presentation: ['aligned columns', 'money model'] },
};

export function remediesFor(patterns: PatternStat[]): { pattern: string; remedy: string; presentation: string[] }[] {
  return patterns
    .filter((p) => p.verdict === 'confirmed' || p.verdict === 'suspected')
    .slice(0, 5)
    .map((p) => ({ pattern: p.label, ...PATTERN_REMEDIES[p.key] }));
}
