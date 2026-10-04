import type { Repos } from '../db/repos.js';
import type {
  AccessNeed, CognitiveLoadEstimate, FrictionSignal, Learner, MasteryRecord, Modality, ResponseRecord,
} from '../domain/types.js';
import { ALL_MODALITIES } from '../domain/types.js';
import { GraphService } from '../graph/service.js';
import { bktPredict, bktUpdate, opportunitiesToMastery, paramsFor, type BktParams } from './bkt.js';
import { eloToTheta, eloUpdate, thetaToElo } from './elo.js';
import { ratingFrom, recoveryNeeds, retention, review, type MemoryState, type RecoveryNeed } from './fsrs.js';
import { armEstimates, computeReward, hasClearWinner, selectModality, updateArm, type Arm, type Selection } from './bandit.js';
import { detectFriction, estimateLoad, frictionVerdict, latencyBaseline, type FrictionVerdict } from './cogload.js';
import { featuresOf, minePatterns, remediesFor, type PatternStat } from './errorpatterns.js';
import { resolveSpec, type AccessibilitySpec } from '../accessibility/profiles.js';
import { clamp, mean, round } from '../core/mathx.js';
import { DAY } from '../core/clock.js';
import { bus } from '../core/events.js';
import { config } from '../core/config.js';
import { id as newId } from '../core/ids.js';

/** ===================== THE LEARNER DIGITAL TWIN =====================
 *
 *  A continuously updated model of how one mind learns. Not a medical record -
 *  a learning model: what is known, how firmly, in which representation it
 *  landed, which question shapes break it, and how much load it is under right
 *  now. Four engines run together and cross-check each other:
 *
 *    BKT   - per-concept probability of knowing
 *    Elo   - global ability vs item difficulty, self-calibrating the bank
 *    FSRS  - memory stability and decay, driving review and recovery
 *    Bandit- which representation actually works for this learner
 */

export interface MasteryView {
  conceptId: string;
  slug: string;
  label: string;
  subject: string;
  pKnown: number;
  predictedCorrect: number;
  attempts: number;
  correct: number;
  accuracy: number;
  streak: number;
  mastered: boolean;
  struggling: boolean;
  elo: number;
  retention: number | null;
  daysSinceReview: number | null;
  dueInDays: number | null;
  stability: number;
  opportunitiesToMastery: number;
  status: 'untouched' | 'learning' | 'shaky' | 'mastered' | 'decaying';
}

export interface TwinSnapshot {
  learner: Learner;
  spec: AccessibilitySpec;
  ability: { theta: number; se: number; elo: number; percentileBand: string };
  mastery: {
    records: MasteryView[];
    bySubject: Record<string, { mean: number; mastered: number; total: number }>;
    masteredCount: number;
    learningCount: number;
    strugglingCount: number;
    overall: number;
  };
  modalities: { estimates: ReturnType<typeof armEstimates>; clearWinner: { winner: Modality; gap: number } | null };
  errorPatterns: { patterns: PatternStat[]; baselineErrorRate: number; sample: number; remedies: ReturnType<typeof remediesFor> };
  friction: FrictionVerdict;
  load: CognitiveLoadEstimate;
  recovery: RecoveryNeed[];
  dueForReview: MasteryView[];
  misconceptions: { code: string; label: string; severity: string; confidence: number; occurrences: number; status: string }[];
  pacing: { baselineLatencyMs: number; latencyStdevMs: number; sample: number; recommendedWpm: number };
  activity: { responses: number; sessions: number; last7Days: number; lastSeen: string | null };
  effectiveStrategies: { strategy: string; evidence: string; score: number }[];
  at: string;
}

export interface RecordResponseInput {
  learnerId: string;
  itemId?: string;
  conceptId?: string;
  sessionId?: string;
  raw: string;
  correct: boolean;
  score?: number;
  latencyMs?: number;
  hintsUsed?: number;
  attempts?: number;
  modality?: Modality;
  misconceptionId?: string;
  selfReportedClarity?: number;
  abandoned?: boolean;
  feedback?: Record<string, unknown>;
}

