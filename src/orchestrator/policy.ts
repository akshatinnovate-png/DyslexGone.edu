import type { Modality, PlanStep } from '../domain/types.js';
import type { MasteryView } from '../twin/service.js';
import type { GapTrace } from '../graph/algorithms.js';
import type { RecoveryNeed } from '../twin/fsrs.js';
import type { CognitiveLoadEstimate } from '../domain/types.js';
import type { FrictionVerdict } from '../twin/cogload.js';
import { clamp, round } from '../core/mathx.js';

/** THE ADAPTIVE POLICY
 *
 *  "What should this student experience next?" - answered as an explicit,
 *  inspectable decision rather than a model's hunch. Candidate actions are
 *  scored against the twin's current state, the highest wins, and the
 *  reasoning for every candidate is returned so a teacher can disagree with it.
 *
 *  Priority is deliberately NOT "whatever comes next in the book":
 *    1. safety     - the learner is overloaded; stop
 *    2. repair     - a misconception is actively wrong; fix it before building on it
 *    3. prerequisite - the foundation is missing; going forward is wasted effort
 *    4. recovery   - something needed today has decayed
 *    5. progress   - teach the next thing they are ready for
 *    6. consolidate- practise what is nearly there
 *    7. extend     - stretch what is solid
 */

export type ActionKind =
  | 'break' | 'repair_misconception' | 'repair_prerequisite' | 'refresh_decayed'
  | 'diagnose' | 'teach' | 'practice' | 'review' | 'extend' | 'celebrate' | 'switch_modality';

export interface Candidate {
  kind: ActionKind;
  conceptId?: string;
  misconceptionCode?: string;
  modality?: Modality;
  score: number;
  priority: number;
  reason: string;
  estimatedSec: number;
  evidence: Record<string, unknown>;
}

export interface PolicyInput {
  mastery: MasteryView[];
  load: CognitiveLoadEstimate;
  friction: FrictionVerdict;
  activeMisconceptions: { code: string; conceptId?: string | null; confidence: number; severity: string; label: string }[];
  gapTrace?: GapTrace & { gapConcepts?: { concept: { id: string; label: string }; mastery: number; depth: number }[] };
  frontier: { conceptId: string; concept: { label: string; difficulty: number }; readiness: number; unlocks: number; score?: number }[];
  recovery: RecoveryNeed[];
  dueForReview: MasteryView[];
  /** Concepts already covered this session, so it does not loop. */
  sessionConceptIds: string[];
  /** How many times each concept has been delivered this session. */
  deliveryCounts: Record<string, number>;
  /** Concepts the learner has answered something about this session. */
  answeredConceptIds: string[];
  /** Modalities already tried for the current concept this session. */
  triedModalities: Modality[];
  goalConceptId?: string;
  sessionSeconds: number;
  itemsDelivered: number;
  masteryThreshold: number;
  loadCeiling: number;
  conceptLabel: (id: string) => string;
}

export interface PolicyDecision {
  chosen: Candidate;
  runnersUp: Candidate[];
  narrative: string;
  /** Everything considered, for auditing why something was NOT chosen. */
  considered: number;
}

const PRIORITY: Record<ActionKind, number> = {
  break: 100,
  repair_misconception: 90,
  repair_prerequisite: 85,
  switch_modality: 80,
  refresh_decayed: 70,
  diagnose: 60,
  teach: 50,
  practice: 40,
  review: 30,
  extend: 20,
  celebrate: 10,
};

