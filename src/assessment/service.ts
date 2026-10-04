import type { Repos } from '../db/repos.js';
import type { Concept, ItemRecord } from '../domain/types.js';
import { generateItems, hasSpecificGenerator } from './itemgen.js';
import { grade, scoreSelfExplanation, type GradeResult } from './grading.js';
import { calibrateItem, estimateAbilityEap, selectNextItem, shouldStop, type IrtItem } from './irt.js';
import { eloToTheta } from '../twin/elo.js';
import { logger } from '../core/logger.js';
import { round } from '../core/mathx.js';
import { notFound } from '../core/errors.js';

/** Keeps the item bank alive.
 *
 *  A concept with no items is a concept the system can teach but never check,
 *  which breaks the whole adaptation loop. So the bank is topped up on demand,
 *  procedurally, and recalibrated from real responses as evidence accumulates. */
export class AssessmentService {
  constructor(private repos: Repos) {}

  /** Items for a concept, generating more if the bank is thin. */
  ensureItems(conceptId: string, minimum = 3): ItemRecord[] {
    const concept = this.repos.concepts.get(conceptId);
    if (!concept) throw notFound('concept', conceptId);

    const existing = this.repos.items.forConcept(conceptId, 100);
    if (existing.length >= minimum) return existing;

    const terms = this.repos.terms.forConcept(conceptId);
    const generated = generateItems(concept, terms, {
      count: minimum - existing.length,
      seed: `${concept.slug}:${existing.length}`,
      existingStems: new Set(existing.map((i) => i.stem.trim().toLowerCase())),
    });

    const created: ItemRecord[] = [];
    for (const g of generated) {
      try {
        created.push(this.repos.items.create({
          conceptId,
          kind: g.kind,
          stem: g.stem,
          choices: g.choices,
          answer: g.answer,
          rubric: {},
          difficulty: g.difficulty,
          discrimination: g.discrimination,
          guessing: g.guessing,
          misconceptionMap: g.misconceptionMap,
          bloom: g.bloom,
          pCorrect: null,
          accessibility: {},
          meta: { generated: true, generator: g.generator, explanation: g.explanation },
        }));
      } catch (e) {
        logger.warn('failed to persist a generated item', { conceptId, generator: g.generator, err: String(e) });
      }
    }
    if (created.length) {
      logger.debug('item bank topped up', {
        concept: concept.slug, created: created.length,
        specific: hasSpecificGenerator(concept.slug),
      });
    }
    return [...existing, ...created];
  }

  /** Top up every concept that is thin. Used at seed time and by a job. */
  backfill(minimum = 3, limit = 500): { concept: string; created: number }[] {
    const out: { concept: string; created: number }[] = [];
    for (const concept of this.repos.concepts.list({ limit })) {
      const before = this.repos.items.forConcept(concept.id, 100).length;
      if (before >= minimum) continue;
      const after = this.ensureItems(concept.id, minimum).length;
      if (after > before) out.push({ concept: concept.slug, created: after - before });
    }
    return out;
  }

  /** Next item for a learner on a concept, by maximum information. */
  nextItem(
    learnerId: string,
    conceptId: string,
    opts: { exclude?: Set<string>; seedIndex?: number } = {},
  ): { item: ItemRecord; reason: string; information: number } | null {
    const learner = this.repos.learners.require(learnerId);
    const bank = this.ensureItems(conceptId, 3);
    if (!bank.length) return null;

    const pick = selectNextItem(
      learner.ability,
      bank.map((i) => ({ id: i.id, a: i.discrimination, b: i.difficulty, c: i.guessing })),
      {
        exclude: opts.exclude,
        exposure: new Map(bank.map((i) => [i.id, i.exposures])),
        seedIndex: opts.seedIndex ?? 0,
      },
    );
    if (!pick) return null;
    const item = bank.find((b) => b.id === pick.item.id);
    return item ? { item, reason: pick.reason, information: pick.information } : null;
  }

  /** Grade a raw answer against an item. */
  gradeAnswer(itemId: string, raw: string): GradeResult & { item: ItemRecord } {
    const item = this.repos.items.require(itemId);
    return { ...grade(item, raw), item };
  }

  /** Score an explain-it-back response. */
  gradeExplanation(conceptId: string, response: string) {
    const concept = this.repos.concepts.get(conceptId);
    const terms = this.repos.terms.forConcept(conceptId).map((t) => t.term);
    return scoreSelfExplanation(response, {
      keyTerms: terms.slice(0, 4),
      sourceText: concept?.description,
    });
  }

