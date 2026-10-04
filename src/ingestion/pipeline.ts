import type { Repos } from '../db/repos.js';
import type { AccessNeed, Concept, Subject } from '../domain/types.js';
import type { GraphService } from '../graph/service.js';
import type { AssessmentService } from '../assessment/service.js';
import type { ModelRouter } from '../llm/router.js';
import { deterministic } from '../llm/providers/deterministic.js';
import { S } from '../llm/jsonschema.js';
import { extract, structureReport, type Extraction, type SourceKind } from './extract.js';
import { analyzeReadability, rankSentences } from '../accessibility/readability.js';
import { transform } from '../accessibility/transformer.js';
import { generateItems } from '../assessment/itemgen.js';
import { hyphenate, keyphrases, sentences, slugify, titleCase, truncate, words } from '../core/textkit.js';
import { clamp, round } from '../core/mathx.js';
import { id as newId } from '../core/ids.js';
import { bus } from '../core/events.js';
import { logger } from '../core/logger.js';

/** THE INGESTION PIPELINE
 *
 *  Raw curriculum in, knowledge graph out. Upload a chapter and the system
 *  tells you: which concepts are in it, which ones depend on which, which
 *  sections will be hardest and why, which vocabulary has to be pre-taught,
 *  and what it would ask to check understanding - before a single learner
 *  sees it. */

export interface IngestRequest {
  content: string | Buffer | Uint8Array;
  kind?: SourceKind | 'auto';
  title?: string;
  subject?: Subject;
  grade?: number;
  sourceRef?: string;
  /** Link detected concepts into the existing graph. */
  linkToGraph?: boolean;
  /** Generate practice items for each detected concept. */
  generateItems?: boolean;
  /** Preview the accessibility transform for these needs. */
  previewNeeds?: AccessNeed[];
  /** Use a hosted model to improve concept detection. */
  useModel?: boolean;
}

export interface DetectedConcept {
  label: string;
  slug: string;
  description: string;
  difficulty: number;
  bloom: string;
  keyTerms: string[];
  /** Where in the document this concept lives. */
  blockIndices: number[];
  evidence: string;
  /** Matched to an existing graph concept, if any. */
  existingConceptId?: string;
  matchConfidence?: number;
  created?: boolean;
  conceptId?: string;
}

export interface HardSection {
  blockIndex: number;
  text: string;
  grade: number;
  difficulty: number;
  reasons: string[];
  suggestion: string;
}

export interface IngestReport {
  documentId: string;
  title: string;
  kind: SourceKind;
  wordCount: number;
  subject: Subject;
  grade: number;
  structure: ReturnType<typeof structureReport>;
  readability: ReturnType<typeof analyzeReadability>;
  concepts: DetectedConcept[];
  prerequisites: { from: string; to: string; rationale: string; created: boolean }[];
  hardSections: HardSection[];
  vocabulary: { term: string; syllables: string; importance: number; whyHard: string }[];
  questionsFound: string[];
  itemsGenerated: number;
  accessibilityPreview?: {
    needs: AccessNeed[];
    gradeBefore: number;
    gradeAfter: number;
    accessibilityIndex: number;
    estimatedMinutes: number;
    appliedTransforms: string[];
  };
  warnings: string[];
  unsupported: string[];
  /** Plain-language summary a teacher can read in ten seconds. */
  headline: string;
  elapsedMs: number;
}

const CONCEPT_SCHEMA = S.obj({
  concepts: S.arr(S.obj({
    label: S.str('a short concept name, 2 to 5 words'),
    description: S.str('one sentence saying what it is'),
    difficulty: S.num('0 easy to 1 hard', { minimum: 0, maximum: 1 }),
    keyTerms: S.arr(S.str('a vocabulary word'), 'up to 4 subject words'),
    evidence: S.str('the sentence from the source that this came from'),
  }, ['label', 'description']), 'the distinct teachable concepts in this text', { minItems: 1, maxItems: 10 }),
  prerequisites: S.arr(S.obj({
    from: S.str('the concept that must come first'),
    to: S.str('the concept it unlocks'),
    rationale: S.str('why'),
  }, ['from', 'to']), 'dependencies BETWEEN the concepts above'),
}, ['concepts']);