export interface RecordResponseResult {
  response: ResponseRecord;
  mastery: { before: number; after: number; delta: number; params: BktParams; mastered: boolean };
  elo: { learnerBefore: number; learnerAfter: number; itemBefore: number; itemAfter: number; expected: number; surprise: number };
  memory: { stability: number; intervalDays: number; dueAt: string; rating: string; explanation: string };
  reward: { reward: number; breakdown: Record<string, number> };
  modalityArm?: Arm;
  friction: FrictionVerdict;
  load: CognitiveLoadEstimate;
  unlocked: { conceptId: string; label: string }[];
  misconceptions?: { decayed: string[]; repaired: string[] };
}

export class TwinService {
  constructor(private repos: Repos, private graph: GraphService) {}

  /* ------------------------------ learners ------------------------------- */

  create(input: { name: string; grade?: number; needs?: AccessNeed[]; locale?: string; interests?: string[]; readingLevel?: number }): Learner {
    const grade = input.grade ?? config.pedagogy.defaultGrade;
    const spec = resolveSpec(input.needs ?? [], grade);
    const learner = this.repos.learners.create({
      name: input.name,
      grade,
      locale: input.locale ?? 'en',
      needs: input.needs ?? [],
      readingLevel: input.readingLevel ?? spec.targetGrade,
      profile: {
        interests: input.interests ?? [],
        maxChunkWords: spec.maxChunkWords,
        colorProfile: spec.colorProfile,
        ttsRate: spec.ttsRate,
        preferredPaceWpm: Math.round(170 - spec.severity * 70),
        attentionSpanMin: Math.round(spec.segmentSeconds / 60 * 4),
        captionsRequired: spec.requireCaptions,
      },
    });

    // Seed the bandit with the accessibility prior so the very first lesson is
    // already shaped for this learner rather than starting from nothing.
    for (const m of ALL_MODALITIES) {
      const boost = spec.modalityWeights[m] ?? 0;
      const blockedPenalty = spec.blockedModalities.includes(m) ? -0.9 : 0;
      this.repos.modality.save({
        learnerId: learner.id,
        modality: m,
        alpha: round(1 + Math.max(0, boost) * 2, 3),
        beta: round(1 + Math.max(0, -boost - blockedPenalty) * 2 + (blockedPenalty ? 4 : 0), 3),
        trials: 0,
        rewardSum: 0,
        lastAt: null,
      });
    }

    bus.emit('learner.created', { learnerId: learner.id, grade });
    return learner;
  }

  spec(learnerId: string): AccessibilitySpec {
    const l = this.repos.learners.require(learnerId);
    return resolveSpec(l.needs, l.grade, {
      ...(l.profile.maxChunkWords ? { maxChunkWords: l.profile.maxChunkWords as number } : {}),
      ...(l.profile.colorProfile ? { colorProfile: l.profile.colorProfile as string } : {}),
    });
  }

  /* -------------------------- response ingestion -------------------------- */

