import type { Repos } from '../db/repos.js';
import type { Modality, PlanStep, SessionRecord } from '../domain/types.js';
import type { GraphService } from '../graph/service.js';
import type { TwinService, RecordResponseInput } from '../twin/service.js';
import type { MisconceptionEngine } from '../misconception/engine.js';
import type { VisualEngine } from '../engines/visual.engine.js';
import { decide, describeAction, toPlanStep, type Candidate, type PolicyDecision } from './policy.js';
import { labsForConcept, runLab, labDefaults } from '../engines/sim/lab.js';
import { transform } from '../accessibility/transformer.js';
import { buildAudioScript, toWebVtt } from '../accessibility/ssml.js';
import { estimateAbilityEap, type IrtItem, shouldStop } from '../assessment/irt.js';
import type { AssessmentService } from '../assessment/service.js';
import { config } from '../core/config.js';
import { bus } from '../core/events.js';
import { id as newId } from '../core/ids.js';
import { notFound, unprocessable } from '../core/errors.js';
import { round } from '../core/mathx.js';
import { metrics } from '../core/metrics.js';

/** THE SESSION
 *
 *  The adaptation loop made concrete: decide -> deliver -> observe -> update ->
 *  decide again. Every step records WHY it was chosen, so a teacher can scroll
 *  back through a session and see the reasoning, not just the sequence. */

export interface SessionState {
  deliveredConceptIds: string[];
  /** Delivery counts per concept (plus '__break__' and 'msc:<code>' keys). */
  deliveryCounts: Record<string, number>;
  /** Concepts the learner has actually answered something about. */
  answeredConceptIds: string[];
  triedModalities: Record<string, Modality[]>;
  seenItemIds: string[];
  explanationSwitches: number;
  breaksTaken: number;
  decisions: { step: number; action: string; conceptId?: string; reason: string; at: string }[];
  lastExperienceId?: string;
  currentConceptId?: string;
}

export interface Experience {
  experienceId: string;
  kind: 'lesson' | 'practice' | 'repair' | 'review' | 'break' | 'lab' | 'celebration' | 'diagnostic';
  action: Candidate['kind'];
  conceptId?: string;
  conceptLabel?: string;
  modality: Modality;
  title: string;
  /** The teaching content itself, shaped by modality. */
  payload: Record<string, unknown>;
  /** Why the system chose this, in words a teacher can argue with. */
  rationale: { chosen: string; narrative: string; runnersUp: { action: string; reason: string; score: number }[] };
  estimatedSec: number;
  accessibility: Record<string, unknown>;
  /** What to ask once they have engaged with it. */
  check?: { itemId?: string; stem: string; choices?: { key: string; text: string }[]; kind: string };
  sessionProgress: { step: number; itemsDelivered: number; elapsedSec: number; conceptsTouched: number };
}

export interface SessionSummary {
  sessionId: string;
  learnerId: string;
  status: SessionRecord['status'];
  steps: number;
  itemsDelivered: number;
  elapsedSec: number;
  conceptsTouched: { conceptId: string; label: string; before: number; after: number; delta: number }[];
  mastered: string[];
  misconceptionsRepaired: string[];
  accuracy: number;
  endReason?: string | null;
  highlights: string[];
  nextTime: string[];
}

export class SessionEngine {
  constructor(
    private repos: Repos,
    private graph: GraphService,
    private twin: TwinService,
    private misconceptions: MisconceptionEngine,
    private visual: VisualEngine,
    private assessment: AssessmentService,
  ) {}

  /* -------------------------------- lifecycle ---------------------------- */

