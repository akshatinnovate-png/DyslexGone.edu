import type { Repos } from '../db/repos.js';
import type { GraphService } from '../graph/service.js';
import { retention } from '../twin/fsrs.js';
import { DAY } from '../core/clock.js';
import { mean, median, round, stdev } from '../core/mathx.js';

/** LEARNING ANALYTICS
 *
 *  Not "80%". The questions that actually matter: did it stick, how long did it
 *  take to land, how many attempts, which representation worked, and is any of
 *  this holding up weeks later. */

export class AnalyticsService {
  constructor(private repos: Repos, private graph: GraphService) {}

  /** One learner, over time. */
  learner(learnerId: string) {
    const learner = this.repos.learners.require(learnerId);
    const responses = this.repos.responses.forLearner(learnerId, 1000);
    const mastery = this.repos.mastery.forLearner(learnerId);
    const sessions = this.repos.sessions.forLearner(learnerId, 100);
    const now = Date.now();

    const byDay = new Map<string, { n: number; correct: number }>();
    for (const r of responses) {
      const day = r.at.slice(0, 10);
      const e = byDay.get(day) ?? { n: 0, correct: 0 };
      e.n++;
      if (r.correct) e.correct++;
      byDay.set(day, e);
    }

    // Time-to-mastery: how long from first attempt to crossing threshold.
    const timeToMastery = mastery
      .filter((m) => m.firstMasteredAt)
      .map((m) => {
        const first = this.repos.responses.forLearnerConcept(learnerId, m.conceptId, 200).at(-1);
        if (!first) return null;
        const hours = (Date.parse(m.firstMasteredAt!) - Date.parse(first.at)) / 3_600_000;
        const attempts = this.repos.responses.forLearnerConcept(learnerId, m.conceptId, 200).length;
        return {
          conceptId: m.conceptId,
          label: this.repos.concepts.get(m.conceptId)?.label ?? m.conceptId,
          hours: round(Math.max(0, hours), 2),
          attempts,
        };
      })
      .filter(Boolean) as { conceptId: string; label: string; hours: number; attempts: number }[];

    // Retention right now, for everything ever learned.
    const retentionNow = mastery
      .filter((m) => m.lastSeen && m.stability > 0)
      .map((m) => ({
        conceptId: m.conceptId,
        label: this.repos.concepts.get(m.conceptId)?.label ?? m.conceptId,
        retention: round(retention(m.stability, (now - Date.parse(m.lastSeen!)) / DAY), 3),
        daysSince: round((now - Date.parse(m.lastSeen!)) / DAY, 1),
      }))
      .sort((a, b) => a.retention - b.retention);

    // Which representation actually worked, by outcome not preference.
    const byModality = new Map<string, { n: number; correct: number; gain: number }>();
    for (const r of responses) {
      if (!r.modality) continue;
      const e = byModality.get(r.modality) ?? { n: 0, correct: 0, gain: 0 };
      e.n++;
      if (r.correct) e.correct++;
      byModality.set(r.modality, e);
    }

    const latencies = responses.map((r) => r.latencyMs).filter((l) => l > 0);

    return {
      learner: { id: learner.id, name: learner.name, grade: learner.grade, needs: learner.needs },
      totals: {
        responses: responses.length,
        correct: responses.filter((r) => r.correct).length,
        accuracy: responses.length ? round(responses.filter((r) => r.correct).length / responses.length, 3) : 0,
        conceptsTouched: mastery.filter((m) => m.attempts > 0).length,
        conceptsMastered: mastery.filter((m) => m.pKnown >= 0.8).length,
        sessions: sessions.length,
        hintsUsed: responses.reduce((a, r) => a + r.hintsUsed, 0),
      },
      activity: [...byDay.entries()].sort().map(([day, v]) => ({
        day, responses: v.n, accuracy: round(v.correct / v.n, 3),
      })),
      timeToMastery: {
        concepts: timeToMastery,
        medianHours: timeToMastery.length ? round(median(timeToMastery.map((t) => t.hours)), 2) : null,
        medianAttempts: timeToMastery.length ? round(median(timeToMastery.map((t) => t.attempts)), 1) : null,
      },
      retention: {
        concepts: retentionNow,
        meanRetention: retentionNow.length ? round(mean(retentionNow.map((r) => r.retention)), 3) : null,
        atRisk: retentionNow.filter((r) => r.retention < 0.6).length,
      },
      modalityEffectiveness: [...byModality.entries()]
        .map(([modality, v]) => ({
          modality, deliveries: v.n, accuracy: round(v.correct / v.n, 3),
        }))
        .sort((a, b) => b.accuracy - a.accuracy),
      pacing: {
        medianLatencyMs: latencies.length ? Math.round(median(latencies)) : null,
        latencySpreadMs: latencies.length ? Math.round(stdev(latencies)) : null,
      },
      misconceptions: this.repos.db.all(
        `SELECT misconception_id, status, confidence, occurrences, first_at, repaired_at
         FROM learner_misconceptions WHERE learner_id=? ORDER BY last_at DESC`, [learnerId],
      ).map((r) => ({
        ...r,
        label: this.repos.misconceptions.get(String(r.misconception_id))?.label,
      })),
    };
  }