  /** The adaptation loop's write path. One response updates every engine. */
  recordResponse(input: RecordResponseInput): RecordResponseResult {
    const learner = this.repos.learners.require(input.learnerId);
    const item = input.itemId ? this.repos.items.get(input.itemId) : undefined;
    const conceptId = input.conceptId ?? item?.conceptId;
    if (!conceptId) {
      throw new Error('a response must carry either an itemId or a conceptId');
    }
    const concept = this.repos.concepts.require(conceptId);

    const latencyMs = input.latencyMs ?? 0;
    const hintsUsed = input.hintsUsed ?? 0;
    const attempts = input.attempts ?? 1;

    const response = this.repos.responses.add({
      learnerId: learner.id,
      itemId: input.itemId ?? null,
      conceptId,
      sessionId: input.sessionId ?? null,
      raw: input.raw,
      correct: input.correct,
      score: input.score ?? (input.correct ? 1 : 0),
      latencyMs,
      hintsUsed,
      attempts,
      misconceptionId: input.misconceptionId ?? null,
      modality: input.modality ?? null,
      feedback: input.feedback ?? {},
    });

    /* ---- BKT ---- */
    const record = this.repos.mastery.getOrInit(learner.id, conceptId);
    const params = paramsFor({
      choices: item?.choices.length,
      hintsUsed,
      difficulty: item?.difficulty,
      conceptDifficulty: concept.difficulty,
    });
    const step = bktUpdate(record.pKnown, input.correct, params);

    /* ---- Elo ---- */
    const itemRating = item ? thetaToElo(item.difficulty) : thetaToElo(concept.difficulty * 2 - 1);
    const elo = eloUpdate(record.elo, itemRating, input.correct, {
      learnerPlays: record.attempts,
      itemPlays: item?.exposures ?? 0,
      weight: hintsUsed > 0 ? 0.6 : 1,
    });

    /* ---- FSRS ---- */
    const memState: MemoryState = {
      stability: record.stability,
      difficulty: record.fsrsDifficulty,
      reps: record.reps,
      lapses: record.lapses,
      lastReviewMs: record.lastSeen ? Date.parse(record.lastSeen) : null,
    };
    const rating = ratingFrom({ correct: input.correct, latencyMs, hintsUsed, expectedMs: 25_000 });
    const sched = review(memState, rating, { conceptDifficulty: concept.difficulty });

    const wasMastered = record.pKnown >= config.pedagogy.masteryThreshold;
    const nowMastered = step.after >= config.pedagogy.masteryThreshold;

    this.repos.mastery.save({
      ...record,
      pKnown: step.after,
      elo: elo.learnerAfter,
      attempts: record.attempts + 1,
      correct: record.correct + (input.correct ? 1 : 0),
      streak: input.correct ? record.streak + 1 : 0,
      stability: sched.state.stability,
      fsrsDifficulty: sched.state.difficulty,
      reps: sched.state.reps,
      lapses: sched.state.lapses,
      lastSeen: new Date().toISOString(),
      dueAt: new Date(sched.dueAtMs).toISOString(),
      firstMasteredAt: record.firstMasteredAt ?? (nowMastered ? new Date().toISOString() : null),
    });

    bus.emit('learner.mastery.updated', {
      learnerId: learner.id, conceptId, before: step.before, after: step.after,
      reason: input.correct ? 'correct_response' : 'incorrect_response',
    });
    bus.emit('response.recorded', {
      learnerId: learner.id, itemId: input.itemId ?? conceptId, correct: input.correct, latencyMs,
    });

    /* ---- item calibration ---- */
    if (item) {
      this.repos.items.recordExposure(item.id, input.correct);
      if (item.exposures >= 5) {
        this.repos.items.updateCalibration(item.id, eloToTheta(elo.itemAfter), item.discrimination);
      }
    }

    /* ---- learner ability (theta from Elo) ---- */
    const theta = eloToTheta(elo.learnerAfter);
    this.repos.learners.update(learner.id, {
      ability: theta,
      abilitySe: round(Math.max(0.18, learner.abilitySe * 0.94), 4),
    });

    /* ---- modality bandit ---- */
    const reward = computeReward({
      correct: input.correct,
      masteryGain: step.evidence,
      hintsUsed,
      latencyMs,
      expectedMs: 25_000,
      completed: !input.abandoned,
      selfReportedClarity: input.selfReportedClarity,
      retries: attempts,
      abandoned: input.abandoned,
    });
    let modalityArm: Arm | undefined;
    if (input.modality) {
      const existing = this.repos.modality.get(learner.id, input.modality)
        ?? { learnerId: learner.id, modality: input.modality, alpha: 1, beta: 1, trials: 0, rewardSum: 0, lastAt: null };
      modalityArm = updateArm(existing, reward.reward);
      this.repos.modality.save({ ...modalityArm, learnerId: learner.id, lastAt: new Date().toISOString() });
      bus.emit('learner.modality.updated', {
        learnerId: learner.id, modality: input.modality, reward: reward.reward,
      });
    }

    /* ---- misconception bookkeeping ---- */
    let misconceptionUpdate: { decayed: string[]; repaired: string[] } | undefined;
    if (input.misconceptionId) {
      this.noteMisconception(learner.id, input.misconceptionId, conceptId, 0.7);
    } else if (input.correct && input.hintsUsed === 0) {
      // Unhinted correct answers are the evidence that closes the loop.
      misconceptionUpdate = this.creditCorrectAnswer(learner.id, conceptId);
    }

    /* ---- error pattern weights ---- */
    if (!input.correct && item) {
      this.bumpErrorPatterns(learner.id, item.id);
    }

    /* ---- friction + load ---- */
    const recent = this.repos.responses.forLearner(learner.id, 12);
    const baseline = latencyBaseline(this.repos.responses.forLearner(learner.id, 60));
    const load = estimateLoad({
      recent,
      contentDifficulty: concept.difficulty,
      baselineLatencyMs: baseline.median || undefined,
      workingMemorySupport: learner.needs.includes('working_memory'),
      sessionSeconds: input.sessionId ? this.sessionSeconds(input.sessionId) : undefined,
    });
    const signals = detectFriction(recent, {
      baselineLatencyMs: baseline.median || undefined,
      abandonedCount: input.abandoned ? 1 : 0,
    });
    const verdict = frictionVerdict(signals, load);

    if (load.load > config.pedagogy.cognitiveLoadCeiling) {
      bus.emit('learner.load.high', { learnerId: learner.id, load: load.load });
    }
    if (verdict.intervene) {
      bus.emit('learner.frustration.detected', {
        learnerId: learner.id, signals: signals.map((s) => s.kind), score: verdict.score,
      });
    }

    /* ---- what this just unlocked ---- */
    const unlocked = (!wasMastered && nowMastered)
      ? this.graph.adjacency().unlocks(conceptId)
          .map((idv) => this.repos.concepts.get(idv))
          .filter(Boolean)
          .map((c) => ({ conceptId: c!.id, label: c!.label }))
      : [];

    this.logEvent(learner.id, 'response', conceptId, {
      correct: input.correct, modality: input.modality, reward: reward.reward,
      pKnown: step.after, rating,
    });

    return {
      response,
      mastery: {
        before: step.before, after: step.after, delta: step.evidence, params, mastered: nowMastered,
      },
      elo: {
        learnerBefore: record.elo, learnerAfter: elo.learnerAfter,
        itemBefore: itemRating, itemAfter: elo.itemAfter,
        expected: elo.expected, surprise: elo.surprise,
      },
      memory: {
        stability: sched.state.stability, intervalDays: sched.intervalDays,
        dueAt: new Date(sched.dueAtMs).toISOString(), rating, explanation: sched.explanation,
      },
      reward,
      modalityArm,
      friction: verdict,
      load,
      unlocked,
      misconceptions: misconceptionUpdate,
    };
  }

