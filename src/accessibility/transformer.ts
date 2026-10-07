import type { AccessNeed, Modality } from '../domain/types.js';
import { resolveSpec, specConflicts, type AccessibilitySpec } from './profiles.js';
import { analyzeReadability, rankSentences, type ReadabilityReport, type SentenceDifficulty } from './readability.js';
import { elementarize, simplify, type SimplifyResult } from './simplify.js';
import { buildRenderPlan, type DyslexiaRenderPlan } from './dyslexia.js';
import { buildAudioScript, describeVisual, toWebVtt, type AudioScript } from './ssml.js';
import { decodingReport, type DecodeSupport } from './phonics.js';
import { keyphrases, paragraphs, sentences, truncate, words } from '../core/textkit.js';
import { clamp, round } from '../core/mathx.js';
import { MORPHEMES, PLAIN_SWAPS } from './wordlists.js';

/** ============ THE UNIVERSAL ACCESSIBILITY TRANSFORMER ============
 *
 *  One function in: any educational text + who is reading it.
 *  Out: every representation that reader can actually access, plus the exact
 *  render/pacing/narration plans a client needs to deliver them.
 *
 *  Same knowledge. Different doorway. */

export interface TransformRequest {
  text: string;
  title?: string;
  grade?: number;
  needs?: AccessNeed[];
  keepTerms?: string[];
  modalities?: Modality[];
  spec?: Partial<AccessibilitySpec>;
  /** Attach interests so analogies can be personalised. */
  interests?: string[];
}

export interface StructuredOutline {
  title: string;
  sections: { heading: string; summary: string; bullets: string[]; wordCount: number }[];
  totalSections: number;
}

export interface AltTextBundle {
  summary: string;
  longDescription: string;
  dataTable?: { headers: string[]; rows: string[][] };
  spokenDescription: string;
}

export interface TransformResult {
  spec: AccessibilitySpec;
  conflicts: string[];
  source: { title: string; words: number; readability: ReadabilityReport };
  variants: {
    original: string;
    plain: string;              // simplified at target grade
    elementary: string;         // "explain it like I'm 7"
    outline: StructuredOutline; // skeleton for structure-first readers
    bullets: string[];          // scannable
    oneLine: string;            // the single sentence that matters
    glossaryFirst: string;      // pre-teach vocabulary, then the idea
    socratic: string[];         // the same content as a question ladder
  };
  render: DyslexiaRenderPlan;
  audio: { script: AudioScript; vtt: string };
  decoding: DecodeSupport[];
  glossary: { term: string; plain: string; syllables: string; importance: number }[];
  hardSentences: SentenceDifficulty[];
  altText: AltTextBundle;
  simplification: SimplifyResult;
  gains: { gradeBefore: number; gradeAfter: number; accessibilityBefore: number; accessibilityAfter: number; delta: number };
  recommendedModalities: { modality: Modality; score: number; reason: string }[];
  appliedTransforms: string[];
  estimatedMinutes: number;
}