  start(learnerId: string, opts: { goalConceptId?: string; goalSlug?: string; maxItems?: number } = {}): SessionRecord {
    const learner = this.repos.learners.require(learnerId);

    const existing = this.repos.sessions.activeFor(learnerId);
    if (existing) {
      // Never silently run two sessions: the twin would see interleaved
      // evidence and attribute it to the wrong context.
      this.end(existing.id, 'superseded_by_new_session');
    }

    const goal = opts.goalConceptId
      ? this.graph.resolve(opts.goalConceptId)
      : opts.goalSlug ? this.graph.resolve(opts.goalSlug) : undefined;

    const plan: PlanStep[] = goal
      ? this.graph.plan(learnerId, [goal.id], opts.maxItems ?? 12).order.map((c) => ({
          conceptId: c.id,
          intent: 'teach' as const,
          modality: 'text' as Modality,
          reason: `on the route to ${goal.label}`,
          estimatedSec: 240,
        }))
      : [];

    const state: SessionState = {
      deliveredConceptIds: [],
      deliveryCounts: {},
      answeredConceptIds: [],
      triedModalities: {},
      seenItemIds: [],
      explanationSwitches: 0,
      breaksTaken: 0,
      decisions: [],
    };

    const session = this.repos.sessions.create({
      learnerId,
      goalConceptId: goal?.id ?? null,
      status: 'active',
      plan,
      state: state as unknown as Record<string, unknown>,
      metrics: { itemsDelivered: 0, correct: 0, incorrect: 0 },
      step: 0,
    });

    bus.emit('session.started', { sessionId: session.id, learnerId });
    metrics.counter('lumen_sessions_started_total').inc({ grade: String(learner.grade) });
    return session;
  }

  end(sessionId: string, reason = 'completed'): SessionSummary {
    const session = this.repos.sessions.require(sessionId);
    if (session.status !== 'ended') {
      session.status = 'ended';
      session.endedAt = new Date().toISOString();
      session.endReason = reason;
      this.repos.sessions.save(session);
      bus.emit('session.ended', {
        sessionId, reason, itemsDelivered: Number(session.metrics.itemsDelivered ?? 0),
      });
    }
    return this.summary(sessionId);
  }

  /* --------------------------------- the loop ---------------------------- */

  /** Decide and deliver the next experience. This is the heart of the OS. */
  async next(sessionId: string): Promise<Experience> {
    const session = this.repos.sessions.require(sessionId);
    if (session.status === 'ended') throw unprocessable('this session has already ended');

    const state = this.readState(session);
    const learnerId = session.learnerId;
    const elapsedSec = Math.round((Date.now() - Date.parse(session.startedAt)) / 1000);

    const decision = this.decide(sessionId, session, state, elapsedSec);
    const chosen = decision.chosen;

    // Modality is a separate decision from WHAT to teach: the bandit owns it,
    // excluding anything already tried for this concept in this session.
    const tried = chosen.conceptId ? (state.triedModalities[chosen.conceptId] ?? []) : [];
    const selection = this.twin.chooseModality(learnerId, {
      exclude: chosen.kind === 'switch_modality' ? tried : [],
      seed: `${sessionId}:${session.step}`,
    });
    const modality = chosen.modality ?? selection.chosen;

    const experience = await this.deliver(sessionId, learnerId, chosen, modality, decision, state, session, elapsedSec);

    // Persist state after delivery so a crash cannot lose the decision trail.
    state.decisions.push({
      step: session.step,
      action: chosen.kind,
      conceptId: chosen.conceptId,
      reason: chosen.reason,
      at: new Date().toISOString(),
    });
    if (chosen.conceptId) {
      if (!state.deliveredConceptIds.includes(chosen.conceptId)) state.deliveredConceptIds.push(chosen.conceptId);
      state.triedModalities[chosen.conceptId] = [...new Set([...tried, modality])];
      state.deliveryCounts[chosen.conceptId] = (state.deliveryCounts[chosen.conceptId] ?? 0) + 1;
      state.currentConceptId = chosen.conceptId;
    }
    if (chosen.misconceptionCode) {
      const k = `msc:${chosen.misconceptionCode}`;
      state.deliveryCounts[k] = (state.deliveryCounts[k] ?? 0) + 1;
    }
    if (chosen.kind === 'switch_modality') state.explanationSwitches += 1;
    if (chosen.kind === 'break') {
      state.breaksTaken += 1;
      state.deliveryCounts.__break__ = (state.deliveryCounts.__break__ ?? 0) + 1;
    }
    state.lastExperienceId = experience.experienceId;

    session.step += 1;
    session.state = state as unknown as Record<string, unknown>;
    this.repos.sessions.save(session);

    bus.emit('session.step', { sessionId, step: session.step, action: chosen.kind });
    bus.emit('experience.delivered', { learnerId, experienceId: experience.experienceId, kind: experience.kind });
    metrics.counter('lumen_experiences_total').inc({ kind: experience.kind, modality });

    return experience;
  }