  /* ----------------------------- modality ------------------------------- */

  /** Which representation to use next for this learner and concept. */
  chooseModality(learnerId: string, opts: { exclude?: Modality[]; seed?: string; strategy?: 'thompson' | 'ucb' } = {}): Selection {
    const spec = this.spec(learnerId);
    const stored = this.repos.modality.forLearner(learnerId);
    const arms: Arm[] = ALL_MODALITIES.map((m) => {
      const a = stored.find((s) => s.modality === m);
      return a
        ? { modality: m, alpha: a.alpha, beta: a.beta, trials: a.trials, rewardSum: a.rewardSum }
        : { modality: m, alpha: 1, beta: 1, trials: 0, rewardSum: 0 };
    });
    return selectModality(arms, {
      contextWeights: spec.modalityWeights,
      blocked: spec.blockedModalities,
      exclude: opts.exclude,
      seed: opts.seed ?? `${learnerId}:${Date.now()}`,
      strategy: opts.strategy,
    });
  }

  /* ----------------------------- mastery views --------------------------- */

  masteryViews(learnerId: string): MasteryView[] {
    const records = this.repos.mastery.forLearner(learnerId);
    const now = Date.now();
    return records.map((r) => this.toView(r, now)).sort((a, b) => b.pKnown - a.pKnown);
  }