export function transform(req: TransformRequest): TransformResult {
  const grade = req.grade ?? 6;
  const needs = req.needs ?? [];
  const spec = resolveSpec(needs, grade, req.spec);
  const title = req.title ?? truncate(sentences(req.text)[0] ?? 'Lesson', 60);
  const applied: string[] = [];

  const sourceReadability = analyzeReadability(req.text, spec.targetGrade);

  const simplification = simplify(req.text, {
    targetGrade: spec.targetGrade,
    maxSentenceWords: spec.maxChunkWords + 4,
    keepTerms: req.keepTerms,
  });
  applied.push(`simplified ${simplification.operations.length} spans to grade ${spec.targetGrade}`);

  const plain = simplification.text;
  const elementary = elementarize(plain, Math.max(2, spec.targetGrade - 2));
  applied.push('generated elementary retelling');

  const outline = buildOutline(req.text, title);
  applied.push(`extracted ${outline.totalSections}-section outline`);

  const bullets = toBullets(plain);
  const oneLine = coreSentence(plain);
  const glossary = buildGlossary(req.text, simplification, req.keepTerms ?? []);
  const glossaryFirst = [
    'Words you will need:',
    ...glossary.slice(0, 5).map((g) => `- ${g.term}: ${g.plain}`),
    '',
    plain,
  ].join('\n');
  applied.push(`built glossary of ${glossary.length} terms`);

  const socratic = toSocratic(plain, title);
  applied.push('derived socratic question ladder');

  const render = buildRenderPlan(plain, {
    grade: spec.targetGrade,
    severity: spec.severity,
    colorProfile: spec.colorProfile,
    lowVision: needs.includes('low_vision') || needs.includes('blind'),
    maxChunkWords: spec.maxChunkWords,
  });
  applied.push(`chunked into ${render.chunks.length} reading units`);

  const script = buildAudioScript(plain, {
    rate: spec.ttsRate,
    grade: spec.targetGrade,
    emphasizeTerms: glossary.slice(0, 8).map((g) => g.term),
    spellOutHardWords: needs.includes('dyslexia'),
    mathReadAloud: true,
  });
  const vtt = toWebVtt(script);
  applied.push(`narration script ${Math.round(script.totalMs / 1000)}s with ${script.timings.length} word anchors`);
  if (spec.requireCaptions) applied.push('captions generated (WebVTT)');

  const decoding = needs.includes('dyslexia') || needs.includes('language_learner')
    ? decodingReport(req.text, 10)
    : decodingReport(req.text, 4);

  const altText = buildAltText(title, req.text, glossary.map((g) => g.term));
  if (spec.requireAltText) applied.push('alt text + spoken description generated');

  const afterReadability = analyzeReadability(plain, spec.targetGrade);
  const recommendedModalities = rankModalities(spec, sourceReadability, req.modalities);

  const estimatedMinutes = round(
    Math.max(1, (render.pacing.totalMs + script.totalMs * 0.2) / 60_000 + glossary.length * 0.15), 1,
  );

  return {
    spec,
    conflicts: specConflicts(spec),
    source: { title, words: words(req.text).length, readability: sourceReadability },
    variants: { original: req.text, plain, elementary, outline, bullets, oneLine, glossaryFirst, socratic },
    render,
    audio: { script, vtt },
    decoding,
    glossary,
    hardSentences: rankSentences(req.text, spec.targetGrade).filter((s) => s.difficulty > 0.5).slice(0, 8),
    altText,
    simplification,
    gains: {
      gradeBefore: sourceReadability.gradeLevel,
      gradeAfter: afterReadability.gradeLevel,
      accessibilityBefore: sourceReadability.accessibilityIndex,
      accessibilityAfter: afterReadability.accessibilityIndex,
      delta: round(afterReadability.accessibilityIndex - sourceReadability.accessibilityIndex, 3),
    },
    recommendedModalities,
    appliedTransforms: applied,
    estimatedMinutes,
  };
}

/* ------------------------------ sub-builders ------------------------------ */

export function buildOutline(text: string, title: string): StructuredOutline {
  let paras = paragraphs(text);
  if (paras.length <= 1) {
    // No paragraph breaks: group sentences into readable sections instead of
    // returning a one-section outline that tells the reader nothing.
    const sents = sentences(text);
    const per = Math.max(2, Math.ceil(sents.length / Math.min(5, Math.max(2, Math.round(sents.length / 3)))));
    paras = [];
    for (let i = 0; i < sents.length; i += per) paras.push(sents.slice(i, i + per).join(' '));
  }
  const sections = paras.map((p) => {
    const sents = sentences(p);
    const headingSource = sents[0] ?? p;
    const kp = keyphrases(p, 3);
    return {
      heading: truncate(headingSource.replace(/[.!?]$/, ''), 58),
      summary: truncate(sents.slice(0, 2).join(' '), 180),
      bullets: (sents.length > 2 ? sents.slice(1, 5) : kp.map((k) => k.phrase)).map((s) => truncate(s, 110)),
      wordCount: words(p).length,
    };
  });
  return { title, sections, totalSections: sections.length };
}

export function toBullets(text: string): string[] {
  const ranked = rankSentences(text).sort((a, b) => b.words - a.words);
  const important = new Set(ranked.slice(0, Math.max(3, Math.ceil(ranked.length * 0.6))).map((r) => r.index));
  return sentences(text)
    .map((s, i) => ({ s, i }))
    .filter(({ i }) => important.has(i))
    .map(({ s }) => truncate(s.replace(/^(?:However|Therefore|Thus|So|And|But),?\s*/i, ''), 120));
}

/** The sentence with the highest key-term density: usually the actual claim. */
export function coreSentence(text: string): string {
  const kp = new Set(keyphrases(text, 8).map((k) => k.phrase.split(' ')[0]));
  const scored = sentences(text).map((s) => {
    const ws = words(s);
    const hits = ws.filter((w) => kp.has(w)).length;
    const lengthPenalty = Math.abs(ws.length - 16) / 30;
    return { s, score: hits / Math.max(1, ws.length) * 10 - lengthPenalty };
  });
  return scored.sort((a, b) => b.score - a.score)[0]?.s ?? truncate(text, 140);
}