  /** The decision, exposed on its own so it can be inspected without delivering. */
  decide(sessionId: string, sessionIn?: SessionRecord, stateIn?: SessionState, elapsedIn?: number): PolicyDecision {
    const session = sessionIn ?? this.repos.sessions.require(sessionId);
    const state = stateIn ?? this.readState(session);
    const learnerId = session.learnerId;
    const elapsedSec = elapsedIn ?? Math.round((Date.now() - Date.parse(session.startedAt)) / 1000);

    const snapshot = this.twin.snapshot(learnerId);
    const goalId = session.goalConceptId ?? undefined;
    const gapTrace = goalId ? this.graph.traceGaps(learnerId, goalId) : undefined;

    return decide({
      mastery: snapshot.mastery.records,
      load: snapshot.load,
      friction: snapshot.friction,
      activeMisconceptions: this.twin.activeMisconceptions(learnerId).map((m) => ({
        code: m.code, conceptId: m.conceptId, confidence: m.confidence, severity: m.severity, label: m.label,
      })),
      gapTrace,
      frontier: this.graph.frontier(learnerId, { limit: 6 }),
      recovery: goalId ? this.twin.recoveryFor(learnerId, goalId) : snapshot.recovery,
      dueForReview: snapshot.dueForReview,
      sessionConceptIds: state.deliveredConceptIds,
      deliveryCounts: state.deliveryCounts,
      answeredConceptIds: state.answeredConceptIds,
      triedModalities: state.currentConceptId ? (state.triedModalities[state.currentConceptId] ?? []) : [],
      goalConceptId: goalId,
      sessionSeconds: elapsedSec,
      itemsDelivered: Number(session.metrics.itemsDelivered ?? 0),
      masteryThreshold: config.pedagogy.masteryThreshold,
      loadCeiling: config.pedagogy.cognitiveLoadCeiling,
      conceptLabel: (idv) => this.repos.concepts.get(idv)?.label ?? idv,
    });
  }

  /* ------------------------------- delivery ------------------------------ */