  private toView(r: MasteryRecord, now = Date.now()): MasteryView {
    const concept = this.repos.concepts.get(r.conceptId);
    const lastMs = r.lastSeen ? Date.parse(r.lastSeen) : null;
    const daysSince = lastMs ? (now - lastMs) / DAY : null;
    const ret = lastMs && r.stability > 0 ? retention(r.stability, daysSince ?? 0) : null;
    const dueMs = r.dueAt ? Date.parse(r.dueAt) : null;
    const mastered = r.pKnown >= config.pedagogy.masteryThreshold;
    const struggling = r.attempts >= 2 && r.pKnown < config.pedagogy.strugglingThreshold;

    const status: MasteryView['status'] = r.attempts === 0 ? 'untouched'
      : mastered && (ret ?? 1) < 0.7 ? 'decaying'
      : mastered ? 'mastered'
      : struggling ? 'shaky'
      : 'learning';

    return {
      conceptId: r.conceptId,
      slug: concept?.slug ?? r.conceptId,
      label: concept?.label ?? r.conceptId,
      subject: concept?.subject ?? 'general',
      pKnown: round(r.pKnown, 3),
      predictedCorrect: bktPredict(r.pKnown),
      attempts: r.attempts,
      correct: r.correct,
      accuracy: r.attempts ? round(r.correct / r.attempts, 3) : 0,
      streak: r.streak,
      mastered,
      struggling,
      elo: r.elo,
      retention: ret === null ? null : round(ret, 3),
      daysSinceReview: daysSince === null ? null : round(daysSince, 2),
      dueInDays: dueMs === null ? null : round((dueMs - now) / DAY, 2),
      stability: r.stability,
      opportunitiesToMastery: mastered ? 0 : opportunitiesToMastery(r.pKnown, config.pedagogy.masteryThreshold),
      status,
    };
  }

  /* --------------------------- recovery / review -------------------------- */

  /** KNOWLEDGE RECOVERY: prerequisites of a target that have decayed. */
  recoveryFor(learnerId: string, targetConceptId: string): RecoveryNeed[] {
    const adj = this.graph.adjacency();
    const prereqs = adj.prerequisites(targetConceptId);
    const centrality = this.graph.centrality();
    const states = prereqs
      .map((conceptId) => {
        const r = this.repos.mastery.get(learnerId, conceptId);
        if (!r || r.attempts === 0) return null;
        return {
          conceptId,
          importance: 1 + (centrality.get(conceptId) ?? 0) * 8,
          state: {
            stability: r.stability,
            difficulty: r.fsrsDifficulty,
            reps: r.reps,
            lapses: r.lapses,
            lastReviewMs: r.lastSeen ? Date.parse(r.lastSeen) : null,
          } as MemoryState,
        };
      })
      .filter(Boolean) as { conceptId: string; importance: number; state: MemoryState }[];

    const needs = recoveryNeeds(states);
    for (const n of needs) {
      bus.emit('knowledge.decayed', { learnerId, conceptId: n.conceptId, retention: n.retention });
    }
    return needs;
  }

  /** Everything this learner once knew that has since decayed below threshold.
   *  Target-independent, so the snapshot can surface it without a goal. */
  decayedConcepts(learnerId: string, limit = 10, threshold = 0.75): RecoveryNeed[] {
    const centrality = this.graph.centrality();
    const states = this.repos.mastery.forLearner(learnerId)
      .filter((r) => r.attempts > 0 && r.lastSeen && r.stability > 0)
      .map((r) => ({
        conceptId: r.conceptId,
        importance: 1 + (centrality.get(r.conceptId) ?? 0) * 8,
        state: {
          stability: r.stability,
          difficulty: r.fsrsDifficulty,
          reps: r.reps,
          lapses: r.lapses,
          lastReviewMs: Date.parse(r.lastSeen!),
        } as MemoryState,
      }));
    return recoveryNeeds(states, { threshold }).slice(0, limit);
  }

  dueForReview(learnerId: string, limit = 12): MasteryView[] {
    const now = Date.now();
    return this.repos.mastery.dueFor(learnerId, new Date().toISOString(), limit * 2)
      .map((r) => this.toView(r, now))
      .filter((v) => v.attempts > 0)
      .sort((a, b) => (a.retention ?? 1) - (b.retention ?? 1))
      .slice(0, limit);
  }

  /* --------------------------- misconceptions ---------------------------- */