export class IngestionPipeline {
  constructor(
    private repos: Repos,
    private graph: GraphService,
    private assessment: AssessmentService,
    private router: ModelRouter,
  ) {
    registerOfflineConceptExtraction();
  }

  async ingest(req: IngestRequest): Promise<IngestReport> {
    const t0 = performance.now();
    const extraction = extract(req.content, req.kind ?? 'auto', req.title);
    const grade = req.grade ?? 8;
    const subject: Subject = req.subject ?? inferSubject(extraction.text);
    const title = req.title ?? extraction.title;
    const warnings = [...extraction.warnings];

    if (!extraction.text.trim()) {
      // Nothing to work with: report it honestly rather than writing an empty
      // document into the graph.
      return {
        documentId: '',
        title, kind: extraction.kind, wordCount: 0, subject, grade,
        structure: structureReport(extraction),
        readability: analyzeReadability('.', grade),
        concepts: [], prerequisites: [], hardSections: [], vocabulary: [],
        questionsFound: [], itemsGenerated: 0,
        warnings, unsupported: extraction.unsupported,
        headline: extraction.unsupported[0]
          ?? 'No readable text was found in this upload, so nothing could be analysed.',
        elapsedMs: Math.round(performance.now() - t0),
      };
    }

    const readability = analyzeReadability(extraction.text, grade);
    const documentId = this.persistDocument(extraction, { title, subject, grade, readability, sourceRef: req.sourceRef });

    const detected = await this.detectConcepts(extraction, { subject, grade, useModel: req.useModel !== false });
    const linked = req.linkToGraph !== false
      ? this.linkConcepts(detected, { subject, grade, documentId })
      : { concepts: detected, prerequisites: [] };

    let itemsGenerated = 0;
    if (req.generateItems !== false) {
      for (const c of linked.concepts) {
        if (!c.conceptId) continue;
        itemsGenerated += this.assessment.ensureItems(c.conceptId, 3).length;
      }
    }

    const hardSections = this.findHardSections(extraction, grade);
    const vocabulary = this.extractVocabulary(extraction.text, grade);
    const questionsFound = extraction.blocks.filter((b) => b.kind === 'question').map((b) => b.text).slice(0, 20);

    const accessibilityPreview = req.previewNeeds?.length
      ? (() => {
          const t = transform({
            text: extraction.text, title, grade,
            needs: req.previewNeeds,
            keepTerms: vocabulary.slice(0, 8).map((v) => v.term),
          });
          return {
            needs: req.previewNeeds!,
            gradeBefore: t.gains.gradeBefore,
            gradeAfter: t.gains.gradeAfter,
            accessibilityIndex: t.gains.accessibilityAfter,
            estimatedMinutes: t.estimatedMinutes,
            appliedTransforms: t.appliedTransforms,
          };
        })()
      : undefined;

    bus.emit('document.ingested', {
      documentId,
      conceptIds: linked.concepts.map((c) => c.conceptId).filter(Boolean) as string[],
      words: extraction.wordCount,
      grade,
    });

    return {
      documentId,
      title,
      kind: extraction.kind,
      wordCount: extraction.wordCount,
      subject,
      grade,
      structure: structureReport(extraction),
      readability,
      concepts: linked.concepts,
      prerequisites: linked.prerequisites,
      hardSections,
      vocabulary,
      questionsFound,
      itemsGenerated,
      accessibilityPreview,
      warnings,
      unsupported: extraction.unsupported,
      headline: this.buildHeadline(linked.concepts, readability, hardSections, vocabulary, grade),
      elapsedMs: Math.round(performance.now() - t0),
    };
  }