export function decide(input: PolicyInput): PolicyDecision {
  const candidates: Candidate[] = [];
  const seen = new Set(input.sessionConceptIds);

  /* 1. Safety first. An overloaded learner cannot learn, and pushing on is how
        a bad session becomes a bad relationship with the subject. */
  const breaksTaken = input.deliveryCounts['__break__'] ?? 0;
  if ((input.load.load > input.loadCeiling || input.friction.action === 'offer_break') && breaksTaken < 3) {
    candidates.push({
      kind: 'break',
      score: 1,
      priority: PRIORITY.break,
      estimatedSec: 120,
      reason: `Cognitive load is ${input.load.load} (ceiling ${input.loadCeiling}). `
        + `Largest contributors: ${topContributors(input.load)}. Continuing now would teach frustration, not the concept.`,
      evidence: { load: input.load.load, contributors: input.load.contributors, friction: input.friction.signals.map((s) => s.kind) },
    });
  }

  /* 2. An active misconception is worse than ignorance: it is a confident wrong
        rule that will corrupt everything built on top of it. */
  for (const m of input.activeMisconceptions.slice(0, 3)) {
    const weight = m.severity === 'critical' ? 1 : m.severity === 'moderate' ? 0.75 : 0.5;
    const repaired = m.conceptId ? (input.deliveryCounts[`msc:${m.code}`] ?? 0) : 0;
    if (repaired >= 2) continue;   // two repair attempts is enough before moving on
    candidates.push({
      kind: 'repair_misconception',
      conceptId: m.conceptId ?? undefined,
      misconceptionCode: m.code,
      score: round(clamp(m.confidence * weight * (repaired ? 0.5 : 1)), 4),
      priority: PRIORITY.repair_misconception - repaired,
      estimatedSec: 240,
      reason: `"${m.label}" is active at ${Math.round(m.confidence * 100)}% confidence (${m.severity}). `
        + `This is a wrong rule, not a gap - teaching more on top of it compounds the error.`,
      evidence: { code: m.code, confidence: m.confidence, severity: m.severity },
    });
  }

  /* 3. Missing foundation. The visible failure is rarely where the problem is.
        Re-teaching the SAME root identically is not repair, it is a loop - so a
        concept already delivered this session either escalates to a different
        representation or yields to the next gap down the chain. */
  const gaps = input.gapTrace?.gapConcepts ?? [];
  for (const [i, root] of gaps.slice(0, 3).entries()) {
    const delivered = input.deliveryCounts[root.concept.id] ?? 0;
    const answered = input.answeredConceptIds.includes(root.concept.id);

    if (delivered >= 2 && !answered) {
      // Explained twice with nothing to show for it: stop explaining.
      continue;
    }
    if (delivered >= 3) continue;

    const repeatPenalty = delivered === 0 ? 1 : delivered === 1 ? 0.55 : 0.25;
    const depthPenalty = 1 - i * 0.12;
    candidates.push({
      kind: delivered > 0 ? 'switch_modality' : 'repair_prerequisite',
      conceptId: root.concept.id,
      score: round(clamp((0.6 + (1 - root.mastery) * 0.4) * repeatPenalty * depthPenalty), 4),
      priority: delivered > 0 ? PRIORITY.switch_modality - 1 : PRIORITY.repair_prerequisite - i,
      estimatedSec: 300,
      reason: delivered > 0
        ? `"${root.concept.label}" was already explained ${delivered} time(s) this session without it landing. `
          + `Same concept, different representation - repeating the same explanation louder does not work.`
        : `The struggle shows up at the target, but "${root.concept.label}" sits ${root.depth} step(s) upstream `
          + `at ${Math.round(root.mastery * 100)}% mastery. Repairing the root is cheaper than re-teaching the symptom.`,
      evidence: {
        rootConceptId: root.concept.id, mastery: root.mastery, depth: root.depth,
        gapCount: gaps.length, deliveredThisSession: delivered,
      },
    });
  }

  /* 4. The explanation is not landing. Change the representation, not the volume. */
  if (input.friction.action === 'switch_modality' && input.sessionConceptIds.length) {
    const current = input.sessionConceptIds[input.sessionConceptIds.length - 1];
    candidates.push({
      kind: 'switch_modality',
      conceptId: current,
      score: round(clamp(input.friction.score), 4),
      priority: PRIORITY.switch_modality,
      estimatedSec: 180,
      reason: `${input.friction.signals.map((s) => s.evidence).slice(0, 2).join(' ')} `
        + `Already tried: ${input.triedModalities.join(', ') || 'nothing yet'}. Trying a different representation.`,
      evidence: { frictionScore: input.friction.score, tried: input.triedModalities },
    });
  }

  /* 5. Knowledge recovery: today's lesson needs something that has decayed. */
  for (const r of input.recovery.slice(0, 2)) {
    candidates.push({
      kind: 'refresh_decayed',
      conceptId: r.conceptId,
      score: round(clamp(r.urgency), 4),
      priority: PRIORITY.refresh_decayed,
      estimatedSec: r.refresherSeconds,
      reason: `"${input.conceptLabel(r.conceptId)}" has decayed to ${Math.round(r.retention * 100)}% retention `
        + `after ${r.daysSince} days. ${r.reason}`,
      evidence: { retention: r.retention, daysSince: r.daysSince, urgency: r.urgency },
    });
  }

  /* 6. Spaced review of anything due. */
  for (const d of input.dueForReview.slice(0, 2)) {
    if (seen.has(d.conceptId)) continue;
    candidates.push({
      kind: 'review',
      conceptId: d.conceptId,
      score: round(clamp(0.45 + (1 - (d.retention ?? 1)) * 0.5), 4),
      priority: PRIORITY.review,
      estimatedSec: 120,
      reason: `"${d.label}" is due for spaced review (retention ${d.retention ?? 'unknown'}). `
        + `Retrieval now is what makes it stick; re-reading would not.`,
      evidence: { retention: d.retention, dueInDays: d.dueInDays, stability: d.stability },
    });
  }

  /* 7. Teach the next thing they are actually ready for. */
  for (const f of input.frontier.slice(0, 5)) {
    const delivered = input.deliveryCounts[f.conceptId] ?? 0;
    if (delivered >= 2) continue;
    if (seen.has(f.conceptId) && !input.answeredConceptIds.includes(f.conceptId)) continue;
    const record = input.mastery.find((m) => m.conceptId === f.conceptId);
    const untouched = !record || record.attempts === 0;
    candidates.push({
      kind: untouched ? 'teach' : 'practice',
      conceptId: f.conceptId,
      score: round(clamp(((f.score ?? f.readiness) * 0.85 + Math.min(1, f.unlocks / 6) * 0.15) * (delivered ? 0.5 : 1)), 4),
      priority: untouched ? PRIORITY.teach : PRIORITY.practice,
      estimatedSec: untouched ? 300 : 180,
      reason: untouched
        ? `Every prerequisite for "${f.concept.label}" is met and readiness is ${f.readiness}. `
          + `It unlocks ${f.unlocks} further concept(s).`
        : `"${f.concept.label}" is partly learned (${Math.round((record?.pKnown ?? 0) * 100)}%). `
          + `Practice converts a shaky idea into a reliable one.`,
      evidence: { readiness: f.readiness, unlocks: f.unlocks, pKnown: record?.pKnown ?? 0 },
    });
  }

  /* 8. A goal the caller asked for, if it is reachable. */
  if (input.goalConceptId && !seen.has(input.goalConceptId)) {
    const record = input.mastery.find((m) => m.conceptId === input.goalConceptId);
    if (!gaps.length) {
      candidates.push({
        kind: (record?.attempts ?? 0) === 0 ? 'teach' : 'practice',
        conceptId: input.goalConceptId,
        score: 0.82,
        priority: PRIORITY.teach + 2,
        estimatedSec: 300,
        reason: `"${input.conceptLabel(input.goalConceptId)}" is the stated goal and nothing upstream is blocking it.`,
        evidence: { goal: true, pKnown: record?.pKnown ?? 0 },
      });
    }
  }

  /* 9. Stretch what is already solid. */
  const solid = input.mastery.filter((m) => m.mastered && m.streak >= 3);
  if (solid.length && input.itemsDelivered > 3) {
    const best = solid.sort((a, b) => b.pKnown - a.pKnown)[0];
    candidates.push({
      kind: 'extend',
      conceptId: best.conceptId,
      score: 0.3,
      priority: PRIORITY.extend,
      estimatedSec: 240,
      reason: `"${best.label}" is solid at ${Math.round(best.pKnown * 100)}% with a ${best.streak}-streak. `
        + `A harder variant keeps it interesting without risking the foundation.`,
      evidence: { pKnown: best.pKnown, streak: best.streak },
    });
  }

  /* 10. End well. A session that ends on a win is one they come back to. */
  const masteredThisSession = input.mastery.filter(
    (m) => m.mastered && input.sessionConceptIds.includes(m.conceptId),
  );
  if (masteredThisSession.length && input.itemsDelivered >= 4) {
    candidates.push({
      kind: 'celebrate',
      conceptId: masteredThisSession[0].conceptId,
      score: 0.25 + Math.min(0.3, masteredThisSession.length * 0.1),
      priority: PRIORITY.celebrate,
      estimatedSec: 45,
      reason: `${masteredThisSession.length} concept(s) reached mastery this session: `
        + `${masteredThisSession.map((m) => m.label).join(', ')}. Naming the win is part of the learning.`,
      evidence: { mastered: masteredThisSession.map((m) => m.label) },
    });
  }

  if (!candidates.length) {
    candidates.push({
      kind: 'diagnose',
      score: 0.5,
      priority: PRIORITY.diagnose,
      estimatedSec: 180,
      reason: 'Not enough is known about this learner yet to choose confidently. '
        + 'A short diagnostic costs less than teaching the wrong thing.',
      evidence: { masteryRecords: input.mastery.length },
    });
  }

  // Priority dominates; score breaks ties within a priority band.
  const ranked = [...candidates].sort((a, b) => b.priority - a.priority || b.score - a.score);
  const chosen = ranked[0];

  return {
    chosen,
    runnersUp: ranked.slice(1, 5),
    considered: candidates.length,
    narrative: buildNarrative(chosen, ranked.slice(1, 3)),
  };
}