  noteMisconception(learnerId: string, misconceptionId: string, conceptId: string | null, confidence: number): void {
    const existing = this.repos.db.one<{ occurrences: number; confidence: number }>(
      'SELECT occurrences, confidence FROM learner_misconceptions WHERE learner_id=? AND misconception_id=?',
      [learnerId, misconceptionId],
    );
    const now = new Date().toISOString();
    if (existing) {
      // Repeated evidence compounds confidence without ever reaching certainty.
      const merged = clamp(Number(existing.confidence) + (1 - Number(existing.confidence)) * confidence * 0.6);
      this.repos.db.run(
        `UPDATE learner_misconceptions SET occurrences=occurrences+1, confidence=?, last_at=?, status='active'
         WHERE learner_id=? AND misconception_id=?`,
        [round(merged, 4), now, learnerId, misconceptionId],
      );
    } else {
      this.repos.db.insert('learner_misconceptions', {
        learner_id: learnerId, misconception_id: misconceptionId, concept_id: conceptId,
        confidence: round(confidence, 4), occurrences: 1, status: 'active', first_at: now, last_at: now,
      });
    }
    const m = this.repos.misconceptions.get(misconceptionId);
    bus.emit('misconception.detected', {
      learnerId, conceptId: conceptId ?? '', misconceptionId, confidence,
    });
    this.logEvent(learnerId, 'misconception', conceptId, { code: m?.code, confidence });
  }

  /** A correct answer is evidence AGAINST any misconception active on that
   *  concept. Without this the detection loop never closes: the system would
   *  keep repairing something the learner has already fixed. */
  creditCorrectAnswer(learnerId: string, conceptId: string): { decayed: string[]; repaired: string[] } {
    const rows = this.repos.db.all<{ misconception_id: string; confidence: number; concept_id: string | null }>(
      `SELECT misconception_id, confidence, concept_id FROM learner_misconceptions
       WHERE learner_id=? AND status='active' AND (concept_id=? OR concept_id IS NULL)`,
      [learnerId, conceptId],
    );
    const decayed: string[] = [];
    const repaired: string[] = [];
    const now = new Date().toISOString();

    for (const r of rows) {
      // Only count evidence against a misconception actually tied to this concept.
      if (r.concept_id && r.concept_id !== conceptId) continue;
      const next = round(Number(r.confidence) * 0.55, 4);
      const code = this.repos.misconceptions.get(r.misconception_id)?.code ?? r.misconception_id;
      if (next < 0.25) {
        this.repos.db.run(
          `UPDATE learner_misconceptions SET status='repaired', confidence=?, repaired_at=?, last_at=?
           WHERE learner_id=? AND misconception_id=?`,
          [next, now, now, learnerId, r.misconception_id],
        );
        repaired.push(code);
        bus.emit('misconception.repaired', { learnerId, misconceptionId: r.misconception_id });
      } else {
        this.repos.db.run(
          `UPDATE learner_misconceptions SET confidence=?, last_at=? WHERE learner_id=? AND misconception_id=?`,
          [next, now, learnerId, r.misconception_id],
        );
        decayed.push(code);
      }
    }
    return { decayed, repaired };
  }

  markMisconceptionRepaired(learnerId: string, misconceptionId: string): void {
    this.repos.db.run(
      `UPDATE learner_misconceptions SET status='repaired', repaired_at=? WHERE learner_id=? AND misconception_id=?`,
      [new Date().toISOString(), learnerId, misconceptionId],
    );
    bus.emit('misconception.repaired', { learnerId, misconceptionId });
  }

  activeMisconceptions(learnerId: string) {
    return this.repos.db.all<{
      misconception_id: string; concept_id: string | null; confidence: number;
      occurrences: number; status: string; last_at: string;
    }>(
      `SELECT * FROM learner_misconceptions WHERE learner_id=? AND status='active' ORDER BY confidence DESC`,
      [learnerId],
    ).map((r) => {
      const m = this.repos.misconceptions.get(r.misconception_id);
      return {
        misconceptionId: r.misconception_id,
        code: m?.code ?? 'unknown',
        label: m?.label ?? 'unknown misconception',
        severity: m?.severity ?? 'moderate',
        conceptId: r.concept_id,
        confidence: round(Number(r.confidence), 3),
        occurrences: Number(r.occurrences),
        status: r.status,
        lastAt: r.last_at,
        remediation: m?.remediation,
      };
    });
  }