  /* ------------------------------ persistence ---------------------------- */

  private persistDocument(
    e: Extraction,
    ctx: { title: string; subject: Subject; grade: number; readability: ReturnType<typeof analyzeReadability>; sourceRef?: string },
  ): string {
    const documentId = newId('doc');
    this.repos.db.tx(() => {
      this.repos.db.insert('documents', {
        id: documentId,
        title: ctx.title,
        source_kind: e.kind,
        source_ref: ctx.sourceRef ?? null,
        subject: ctx.subject,
        grade: ctx.grade,
        raw_text: e.text,
        word_count: e.wordCount,
        readability: ctx.readability.gradeLevel,
        meta: { structure: structureReport(e), warnings: e.warnings, unsupported: e.unsupported },
        created_at: new Date().toISOString(),
      });
      for (const b of e.blocks) {
        const text = b.text.trim();
        if (!text) continue;
        this.repos.db.insert('doc_chunks', {
          id: newId('chk'),
          document_id: documentId,
          idx: b.index,
          kind: b.kind,
          heading: b.kind === 'heading' ? text : null,
          text,
          word_count: words(text).length,
          readability: analyzeReadability(text, ctx.grade).gradeLevel,
          difficulty: rankSentences(text, ctx.grade)[0]?.difficulty ?? null,
          meta: b.meta ?? {},
        });
      }
    });
    return documentId;
  }

  /* ---------------------------- concept detection ------------------------ */

  private async detectConcepts(
    e: Extraction,
    ctx: { subject: Subject; grade: number; useModel: boolean },
  ): Promise<DetectedConcept[]> {
    const structural = this.structuralConcepts(e, ctx);

    if (!ctx.useModel || !this.router.hasHostedModel()) return structural;

    try {
      const { value, res } = await this.router.structured<{
        concepts: { label: string; description: string; difficulty?: number; keyTerms?: string[]; evidence?: string }[];
        prerequisites?: { from: string; to: string; rationale?: string }[];
      }>({
        purpose: 'ingestion.concepts',
        tier: 'balanced',
        schema: CONCEPT_SCHEMA,
        system: 'You identify the distinct teachable concepts in a piece of curriculum material, and the '
          + 'dependencies between them. A concept is something a student could master separately and be '
          + 'assessed on. Do not invent concepts that are not in the text.',
        messages: [{
          role: 'user',
          content: `Subject: ${ctx.subject}. Audience: around grade ${ctx.grade}.\n\n`
            + `SOURCE MATERIAL:\n${truncate(e.text, 6000)}`,
        }],
        seed: `ingest:${e.title}:${e.wordCount}`,
        offlineContext: { topic: e.title, description: e.text, grade: ctx.grade },
      });

      if (res.degraded || !value?.concepts?.length) return structural;

      const modelled: DetectedConcept[] = value.concepts.map((c) => ({
        label: titleCase(truncate(c.label.trim(), 60)),
        slug: slugify(c.label),
        description: truncate(c.description?.trim() ?? '', 300),
        difficulty: clamp(c.difficulty ?? 0.5),
        bloom: 'understand',
        keyTerms: (c.keyTerms ?? []).slice(0, 5),
        blockIndices: this.locateBlocks(e, c.evidence ?? c.label),
        evidence: truncate(c.evidence ?? c.label, 200),
      }));

      // Keep the structural ones the model missed: recall matters more than
      // tidiness when a teacher is checking coverage.
      const have = new Set(modelled.map((m) => m.slug));
      for (const s of structural) if (!have.has(s.slug)) modelled.push(s);
      return modelled.slice(0, 12);
    } catch (err) {
      logger.warn('model concept detection failed, using structural detection', { err: String(err) });
      return structural;
    }
  }