  private async deliver(
    sessionId: string,
    learnerId: string,
    chosen: Candidate,
    modality: Modality,
    decision: PolicyDecision,
    state: SessionState,
    session: SessionRecord,
    elapsedSec: number,
  ): Promise<Experience> {
    const concept = chosen.conceptId ? this.repos.concepts.get(chosen.conceptId) : undefined;
    const spec = this.twin.spec(learnerId);
    const experienceId = newId('exp');

    const base = {
      experienceId,
      action: chosen.kind,
      conceptId: concept?.id,
      conceptLabel: concept?.label,
      modality,
      estimatedSec: chosen.estimatedSec,
      rationale: {
        chosen: describeAction(chosen),
        narrative: decision.narrative,
        runnersUp: decision.runnersUp.map((r) => ({ action: describeAction(r), reason: r.reason, score: r.score })),
      },
      accessibility: {
        targetGrade: spec.targetGrade,
        maxChunkWords: spec.maxChunkWords,
        colorProfile: spec.colorProfile,
        ttsRate: spec.ttsRate,
        reduceMotion: spec.reduceMotion,
        requireCaptions: spec.requireCaptions,
        segmentSeconds: spec.segmentSeconds,
        guidance: spec.guidance.slice(0, 4),
      },
      sessionProgress: {
        step: session.step,
        itemsDelivered: Number(session.metrics.itemsDelivered ?? 0),
        elapsedSec,
        conceptsTouched: state.deliveredConceptIds.length,
      },
    };

    /* --- break --- */
    if (chosen.kind === 'break') {
      return {
        ...base,
        kind: 'break',
        title: 'Take two minutes',
        payload: {
          message: 'You have been working hard and it is getting heavy. Stand up, look out of a window, '
            + 'and come back in two minutes. Your progress is saved.',
          suggestedSec: 120,
          resumeHint: concept ? `We will pick up at ${concept.label}.` : 'We will pick up where you left off.',
          loadBreakdown: chosen.evidence,
        },
      };
    }

    /* --- celebrate --- */
    if (chosen.kind === 'celebrate') {
      const mastered = (chosen.evidence.mastered as string[]) ?? [];
      return {
        ...base,
        kind: 'celebration',
        title: 'Look what you just did',
        payload: {
          message: `You moved ${mastered.length} concept(s) to mastery this session: ${mastered.join(', ')}.`,
          unlocked: concept
            ? this.graph.adjacency().unlocks(concept.id).map((idv) => this.repos.concepts.get(idv)?.label).filter(Boolean)
            : [],
          mastered,
        },
      };
    }

    /* --- misconception repair --- */
    if (chosen.kind === 'repair_misconception' && chosen.misconceptionCode) {
      const repair = this.misconceptions.buildRemediation(chosen.misconceptionCode, {
        grade: spec.targetGrade,
        modality,
      });
      const visual = await this.safeVisual({
        conceptSlug: concept?.slug,
        conceptId: concept?.id,
        learnerId,
        misconception: `${repair.misconception.label}: ${repair.misconception.description}`,
      });
      return {
        ...base,
        kind: 'repair',
        title: repair.microLesson.title,
        estimatedSec: repair.microLesson.estimatedSeconds,
        payload: {
          misconception: {
            code: repair.misconception.code,
            label: repair.misconception.label,
            description: repair.misconception.description,
            severity: repair.misconception.severity,
          },
          strategy: repair.plan.strategy,
          steps: repair.microLesson.steps,
          contrast: repair.plan.contrastPair,
          prerequisiteChecks: repair.microLesson.prerequisiteChecks,
          practice: repair.microLesson.practice,
          visual,
        },
        check: this.pickCheck(concept?.id, learnerId, state),
      };
    }

    if (!concept) {
      // Diagnostic: no concept chosen yet, so find out where they actually are.
      return this.diagnostic(base, learnerId, state);
    }

    /* --- lab --- */
    const labs = labsForConcept(concept.slug);
    if ((modality === 'simulation' || modality === 'manipulative') && labs.length) {
      const lab = labs[0];
      const result = runLab(lab.id, labDefaults(lab.id));
      return {
        ...base,
        kind: 'lab',
        title: lab.label,
        payload: {
          labId: lab.id,
          question: lab.question,
          description: lab.description,
          learningGoal: lab.learningGoal,
          controls: lab.controls,
          initialState: result,
          nextExperiment: result.nextExperiment,
        },
        check: this.pickCheck(concept.id, learnerId, state),
      };
    }

    /* --- review / refresh --- */
    if (chosen.kind === 'review' || chosen.kind === 'refresh_decayed') {
      const terms = this.repos.terms.forConcept(concept.id);
      const text = concept.description || concept.label;
      const t = transform({ text, title: concept.label, grade: spec.targetGrade, needs: spec.needs, keepTerms: terms.map((x) => x.term) });
      return {
        ...base,
        kind: 'review',
        title: `Quick refresher: ${concept.label}`,
        payload: {
          oneLine: t.variants.oneLine,
          bullets: t.variants.bullets.slice(0, 3),
          keyTerms: t.glossary.slice(0, 4),
          audio: { ssml: t.audio.script.ssml, totalMs: t.audio.script.totalMs },
          durationSec: chosen.estimatedSec,
          whyNow: chosen.reason,
        },
        check: this.pickCheck(concept.id, learnerId, state),
      };
    }

    /* --- teach / practice / extend / switch_modality --- */
    const terms = this.repos.terms.forConcept(concept.id);
    const sourceText = [concept.description, ...terms.map((t) => `${t.term}: ${t.definition}`)]
      .filter(Boolean).join(' ');
    const t = transform({
      text: sourceText || concept.label,
      title: concept.label,
      grade: spec.targetGrade,
      needs: spec.needs,
      keepTerms: terms.map((x) => x.term),
    });

    const needsVisual = ['animation', 'diagram', 'spatial', 'story', 'analogy'].includes(modality);
    const visual = needsVisual
      ? await this.safeVisual({ conceptId: concept.id, conceptSlug: concept.slug, learnerId })
      : undefined;

    const audio = buildAudioScript(t.variants.plain, {
      grade: spec.targetGrade,
      rate: spec.ttsRate,
      emphasizeTerms: terms.map((x) => x.term),
    });

    return {
      ...base,
      kind: chosen.kind === 'practice' ? 'practice' : 'lesson',
      title: concept.label,
      payload: {
        objective: `Explain ${concept.label} in your own words.`,
        text: t.variants.plain,
        elementary: t.variants.elementary,
        bullets: t.variants.bullets,
        outline: t.variants.outline,
        socratic: t.variants.socratic.slice(0, 4),
        glossary: t.glossary.slice(0, 6),
        decoding: t.decoding.slice(0, 4),
        render: {
          typography: t.render.typography,
          color: t.render.color,
          chunks: t.render.chunks.slice(0, 40),
          supports: t.render.supports,
          pacing: t.render.pacing,
        },
        audio: { ssml: audio.ssml, totalMs: audio.totalMs },
        captionsVtt: toWebVtt(audio),
        altText: t.altText,
        readability: {
          before: t.gains.gradeBefore, after: t.gains.gradeAfter,
          accessibilityIndex: t.gains.accessibilityAfter,
        },
        visual,
        relatedLabs: labs.map((l) => ({ id: l.id, label: l.label, question: l.question })),
      },
      check: this.pickCheck(concept.id, learnerId, state),
    };
  }