export function buildGlossary(
  text: string,
  simplification: SimplifyResult,
  keepTerms: string[],
): TransformResult['glossary'] {
  const seen = new Map<string, TransformResult['glossary'][number]>();
  const add = (term: string, plain: string, importance: number) => {
    const key = term.toLowerCase();
    const existing = seen.get(key);
    if (existing) {
      existing.importance = Math.max(existing.importance, importance);
      // A real gloss always beats the read-it-in-chunks filler, whatever the
      // lengths are; between two real ones, the fuller one wins.
      const filler = (x: string) => /^a (?:long word|key subject word)\b/.test(x);
      if (filler(existing.plain) !== filler(plain)) {
        if (filler(existing.plain)) existing.plain = plain;
      } else if (plain.length > existing.plain.length) existing.plain = plain;
      return;
    }
    const decode = decodingReport(term, 1)[0];
    seen.set(key, {
      term,
      plain,
      syllables: decode ? decode.syllables.join('-') : term,
      importance: round(importance, 2),
    });
  };

  for (const t of keepTerms) {
    add(t, defineTerm(t, text) ?? 'a key subject word - learn this one rather than replacing it', 1);
  }
  for (const g of simplification.glossary) add(g.term, defineTerm(g.term, text) ?? g.plain, 0.7);
  for (const k of keyphrases(text, 10)) {
    if (k.phrase.split(' ').length > 2 || k.phrase.length <= 4) continue;
    // A glossary entry with no definition is worse than no entry: it tells
    // the learner a word matters and then refuses to say what it means.
    const plain = defineTerm(k.phrase, text);
    if (plain) add(k.phrase, plain, clamp(k.score / 12, 0.3, 0.95));
  }
  return [...seen.values()].sort((a, b) => b.importance - a.importance).slice(0, 18);
}

/** A real definition, or nothing.
 *  Three sources, in order of how much the learner can trust them: the plain
 *  swap table, a definition the passage itself gives, and the word's Greek
 *  and Latin parts. Guessing is not one of them, so a term this cannot
 *  define is left out of the glossary rather than given filler. */
export function defineTerm(term: string, context: string): string | null {
  const t = term.toLowerCase().trim();
  if (PLAIN_SWAPS[t]) return PLAIN_SWAPS[t];

  const selfDef = selfDefinition(t, context);
  if (selfDef) return selfDef;

  // Morphology is per word. Running it over a phrase finds "hemi" inside
  // "chemical energy" and tells a child it means half.
  if (/\s/.test(t)) return null;

  const parts = morphemesIn(t);
  if (parts.length >= 2) {
    return `${parts.map((p) => `"${p.part}" = ${p.meaning}`).join(', ')} - so roughly "${parts.map((p) => p.meaning).join(' ')}"`;
  }
  if (parts.length === 1 && parts[0].part.length >= 4) return `"${parts[0].part}" means ${parts[0].meaning}`;
  return null;
}

/** "A chloroplast is a tiny green part of a cell" - the passage defining its
 *  own vocabulary. Only a nominal predicate counts: "X is stored in glucose"
 *  says what happens to X, not what X is. */
function selfDefinition(term: string, context: string): string | null {
  if (!context) return null;
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = context.match(new RegExp(`\\b${esc}\\b\\s+(is|are|means)\\s+(a|an|the)\\s+([^.;:]{6,80})`, 'i'));
  if (!m) return null;
  const body = m[3].trim();
  // A passive ("is a result of being transported") is a process, not a gloss.
  if (/^(?:result|product|process|consequence)\s+of\b/i.test(body)) return null;
  return `${m[1].toLowerCase() === 'are' ? 'they are' : 'it is'} ${m[2].toLowerCase()} ${body}`;
}

/** Morphemes, anchored. A prefix at the start and a suffix at the end are
 *  what a learner can actually see; an interior match is only trusted when
 *  it is long enough that it cannot be an accident ("synth", not "re"). */
export function morphemesIn(word: string): { part: string; meaning: string }[] {
  const keys = Object.keys(MORPHEMES).sort((a, b) => b.length - a.length);
  const taken: boolean[] = new Array(word.length).fill(false);
  const found: { at: number; part: string; meaning: string }[] = [];
  const claim = (at: number, part: string) => {
    if (at < 0 || taken.slice(at, at + part.length).some(Boolean)) return false;
    for (let i = at; i < at + part.length; i++) taken[i] = true;
    found.push({ at, part, meaning: MORPHEMES[part] });
    return true;
  };

  // Prefix first: it is the part a reader meets first, and claiming it stops
  // "ology" from swallowing the "o" that "bio" needs.
  for (const k of keys) if (k.length >= 2 && word.startsWith(k) && k.length < word.length) { claim(0, k); break; }
  for (const k of keys) if (k.length >= 3 && word.endsWith(k) && claim(word.length - k.length, k)) break;
  for (const k of keys) if (k.length >= 5) claim(word.indexOf(k), k);

  return found.sort((a, b) => a.at - b.at).map(({ part, meaning }) => ({ part, meaning }));
}