  /** Headings are the author's own concept list; keyphrases fill the gaps. */
  private structuralConcepts(e: Extraction, ctx: { subject: Subject; grade: number }): DetectedConcept[] {
    const out: DetectedConcept[] = [];
    const allHeadings = e.blocks.filter((b) => b.kind === 'heading' && words(b.text).length <= 10);

    // The top-level heading is the document's title, not a teachable concept:
    // "Chapter 7: Electricity" is a container for concepts, not one itself.
    const deepest = allHeadings.length
      ? Math.min(...allHeadings.map((h) => h.level ?? 2))
      : 2;
    const headings = allHeadings.length > 1
      ? allHeadings.filter((h) => (h.level ?? 2) > deepest)
      : allHeadings;
    const effective = headings.length ? headings : allHeadings;

    for (const h of effective) {
      // Stop at the next heading of the same or higher level, so one section's
      // vocabulary does not leak into its neighbour.
      const level = h.level ?? 2;
      const nextHeading = e.blocks.find(
        (b) => b.index > h.index && b.kind === 'heading' && (b.level ?? 2) <= level,
      );
      const end = nextHeading ? nextHeading.index : Number.POSITIVE_INFINITY;
      const body = e.blocks
        .filter((b) => b.index > h.index && b.index < end && b.kind !== 'heading' && b.kind !== 'table')
        .map((b) => b.text).join(' ');
      if (!body && effective.length > 1) continue;
      const description = truncate(sentences(body)[0] ?? body ?? h.text, 240);
      out.push({
        label: titleCase(h.text),
        slug: slugify(h.text),
        description,
        difficulty: clamp(analyzeReadability(body || h.text, ctx.grade).gradeLevel / 14),
        bloom: 'understand',
        keyTerms: keyphrases(body || h.text, 6)
          .map((k) => k.phrase)
          .filter((p) => p.split(' ').length <= 2 && p.length > 3)
          .slice(0, 4),
        blockIndices: [h.index],
        evidence: truncate(h.text, 120),
      });
    }

    if (out.length < 2) {
      // No usable headings: fall back to the densest key phrases, anchored to
      // the sentence that introduced them.
      for (const k of keyphrases(e.text, 6)) {
        if (k.phrase.split(' ').length > 4 || k.phrase.length < 5) continue;
        const anchor = sentences(e.text).find((s) => s.toLowerCase().includes(k.phrase));
        if (!anchor) continue;
        const slug = slugify(k.phrase);
        if (out.some((o) => o.slug === slug)) continue;
        out.push({
          label: titleCase(k.phrase),
          slug,
          description: truncate(anchor, 240),
          difficulty: clamp(analyzeReadability(anchor, ctx.grade).gradeLevel / 14),
          bloom: 'understand',
          keyTerms: [k.phrase],
          blockIndices: this.locateBlocks(e, anchor),
          evidence: truncate(anchor, 200),
        });
        if (out.length >= 8) break;
      }
    }

    if (!out.length) {
      out.push({
        label: titleCase(truncate(e.title, 60)),
        slug: slugify(e.title),
        description: truncate(sentences(e.text)[0] ?? e.text, 240),
        difficulty: clamp(analyzeReadability(e.text, ctx.grade).gradeLevel / 14),
        bloom: 'understand',
        keyTerms: keyphrases(e.text, 3).map((k) => k.phrase),
        blockIndices: [0],
        evidence: truncate(e.text, 200),
      });
    }
    return out;
  }

  private locateBlocks(e: Extraction, needle: string): number[] {
    const n = needle.toLowerCase().slice(0, 60);
    if (!n) return [];
    return e.blocks.filter((b) => b.text.toLowerCase().includes(n)).map((b) => b.index).slice(0, 4);
  }

  /* ------------------------------- graph linking ------------------------- */