  /* ---------------------------- error patterns --------------------------- */

  private bumpErrorPatterns(learnerId: string, itemId: string): void {
    const item = this.repos.items.get(itemId);
    if (!item) return;
    const now = new Date().toISOString();
    for (const f of featuresOf(item).map((x) => x.key)) {
      this.repos.db.run(
        `INSERT INTO learner_error_patterns (learner_id, pattern, count, weight, last_at)
         VALUES (?,?,1,0.1,?)
         ON CONFLICT(learner_id, pattern) DO UPDATE SET
           count = count + 1,
           weight = MIN(1.0, weight + 0.1),
           last_at = excluded.last_at`,
        [learnerId, f, now],
      );
    }
  }

  errorPatterns(learnerId: string) {
    const responses = this.repos.responses.forLearner(learnerId, 300);
    const mined = minePatterns(responses, (idv) => this.repos.items.get(idv));
    return { ...mined, remedies: remediesFor(mined.patterns) };
  }

  /* ------------------------------ snapshot ------------------------------- */

  snapshot(learnerId: string): TwinSnapshot {
    const learner = this.repos.learners.require(learnerId);
    const spec = this.spec(learnerId);
    const views = this.masteryViews(learnerId);
    const responses = this.repos.responses.forLearner(learnerId, 300);
    const recent = responses.slice(0, 12);
    const baseline = latencyBaseline(responses);

    const bySubject: Record<string, { mean: number; mastered: number; total: number }> = {};
    for (const v of views) {
      const s = bySubject[v.subject] ?? { mean: 0, mastered: 0, total: 0 };
      s.mean += v.pKnown;
      s.total += 1;
      if (v.mastered) s.mastered += 1;
      bySubject[v.subject] = s;
    }
    for (const k of Object.keys(bySubject)) {
      bySubject[k].mean = round(bySubject[k].mean / Math.max(1, bySubject[k].total), 3);
    }

    const stored = this.repos.modality.forLearner(learnerId);
    const arms: Arm[] = ALL_MODALITIES.map((m) => {
      const a = stored.find((s) => s.modality === m);
      return a ? { modality: m, alpha: a.alpha, beta: a.beta, trials: a.trials, rewardSum: a.rewardSum }
        : { modality: m, alpha: 1, beta: 1, trials: 0, rewardSum: 0 };
    });

    const load = estimateLoad({
      recent,
      contentDifficulty: mean(views.filter((v) => v.attempts > 0).map((v) => this.repos.concepts.get(v.conceptId)?.difficulty ?? 0.5)) || 0.5,
      baselineLatencyMs: baseline.median || undefined,
      workingMemorySupport: learner.needs.includes('working_memory'),
    });
    const signals: FrictionSignal[] = detectFriction(recent, { baselineLatencyMs: baseline.median || undefined });

    const weekAgo = Date.now() - 7 * DAY;
    const patterns = this.errorPatterns(learnerId);

    return {
      learner,
      spec,
      ability: {
        theta: round(learner.ability, 3),
        se: round(learner.abilitySe, 3),
        elo: thetaToElo(learner.ability),
        percentileBand: percentileBand(learner.ability),
      },
      mastery: {
        records: views,
        bySubject,
        masteredCount: views.filter((v) => v.mastered).length,
        learningCount: views.filter((v) => v.status === 'learning').length,
        strugglingCount: views.filter((v) => v.struggling).length,
        overall: round(mean(views.map((v) => v.pKnown)) || 0, 3),
      },
      modalities: {
        estimates: armEstimates(arms, spec.modalityWeights).sort((a, b) => b.score - a.score),
        clearWinner: hasClearWinner(arms),
      },
      errorPatterns: patterns,
      friction: frictionVerdict(signals, load),
      load,
      recovery: this.decayedConcepts(learnerId, 8),
      dueForReview: this.dueForReview(learnerId, 8),
      misconceptions: this.activeMisconceptions(learnerId).map((m) => ({
        code: m.code, label: m.label, severity: m.severity,
        confidence: m.confidence, occurrences: m.occurrences, status: m.status,
      })),
      pacing: {
        baselineLatencyMs: baseline.median,
        latencyStdevMs: baseline.stdev,
        sample: baseline.n,
        recommendedWpm: Number(learner.profile.preferredPaceWpm ?? Math.round(170 - spec.severity * 70)),
      },
      activity: {
        responses: responses.length,
        sessions: this.repos.sessions.forLearner(learnerId, 100).length,
        last7Days: responses.filter((r) => Date.parse(r.at) > weekAgo).length,
        lastSeen: responses[0]?.at ?? null,
      },
      effectiveStrategies: this.effectiveStrategies(learnerId),
      at: new Date().toISOString(),
    };
  }