  private diagnostic(
    base: Omit<Experience, 'kind' | 'title' | 'payload'>,
    learnerId: string,
    state: SessionState,
  ): Experience {
    const learner = this.repos.learners.require(learnerId);
    const frontier = this.graph.frontier(learnerId, { limit: 6 });
    let check: Experience['check'];
    let reason: string | undefined;
    for (const f of frontier) {
      const pick = this.assessment.nextItem(learnerId, f.conceptId, {
        exclude: new Set(state.seenItemIds),
        seedIndex: state.seenItemIds.length,
      });
      if (pick) {
        check = {
          itemId: pick.item.id,
          stem: pick.item.stem,
          choices: pick.item.choices.map((c) => ({ key: c.key, text: c.text })),
          kind: pick.item.kind,
        };
        reason = pick.reason;
        break;
      }
    }

    return {
      ...base,
      kind: 'diagnostic',
      title: 'Let us find your starting point',
      payload: {
        message: 'A few quick questions so I can pitch this at the right level. '
          + 'Getting one wrong is useful information, not a problem.',
        abilityEstimate: round(learner.ability, 3),
        selectionReason: reason,
      },
      check,
    };
  }

  private pickCheck(conceptId: string | undefined, learnerId: string, state: SessionState) {
    if (!conceptId) return undefined;
    // ensureItems generates a bank on demand: a concept the system can teach
    // but never check would stall the whole adaptation loop.
    const pick = this.assessment.nextItem(learnerId, conceptId, {
      exclude: new Set(state.seenItemIds),
      seedIndex: state.seenItemIds.length,
    });
    if (!pick) return undefined;
    return {
      itemId: pick.item.id,
      stem: pick.item.stem,
      choices: pick.item.choices.map((c) => ({ key: c.key, text: c.text })),
      kind: pick.item.kind,
      selectionReason: pick.reason,
    };
  }

  private async safeVisual(req: Parameters<VisualEngine['build']>[0]) {
    try {
      const asset = await this.visual.build(req);
      return {
        sceneId: asset.sceneId,
        title: asset.title,
        svg: asset.svg,
        stillSvg: asset.stillSvg,
        durationSec: asset.durationSec,
        segments: asset.segments,
        audioDescription: asset.audioDescription,
        captionsVtt: asset.captionsVtt,
        source: asset.source,
        auditOk: asset.audit.ok,
      };
    } catch {
      // A failed visual must never take the lesson down with it.
      return undefined;
    }
  }

  /* ------------------------------- responses ----------------------------- */

  /** Record an answer and fold it into every engine. */
  async answer(sessionId: string, input: Omit<RecordResponseInput, 'learnerId' | 'sessionId'>) {
    const session = this.repos.sessions.require(sessionId);
    if (session.status === 'ended') throw unprocessable('this session has already ended');
    const state = this.readState(session);

    const item = input.itemId ? this.repos.items.get(input.itemId) : undefined;
    const conceptId = input.conceptId ?? item?.conceptId ?? state.currentConceptId;

    // Diagnose BEFORE recording, so the misconception rides along with the response.
    let diagnosis;
    if (!input.correct) {
      diagnosis = await this.misconceptions.diagnose({
        learnerId: session.learnerId,
        itemId: input.itemId,
        conceptId,
        learnerAnswer: input.raw,
        choiceKey: input.raw,
      });
    }

    const result = this.twin.recordResponse({
      ...input,
      learnerId: session.learnerId,
      sessionId,
      conceptId,
      misconceptionId: diagnosis?.misconception?.id ?? input.misconceptionId,
    });

    if (input.itemId && !state.seenItemIds.includes(input.itemId)) state.seenItemIds.push(input.itemId);
    if (conceptId && !state.answeredConceptIds.includes(conceptId)) state.answeredConceptIds.push(conceptId);

    const m = session.metrics;
    m.itemsDelivered = Number(m.itemsDelivered ?? 0) + 1;
    m[input.correct ? 'correct' : 'incorrect'] = Number(m[input.correct ? 'correct' : 'incorrect'] ?? 0) + 1;
    session.metrics = m;
    session.state = state as unknown as Record<string, unknown>;
    this.repos.sessions.save(session);

    return {
      ...result,
      diagnosis: diagnosis?.found ? {
        code: diagnosis.code,
        label: diagnosis.misconception?.label,
        source: diagnosis.source,
        confidence: diagnosis.confidence,
        reasoning: diagnosis.reasoning,
        feedback: diagnosis.feedback,
        remediation: diagnosis.remediation,
      } : undefined,
      feedback: this.buildFeedback(input.correct, result, diagnosis),
      shouldStop: this.stopCheck(session),
    };
  }