function topContributors(load: CognitiveLoadEstimate): string {
  return Object.entries(load.contributors)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k, v]) => `${k} (${v})`)
    .join(', ');
}

function buildNarrative(chosen: Candidate, runnersUp: Candidate[]): string {
  const why = `Next: ${describeAction(chosen)}. ${chosen.reason}`;
  if (!runnersUp.length) return why;
  const alt = runnersUp
    .map((r) => `${describeAction(r)} (priority ${r.priority}, score ${r.score})`)
    .join('; ');
  return `${why} Considered instead: ${alt}.`;
}

export function describeAction(c: Candidate): string {
  switch (c.kind) {
    case 'break': return 'take a short break';
    case 'repair_misconception': return `repair the misconception "${c.misconceptionCode}"`;
    case 'repair_prerequisite': return 'go back and repair a missing prerequisite';
    case 'switch_modality': return 'explain it a completely different way';
    case 'refresh_decayed': return 'refresh something that has faded';
    case 'diagnose': return 'run a short diagnostic';
    case 'teach': return 'teach a new concept';
    case 'practice': return 'practise a partly-learned concept';
    case 'review': return 'review something due';
    case 'extend': return 'stretch a solid concept';
    case 'celebrate': return 'name what was achieved';
  }
}

/** Turn a decision into a plan step the session can execute. */
export function toPlanStep(c: Candidate, modality: Modality): PlanStep {
  const intent: PlanStep['intent'] =
    c.kind === 'repair_misconception' || c.kind === 'repair_prerequisite' ? 'repair'
    : c.kind === 'refresh_decayed' || c.kind === 'review' ? 'review'
    : c.kind === 'teach' || c.kind === 'switch_modality' ? 'teach'
    : c.kind === 'practice' ? 'practice'
    : c.kind === 'extend' ? 'extend'
    : c.kind === 'celebrate' ? 'celebrate'
    : 'diagnose';
  return {
    conceptId: c.conceptId ?? '',
    intent,
    modality,
    reason: c.reason,
    estimatedSec: c.estimatedSec,
  };
}