  private linkConcepts(
    detected: DetectedConcept[],
    ctx: { subject: Subject; grade: number; documentId: string },
  ): { concepts: DetectedConcept[]; prerequisites: IngestReport['prerequisites'] } {
    const prerequisites: IngestReport['prerequisites'] = [];
    const resolved: DetectedConcept[] = [];

    for (const d of detected) {
      const match = this.findExisting(d);
      if (match) {
        resolved.push({ ...d, existingConceptId: match.concept.id, conceptId: match.concept.id, matchConfidence: match.score, created: false });
        continue;
      }
      const created = this.graph.createConcept({
        label: d.label,
        slug: d.slug,
        description: d.description,
        subject: ctx.subject,
        gradeMin: Math.max(1, ctx.grade - 1),
        gradeMax: Math.min(13, ctx.grade + 2),
        difficulty: d.difficulty,
        documentId: ctx.documentId,
        tags: ['ingested'],
        meta: { ingested: true, documentId: ctx.documentId, evidence: d.evidence },
      });
      for (const term of d.keyTerms.slice(0, 5)) {
        this.repos.terms.put(created.id, {
          term,
          definition: d.description,
          kidDefinition: d.description,
          syllables: hyphenate(term.split(' ')[0]).join('-'),
          importance: 0.7,
        });
      }
      resolved.push({ ...d, conceptId: created.id, created: true });
    }

    // Document order is weak but real evidence of teaching order.
    for (let i = 0; i < resolved.length - 1; i++) {
      const a = resolved[i];
      const b = resolved[i + 1];
      if (!a.conceptId || !b.conceptId || a.conceptId === b.conceptId) continue;
      if (!a.created && !b.created) continue;   // never rewire the curated graph
      try {
        this.graph.link(a.conceptId, b.conceptId, 'leads_to', 0.6, 'appears earlier in the same source material');
        prerequisites.push({ from: a.label, to: b.label, rationale: 'appears earlier in the same source material', created: true });
      } catch (e) {
        prerequisites.push({ from: a.label, to: b.label, rationale: `not linked: ${e instanceof Error ? e.message : String(e)}`, created: false });
      }
    }
    return { concepts: resolved, prerequisites };
  }

  /** Match a detected concept to the existing graph, conservatively. */
  private findExisting(d: DetectedConcept): { concept: Concept; score: number } | null {
    const bySlug = this.repos.concepts.bySlug(d.slug);
    if (bySlug) return { concept: bySlug, score: 1 };

    const candidates = this.repos.concepts.list({ q: d.label.split(' ')[0], limit: 20 });
    let best: { concept: Concept; score: number } | null = null;
    const target = d.label.toLowerCase();
    for (const c of candidates) {
      const label = c.label.toLowerCase();
      const score = label === target ? 1
        : label.includes(target) || target.includes(label) ? 0.85
        : 0;
      if (score > 0.8 && (!best || score > best.score)) best = { concept: c, score };
    }
    return best;
  }

  /* -------------------------------- analysis ----------------------------- */

  private findHardSections(e: Extraction, grade: number): HardSection[] {
    const out: HardSection[] = [];
    for (const b of e.blocks) {
      if (b.kind === 'heading' || !b.text.trim()) continue;
      const ranked = rankSentences(b.text, grade);
      const worst = ranked.sort((x, y) => y.difficulty - x.difficulty)[0];
      if (!worst || worst.difficulty < 0.55) continue;
      out.push({
        blockIndex: b.index,
        text: truncate(worst.text, 220),
        grade: worst.grade,
        difficulty: worst.difficulty,
        reasons: worst.reasons,
        suggestion: suggestionFor(worst.reasons),
      });
    }
    return out.sort((a, b) => b.difficulty - a.difficulty).slice(0, 10);
  }

  private extractVocabulary(text: string, grade: number): IngestReport['vocabulary'] {
    const t = transform({ text, grade, needs: [] });
    return t.glossary.slice(0, 15).map((g) => ({
      term: g.term,
      syllables: g.syllables,
      importance: g.importance,
      whyHard: g.plain,
    }));
  }