  private buildFeedback(
    correct: boolean,
    result: Awaited<ReturnType<TwinService['recordResponse']>>,
    diagnosis?: Awaited<ReturnType<MisconceptionEngine['diagnose']>>,
  ) {
    if (correct) {
      const gain = result.mastery.delta;
      return {
        tone: 'affirming' as const,
        headline: gain > 0.2 ? 'That is a real jump.' : 'Correct.',
        detail: result.mastery.mastered
          ? `That takes you to mastery on this concept. ${result.unlocked.length ? `It unlocks ${result.unlocked.map((u) => u.label).join(', ')}.` : ''}`
          : `Confidence moved from ${Math.round(result.mastery.before * 100)}% to ${Math.round(result.mastery.after * 100)}%.`,
        nextReview: result.memory.explanation,
      };
    }
    if (diagnosis?.found) {
      return {
        tone: 'diagnostic' as const,
        headline: diagnosis.feedback.acknowledge,
        detail: diagnosis.feedback.diagnose,
        contrast: diagnosis.feedback.contrast,
        nextStep: diagnosis.feedback.nextStep,
      };
    }
    return {
      tone: 'encouraging' as const,
      headline: 'Not that one.',
      detail: 'Nothing about your method looks broken, so this is more likely a slip than a misunderstanding.',
      nextStep: 'Read it once more out loud, then try again.',
    };
  }

  private stopCheck(session: SessionRecord) {
    const responses = this.repos.responses.forSession(session.id);
    const items = responses.filter((r) => r.itemId);
    const irt = items.map((r) => {
      const i = this.repos.items.get(r.itemId!);
      return i ? { item: { id: i.id, a: i.discrimination, b: i.difficulty, c: i.guessing }, correct: r.correct } : null;
    }).filter(Boolean) as { item: IrtItem; correct: boolean }[];
    const est = estimateAbilityEap(irt);
    const elapsedSec = Math.round((Date.now() - Date.parse(session.startedAt)) / 1000);
    return {
      ...shouldStop({ responses: irt.length, se: est.se, elapsedSec }, {
        maxItems: config.pedagogy.sessionMaxItems,
        minItems: 3,
      }),
      ability: est.theta,
      se: est.se,
    };
  }

  /* -------------------------------- summary ------------------------------ */