/** Convert exposition into a question ladder - the socratic modality. */
export function toSocratic(text: string, title: string): string[] {
  const sents = sentences(text);
  const out: string[] = [`Before we start: what do you already know about ${title.toLowerCase()}?`];
  // A ladder that asks the same thing six times stops being a ladder, so each
  // rung draws from a different question type than the rung before it.
  const RESTATE = [
    (q: string) => `Say this in your own words: "${q}"`,
    (q: string) => `What would you point at to show someone "${q}"?`,
    (q: string) => `Which single word in "${q}" could you not drop without losing the meaning?`,
  ];
  const CAUSAL = [
    (q: string) => `Why would that be true: "${q}"?`,
    (q: string) => `What would have to change for "${q}" to stop being true?`,
    (q: string) => `What causes what here: "${q}"?`,
  ];
  const PREDICT = [
    (q: string) => `What happens next, given "${q}"?`,
    (q: string) => `If you doubled one quantity in "${q}", what follows?`,
    (q: string) => `What would you expect to see, if "${q}"?`,
  ];
  let restate = 0; let causal = 0; let predict = 0; let lastKind = '';
  for (const s of sents.slice(0, 6)) {
    if (words(s).length < 5) continue;
    const q = truncate(s, 90);
    let kind = /\bbecause\b|\bso\b|\bsince\b/i.test(s) ? 'causal'
      : /\bis\b|\bare\b|\bmeans\b/i.test(s) ? 'restate' : 'predict';
    if (kind === lastKind) kind = kind === 'restate' ? 'predict' : 'restate';
    lastKind = kind;
    if (kind === 'causal') out.push(CAUSAL[causal++ % CAUSAL.length](q));
    else if (kind === 'restate') out.push(RESTATE[restate++ % RESTATE.length](q));
    else out.push(PREDICT[predict++ % PREDICT.length](q));
  }
  out.push(`Last one: where would this idea break down or stop working?`);
  return out.slice(0, 8);
}

export function buildAltText(title: string, text: string, labels: string[]): AltTextBundle {
  const core = coreSentence(text);
  const summary = truncate(`${title}: ${core}`, 160);
  const bullets = toBullets(text).slice(0, 5);
  return {
    summary,
    longDescription: [
      `${title}.`,
      core,
      bullets.length ? `Key points: ${bullets.join(' ')}` : '',
      labels.length ? `Labelled parts: ${labels.slice(0, 8).join(', ')}.` : '',
    ].filter(Boolean).join(' '),
    spokenDescription: describeVisual({ kind: 'passage', title, labels: labels.slice(0, 6), summary: core }),
  };
}

/** Score every modality for this reader + this content. */
export function rankModalities(
  spec: AccessibilitySpec,
  readability: ReadabilityReport,
  restrictTo?: Modality[],
): { modality: Modality; score: number; reason: string }[] {
  const base: Partial<Record<Modality, number>> = {
    text: 0.5, audio: 0.5, diagram: 0.5, animation: 0.5, simulation: 0.45, story: 0.4,
    analogy: 0.45, worked_example: 0.55, socratic: 0.4, game: 0.35, spatial: 0.3, manipulative: 0.35,
  };
  const reasons: Partial<Record<Modality, string[]>> = {};
  const note = (m: Modality, r: string) => { (reasons[m] ??= []).push(r); };

  for (const [m, w] of Object.entries(spec.modalityWeights)) {
    base[m as Modality] = (base[m as Modality] ?? 0.4) + (w ?? 0);
    note(m as Modality, 'boosted by access profile');
  }

  if (readability.gradeLevel > spec.targetGrade + 2) {
    base.animation = (base.animation ?? 0.5) + 0.15;
    base.diagram = (base.diagram ?? 0.5) + 0.15;
    base.text = (base.text ?? 0.5) - 0.2;
    note('animation', 'text reads above the learner level');
    note('text', 'source text is too dense as-is');
  }
  if (readability.polysyllabicRatio > 0.2) {
    base.audio = (base.audio ?? 0.5) + 0.12;
    note('audio', 'many long words - hearing them helps decoding');
  }
  if (readability.words > 400) {
    base.worked_example = (base.worked_example ?? 0.5) + 0.1;
    note('worked_example', 'long passage - stepwise structure prevents overload');
  }
  if (spec.reduceMotion) {
    base.animation = (base.animation ?? 0.5) - 0.3;
    note('animation', 'motion reduced for this learner');
  }

  const blocked = new Set(spec.blockedModalities);
  const allow = restrictTo ? new Set(restrictTo) : null;

  return (Object.entries(base) as [Modality, number][])
    .filter(([m]) => !blocked.has(m) && (!allow || allow.has(m)))
    .map(([modality, score]) => ({
      modality,
      score: round(clamp(score), 3),
      reason: (reasons[modality] ?? ['baseline suitability']).join('; '),
    }))
    .sort((a, b) => b.score - a.score);
}