  /** Across every learner: what is working, system-wide. */
  cohort(opts: { subject?: string; sinceDays?: number } = {}) {
    const since = new Date(Date.now() - (opts.sinceDays ?? 30) * DAY).toISOString();
    const learners = this.repos.learners.list(1000);

    const responses = this.repos.db.all<{
      concept_id: string; correct: number; modality: string | null; latency_ms: number; hints_used: number;
    }>('SELECT concept_id, correct, modality, latency_ms, hints_used FROM responses WHERE at >= ?', [since]);

    const byConcept = new Map<string, { n: number; correct: number; latency: number[]; hints: number }>();
    for (const r of responses) {
      if (!r.concept_id) continue;
      const e = byConcept.get(r.concept_id) ?? { n: 0, correct: 0, latency: [], hints: 0 };
      e.n++;
      if (r.correct) e.correct++;
      if (r.latency_ms > 0) e.latency.push(r.latency_ms);
      e.hints += r.hints_used;
      byConcept.set(r.concept_id, e);
    }

    const conceptStats = [...byConcept.entries()]
      .map(([conceptId, v]) => {
        const c = this.repos.concepts.get(conceptId);
        return {
          conceptId,
          slug: c?.slug,
          label: c?.label ?? conceptId,
          subject: c?.subject,
          attempts: v.n,
          accuracy: round(v.correct / v.n, 3),
          medianLatencyMs: v.latency.length ? Math.round(median(v.latency)) : null,
          hintsPerAttempt: round(v.hints / v.n, 2),
        };
      })
      .filter((s) => !opts.subject || s.subject === opts.subject)
      .sort((a, b) => a.accuracy - b.accuracy);

    const miscRows = this.repos.db.all<{ misconception_id: string; n: number }>(
      `SELECT misconception_id, COUNT(*) as n FROM learner_misconceptions
       WHERE status='active' GROUP BY misconception_id ORDER BY n DESC LIMIT 20`,
    );

    const modalityRows = this.repos.db.all<{ modality: string; n: number; correct: number }>(
      `SELECT modality, COUNT(*) as n, SUM(correct) as correct FROM responses
       WHERE modality IS NOT NULL AND at >= ? GROUP BY modality`, [since],
    );

    return {
      window: { sinceDays: opts.sinceDays ?? 30, since },
      learners: {
        total: learners.length,
        active: learners.filter((l) =>
          this.repos.responses.forLearner(l.id, 1).some((r) => r.at >= since)).length,
      },
      totals: {
        responses: responses.length,
        accuracy: responses.length ? round(responses.filter((r) => r.correct).length / responses.length, 3) : 0,
      },
      hardestConcepts: conceptStats.slice(0, 15),
      easiestConcepts: [...conceptStats].reverse().slice(0, 10),
      commonMisconceptions: miscRows.map((r) => {
        const m = this.repos.misconceptions.get(r.misconception_id);
        return {
          code: m?.code ?? r.misconception_id,
          label: m?.label,
          severity: m?.severity,
          learnersAffected: Number(r.n),
          share: round(Number(r.n) / Math.max(1, learners.length), 3),
        };
      }),
      modalityEffectiveness: modalityRows
        .map((r) => ({
          modality: r.modality,
          deliveries: Number(r.n),
          accuracy: round(Number(r.correct) / Math.max(1, Number(r.n)), 3),
        }))
        .sort((a, b) => b.accuracy - a.accuracy),
      curriculum: (() => {
        const h = this.graph.health();
        return { concepts: h.nodes, links: h.edges, warnings: h.warnings };
      })(),
    };
  }

  /** Is the OS doing its job? Measures the system, not the student. */
  systemEffectiveness(sinceDays = 30) {
    const since = new Date(Date.now() - sinceDays * DAY).toISOString();

    const repaired = this.repos.db.count(
      `SELECT COUNT(*) FROM learner_misconceptions WHERE status='repaired' AND repaired_at >= ?`, [since],
    );
    const detected = this.repos.db.count(
      'SELECT COUNT(*) FROM learner_misconceptions WHERE first_at >= ?', [since],
    );

    const sessions = this.repos.db.all<{ id: string; metrics: string; step: number }>(
      'SELECT id, metrics, step FROM sessions WHERE started_at >= ?', [since],
    );
    const withItems = sessions.filter((s) => {
      const m = JSON.parse(s.metrics || '{}') as { itemsDelivered?: number };
      return (m.itemsDelivered ?? 0) > 0;
    });

    const masteryEvents = this.repos.db.count(
      'SELECT COUNT(*) FROM learner_mastery WHERE first_mastered_at >= ?', [since],
    );

    return {
      window: { sinceDays, since },
      misconceptions: {
        detected,
        repaired,
        repairRate: detected ? round(repaired / detected, 3) : null,
        interpretation: detected === 0
          ? 'No misconceptions detected in this window.'
          : repaired / detected > 0.5
            ? 'Most detected misconceptions are being closed, which is what the repair loop is for.'
            : 'Detection is outpacing repair. Check whether repair steps are actually being delivered.',
      },
      sessions: {
        started: sessions.length,
        withAssessment: withItems.length,
        assessmentCoverage: sessions.length ? round(withItems.length / sessions.length, 3) : null,
        medianSteps: sessions.length ? round(median(sessions.map((s) => s.step)), 1) : null,
        interpretation: sessions.length && withItems.length / sessions.length < 0.6
          ? 'Many sessions deliver content without checking it. Those concepts have no item bank.'
          : 'Sessions are checking what they teach.',
      },
      mastery: { conceptsMastered: masteryEvents },
      itemBank: (() => {
        const total = this.repos.items.count();
        const diagnostic = this.repos.db.count(
          `SELECT COUNT(*) FROM items WHERE misconception_map != '{}'`,
        );
        const calibrated = this.repos.db.count('SELECT COUNT(*) FROM items WHERE exposures >= 5');
        return {
          items: total,
          diagnostic,
          diagnosticShare: total ? round(diagnostic / total, 3) : 0,
          calibrated,
          interpretation: total === 0
            ? 'No items exist yet.'
            : diagnostic / total < 0.2
              ? 'Few items carry diagnostic distractors, so most wrong answers cannot be explained.'
              : 'A healthy share of items diagnose rather than just mark.',
        };
      })(),
    };
  }
}