  /** What has actually worked for this learner, with the evidence. */
  effectiveStrategies(learnerId: string): { strategy: string; evidence: string; score: number }[] {
    const stored = this.repos.modality.forLearner(learnerId).filter((a) => a.trials >= 2);
    const out = stored
      .map((a) => ({
        strategy: `${a.modality} presentation`,
        evidence: `mean reward ${round(a.rewardSum / Math.max(1, a.trials), 3)} across ${a.trials} deliveries`,
        score: round(a.rewardSum / Math.max(1, a.trials), 3),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);

    const responses = this.repos.responses.forLearner(learnerId, 200);
    const hinted = responses.filter((r) => r.hintsUsed > 0);
    if (hinted.length >= 4) {
      const withHintAccuracy = hinted.filter((r) => r.correct).length / hinted.length;
      const withoutHints = responses.filter((r) => r.hintsUsed === 0);
      const withoutAccuracy = withoutHints.length ? withoutHints.filter((r) => r.correct).length / withoutHints.length : 0;
      if (withHintAccuracy - withoutAccuracy > 0.2) {
        out.push({
          strategy: 'scaffolded prompts before independent practice',
          evidence: `${Math.round(withHintAccuracy * 100)}% correct with a hint vs ${Math.round(withoutAccuracy * 100)}% without`,
          score: round(withHintAccuracy, 3),
        });
      }
    }
    return out;
  }

  /** Persist a snapshot so the twin's history is auditable and replayable. */
  saveSnapshot(learnerId: string, label?: string): { id: string; at: string } {
    const snap = this.snapshot(learnerId);
    const idv = newId('snp');
    const at = new Date().toISOString();
    this.repos.db.insert('twin_snapshots', {
      id: idv, learner_id: learnerId, at, label: label ?? null, snapshot: snap,
    });
    return { id: idv, at };
  }

  snapshotHistory(learnerId: string, limit = 20) {
    return this.repos.db.all<{ id: string; at: string; label: string | null }>(
      'SELECT id, at, label FROM twin_snapshots WHERE learner_id=? ORDER BY at DESC LIMIT ?',
      [learnerId, limit],
    );
  }

  /* -------------------------------- utils -------------------------------- */

  private sessionSeconds(sessionId: string): number | undefined {
    const s = this.repos.sessions.get(sessionId);
    if (!s) return undefined;
    return Math.round((Date.now() - Date.parse(s.startedAt)) / 1000);
  }

  private logEvent(learnerId: string, kind: string, conceptId: string | null, payload: Record<string, unknown>): void {
    this.repos.db.insert('learner_events', {
      id: newId('lev'), learner_id: learnerId, kind, concept_id: conceptId,
      payload, at: new Date().toISOString(),
    });
  }

  timeline(learnerId: string, limit = 60) {
    return this.repos.db.all('SELECT * FROM learner_events WHERE learner_id=? ORDER BY at DESC LIMIT ?', [learnerId, limit]);
  }
}

function percentileBand(theta: number): string {
  if (theta < -1.5) return 'well below grade expectation';
  if (theta < -0.5) return 'below grade expectation';
  if (theta <= 0.5) return 'at grade expectation';
  if (theta <= 1.5) return 'above grade expectation';
  return 'well above grade expectation';
}