  summary(sessionId: string): SessionSummary {
    const session = this.repos.sessions.require(sessionId);
    const state = this.readState(session);
    const responses = this.repos.responses.forSession(sessionId);
    const correct = responses.filter((r) => r.correct).length;

    const conceptsTouched = state.deliveredConceptIds.map((conceptId) => {
      const record = this.repos.mastery.get(session.learnerId, conceptId);
      const concept = this.repos.concepts.get(conceptId);
      const sessionResponses = responses
        .filter((r) => r.conceptId === conceptId)
        .sort((a, b) => a.at.localeCompare(b.at));
      const after = record?.pKnown ?? 0;
      // The earliest response in this session carries the belief we started with.
      const recorded = (sessionResponses[0]?.feedback as Record<string, unknown> | undefined)?.pKnownBefore;
      const before = typeof recorded === 'number' ? recorded : after;
      return {
        conceptId,
        label: concept?.label ?? conceptId,
        before: round(before, 3),
        after: round(after, 3),
        delta: round(after - before, 3),
      };
    });

    const mastered = conceptsTouched
      .filter((c) => c.after >= config.pedagogy.masteryThreshold)
      .map((c) => c.label);

    const repaired = this.repos.db.all<{ misconception_id: string }>(
      `SELECT misconception_id FROM learner_misconceptions
       WHERE learner_id=? AND status='repaired' AND repaired_at >= ?`,
      [session.learnerId, session.startedAt],
    ).map((r) => this.repos.misconceptions.get(r.misconception_id)?.label ?? r.misconception_id);

    const elapsedSec = Math.round(
      ((session.endedAt ? Date.parse(session.endedAt) : Date.now()) - Date.parse(session.startedAt)) / 1000,
    );

    const highlights: string[] = [];
    if (mastered.length) highlights.push(`Reached mastery on ${mastered.join(', ')}.`);
    const repairs = state.decisions.filter((d) => d.action === 'repair_misconception' || d.action === 'repair_prerequisite');
    if (repairs.length) highlights.push(`${repairs.length} repair step(s) rather than pushing forward on a shaky foundation.`);
    if (state.explanationSwitches) highlights.push(`Changed representation ${state.explanationSwitches} time(s) when an explanation was not landing.`);
    if (state.breaksTaken) highlights.push(`Took ${state.breaksTaken} break(s) when load got high.`);
    if (responses.length) highlights.push(`${correct} of ${responses.length} correct.`);

    const nextTime: string[] = [];
    const weakest = conceptsTouched.filter((c) => c.after < config.pedagogy.masteryThreshold).sort((a, b) => a.after - b.after)[0];
    if (weakest) nextTime.push(`Start with ${weakest.label}, which finished at ${Math.round(weakest.after * 100)}%.`);
    const active = this.twin.activeMisconceptions(session.learnerId);
    if (active.length) nextTime.push(`Still active: ${active.slice(0, 2).map((m) => m.label).join('; ')}.`);
    const due = this.twin.dueForReview(session.learnerId, 3);
    if (due.length) nextTime.push(`Due for review: ${due.map((d) => d.label).join(', ')}.`);

    return {
      sessionId,
      learnerId: session.learnerId,
      status: session.status,
      steps: session.step,
      itemsDelivered: responses.length,
      elapsedSec,
      conceptsTouched,
      mastered,
      misconceptionsRepaired: repaired,
      accuracy: responses.length ? round(correct / responses.length, 3) : 0,
      endReason: session.endReason,
      highlights,
      nextTime,
    };
  }

  /** Full decision trail, for a teacher reviewing what the system did and why. */
  trace(sessionId: string) {
    const session = this.repos.sessions.require(sessionId);
    const state = this.readState(session);
    return {
      sessionId,
      learnerId: session.learnerId,
      goalConceptId: session.goalConceptId,
      startedAt: session.startedAt,
      steps: state.decisions.map((d) => ({
        ...d,
        conceptLabel: d.conceptId ? this.repos.concepts.get(d.conceptId)?.label : undefined,
      })),
      modalitiesTried: state.triedModalities,
      explanationSwitches: state.explanationSwitches,
      breaksTaken: state.breaksTaken,
      responses: this.repos.responses.forSession(sessionId).map((r) => ({
        at: r.at, conceptId: r.conceptId, correct: r.correct,
        latencyMs: r.latencyMs, hintsUsed: r.hintsUsed, modality: r.modality,
        misconceptionId: r.misconceptionId,
      })),
    };
  }

  private readState(session: SessionRecord): SessionState {
    const s = session.state as unknown as Partial<SessionState>;
    return {
      deliveredConceptIds: s.deliveredConceptIds ?? [],
      deliveryCounts: s.deliveryCounts ?? {},
      answeredConceptIds: s.answeredConceptIds ?? [],
      triedModalities: s.triedModalities ?? {},
      seenItemIds: s.seenItemIds ?? [],
      explanationSwitches: s.explanationSwitches ?? 0,
      breaksTaken: s.breaksTaken ?? 0,
      decisions: s.decisions ?? [],
      lastExperienceId: s.lastExperienceId,
      currentConceptId: s.currentConceptId,
    };
  }

  active(learnerId: string): SessionRecord {
    const s = this.repos.sessions.activeFor(learnerId);
    if (!s) throw notFound('active session for learner', learnerId);
    return s;
  }
}