  private buildHeadline(
    concepts: DetectedConcept[],
    readability: ReturnType<typeof analyzeReadability>,
    hard: HardSection[],
    vocab: IngestReport['vocabulary'],
    grade: number,
  ): string {
    const created = concepts.filter((c) => c.created).length;
    const matched = concepts.length - created;
    const gap = round(readability.gradeLevel - grade, 1);
    const parts = [
      `Found ${concepts.length} concept${concepts.length === 1 ? '' : 's'}`,
      matched ? `(${matched} already in the graph, ${created} new)` : `(${created} new)`,
      `. This text reads at grade ${readability.gradeLevel}`,
      gap > 1.5 ? `, which is ${gap} grades above your ${grade}s` : `, about right for grade ${grade}`,
      `. ${hard.length} section${hard.length === 1 ? '' : 's'} will be hardest`,
      vocab.length ? `, and ${vocab.length} words need pre-teaching.` : '.',
    ];
    return parts.join('');
  }
}

function suggestionFor(reasons: string[]): string {
  const joined = reasons.join(' ').toLowerCase();
  if (joined.includes('words long')) return 'Split this into two or three shorter sentences.';
  if (joined.includes('clause breaks')) return 'Break the clauses onto separate lines, one idea each.';
  if (joined.includes('unfamiliar words')) return 'Pre-teach these words, or swap them for plainer ones.';
  if (joined.includes('passive')) return 'Rewrite in the active voice so it is clear who does what.';
  return 'Simplify this section, or pair it with a visual.';
}

const SUBJECT_MARKERS: [Subject, RegExp][] = [
  ['math', /\b(fraction|equation|numerator|denominator|algebra|geometry|theorem|multiply|divide|integer|polynomial|quotient)\b/i],
  ['physics', /\b(force|velocity|acceleration|newton|energy|momentum|circuit|voltage|friction|joule|wavelength)\b/i],
  ['chemistry', /\b(atom|molecule|reaction|element|compound|ion|ph\b|acid|base|periodic|electron|covalent)\b/i],
  ['biology', /\b(cell|organism|photosynthesis|dna|gene|enzyme|species|respiration|chromosome|membrane)\b/i],
  ['earth_science', /\b(rock|mineral|tectonic|atmosphere|erosion|climate|orbit|planet|volcano|sediment)\b/i],
  ['computing', /\b(algorithm|variable|function|binary|loop|boolean|compile|array|recursion)\b/i],
  ['history', /\b(century|treaty|empire|revolution|war|dynasty|monarch|colonial|parliament)\b/i],
  ['geography', /\b(population|latitude|climate zone|migration|urban|terrain|continent)\b/i],
  ['english', /\b(paragraph|metaphor|narrator|clause|adjective|comprehension|protagonist|simile)\b/i],
];

export function inferSubject(text: string): Subject {
  const scores = SUBJECT_MARKERS.map(([subject, re]) => ({
    subject,
    score: (text.match(new RegExp(re.source, 'gi')) ?? []).length,
  })).sort((a, b) => b.score - a.score);
  return scores[0].score >= 2 ? scores[0].subject : 'general';
}

/** Offline concept detection: headings and keyphrases only - no invention. */
function registerOfflineConceptExtraction(): void {
  deterministic.register('ingestion.concepts', (ctx) => {
    const text = String(ctx.extra.description ?? ctx.prompt);
    const phrases = keyphrases(text, 5).filter((k) => k.phrase.split(' ').length <= 3);
    return {
      concepts: phrases.map((k) => ({
        label: titleCase(k.phrase),
        description: truncate(sentences(text).find((s) => s.toLowerCase().includes(k.phrase)) ?? k.phrase, 200),
        difficulty: 0.5,
        keyTerms: [k.phrase],
        evidence: k.phrase,
      })),
      prerequisites: [],
    };
  });
}