  /** Re-estimate difficulty and discrimination from accumulated responses.
   *  Hand-set difficulties drift; real responses are the ground truth. */
  recalibrate(opts: { minResponses?: number; limit?: number } = {}): {
    recalibrated: { itemId: string; stem: string; before: { a: number; b: number }; after: { a: number; b: number }; n: number }[];
    skipped: number;
  } {
    const minResponses = opts.minResponses ?? 12;
    const out: ReturnType<AssessmentService['recalibrate']>['recalibrated'] = [];
    let skipped = 0;

    const rows = this.repos.db.all<{ item_id: string; n: number }>(
      `SELECT item_id, COUNT(*) as n FROM responses
       WHERE item_id IS NOT NULL GROUP BY item_id HAVING n >= ? LIMIT ?`,
      [minResponses, opts.limit ?? 200],
    );

    for (const row of rows) {
      const item = this.repos.items.get(row.item_id);
      if (!item) { skipped++; continue; }
      const responses = this.repos.responses.forItem(item.id, 500);
      const observations = responses.map((r) => {
        const m = this.repos.mastery.get(r.learnerId, item.conceptId);
        // Use the learner's ability at the time, approximated by their Elo.
        return { theta: m ? eloToTheta(m.elo) : 0, correct: r.correct };
      });
      const cal = calibrateItem(observations, { guessing: item.guessing });
      if (!cal) { skipped++; continue; }
      const before = { a: item.discrimination, b: item.difficulty };
      // Move partway, not all the way: a single batch should not overwrite
      // everything known about an item.
      const a = round(before.a * 0.5 + cal.a * 0.5, 3);
      const b = round(before.b * 0.5 + cal.b * 0.5, 3);
      this.repos.items.updateCalibration(item.id, b, a);
      out.push({ itemId: item.id, stem: item.stem.slice(0, 60), before, after: { a, b }, n: cal.n });
    }
    return { recalibrated: out, skipped };
  }

  /** Run an adaptive quiz turn: estimate ability, decide whether to stop. */
  adaptiveState(learnerId: string, conceptIds: string[], sessionId?: string) {
    const responses = sessionId
      ? this.repos.responses.forSession(sessionId)
      : this.repos.responses.forLearner(learnerId, 60);
    const scoped = responses.filter((r) => r.itemId && (!conceptIds.length || conceptIds.includes(r.conceptId ?? '')));
    const irt = scoped.map((r) => {
      const i = this.repos.items.get(r.itemId!);
      return i ? { item: { id: i.id, a: i.discrimination, b: i.difficulty, c: i.guessing } as IrtItem, correct: r.correct } : null;
    }).filter(Boolean) as { item: IrtItem; correct: boolean }[];

    const est = estimateAbilityEap(irt);
    const stop = shouldStop({ responses: irt.length, se: est.se }, { minItems: 3, maxItems: 20 });
    return {
      ability: est.theta,
      se: est.se,
      responses: irt.length,
      correct: scoped.filter((r) => r.correct).length,
      stop: stop.stop,
      stopReason: stop.reason,
      posterior: est.posterior.filter((_, i) => i % 4 === 0),
    };
  }

  /** Bank health, so a teacher can see where assessment is thin. */
  bankReport(subject?: string) {
    const concepts = this.repos.concepts.list({ subject, limit: 500 });
    const rows = concepts.map((c: Concept) => {
      const items = this.repos.items.forConcept(c.id, 100);
      const withMisconceptions = items.filter((i) => Object.keys(i.misconceptionMap).length > 0).length;
      const calibrated = items.filter((i) => i.exposures >= 5).length;
      return {
        conceptId: c.id,
        slug: c.slug,
        label: c.label,
        subject: c.subject,
        items: items.length,
        diagnostic: withMisconceptions,
        calibrated,
        generatable: hasSpecificGenerator(c.slug),
        status: items.length === 0 ? 'empty' : items.length < 3 ? 'thin' : 'ok',
      };
    });
    return {
      concepts: rows.sort((a, b) => a.items - b.items),
      totals: {
        concepts: rows.length,
        empty: rows.filter((r) => r.status === 'empty').length,
        thin: rows.filter((r) => r.status === 'thin').length,
        items: rows.reduce((a, r) => a + r.items, 0),
        diagnostic: rows.reduce((a, r) => a + r.diagnostic, 0),
      },
    };
  }
}
