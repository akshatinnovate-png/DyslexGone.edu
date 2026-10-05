import type { Repos } from '../db/repos.js';
import { betaInterval, betaMean, betaProbGreater, hashStringToInt, round, sampleBeta, seededRng } from '../core/mathx.js';
import { id as newId } from '../core/ids.js';
import { bus } from '../core/events.js';
import { notFound, unprocessable } from '../core/errors.js';

/** THE LEARNING EXPERIMENT ENGINE
 *
 *  Which explanation actually works? Not which one we like - which one produces
 *  learning.
 *
 *  Arms are assigned by Thompson sampling, so the experiment stops wasting
 *  learners on a losing arm as evidence accumulates. Conclusions use Bayesian
 *  probability-of-superiority rather than a p-value, because the question a
 *  teacher asks is "how sure are we that A is better", not "would we reject the
 *  null". */

export interface Arm {
  key: string;
  label: string;
  /** Anything the caller needs to realise this arm: modality, strategy, text. */
  config: Record<string, unknown>;
}

export interface Experiment {
  id: string;
  name: string;
  hypothesis: string;
  unit: 'learner' | 'session' | 'delivery';
  scope: 'global' | 'concept' | 'classroom';
  scopeRef?: string | null;
  arms: Arm[];
  status: 'running' | 'concluded' | 'stopped';
  allocation: 'thompson' | 'uniform';
  winner?: string | null;
  createdAt: string;
  concludedAt?: string | null;
}

export interface ArmStats {
  key: string;
  label: string;
  assignments: number;
  observations: number;
  meanReward: number;
  interval: [number, number];
  probabilityBest: number;
  lift: number | null;
}

export interface ExperimentReport {
  experiment: Experiment;
  arms: ArmStats[];
  totalObservations: number;
  leader: string | null;
  confidence: number;
  decision: 'keep_running' | 'conclude' | 'inconclusive';
  recommendation: string;
  minimumObservationsPerArm: number;
}

const MIN_PER_ARM = 12;

export class ExperimentService {
  constructor(private repos: Repos) {}

  create(input: {
    name: string;
    hypothesis?: string;
    arms: Arm[];
    unit?: Experiment['unit'];
    scope?: Experiment['scope'];
    scopeRef?: string;
    allocation?: Experiment['allocation'];
  }): Experiment {
    if (input.arms.length < 2) throw unprocessable('an experiment needs at least two arms');
    if (new Set(input.arms.map((a) => a.key)).size !== input.arms.length) {
      throw unprocessable('arm keys must be unique');
    }

    const e: Experiment = {
      id: newId('exp'),
      name: input.name,
      hypothesis: input.hypothesis ?? '',
      unit: input.unit ?? 'learner',
      scope: input.scope ?? 'global',
      scopeRef: input.scopeRef ?? null,
      arms: input.arms,
      status: 'running',
      allocation: input.allocation ?? 'thompson',
      winner: null,
      createdAt: new Date().toISOString(),
      concludedAt: null,
    };
    this.repos.db.insert('experiments', {
      id: e.id, name: e.name, hypothesis: e.hypothesis, unit: e.unit, scope: e.scope,
      scope_ref: e.scopeRef, arms: e.arms, status: e.status, allocation: e.allocation,
      winner: null, created_at: e.createdAt, concluded_at: null,
    });
    return e;
  }

  get(id: string): Experiment {
    const r = this.repos.db.one<Record<string, unknown>>('SELECT * FROM experiments WHERE id=?', [id]);
    if (!r) throw notFound('experiment', id);
    return {
      id: String(r.id), name: String(r.name), hypothesis: String(r.hypothesis),
      unit: String(r.unit) as Experiment['unit'], scope: String(r.scope) as Experiment['scope'],
      scopeRef: (r.scope_ref as string) ?? null,
      arms: JSON.parse(String(r.arms)) as Arm[],
      status: String(r.status) as Experiment['status'],
      allocation: String(r.allocation) as Experiment['allocation'],
      winner: (r.winner as string) ?? null,
      createdAt: String(r.created_at), concludedAt: (r.concluded_at as string) ?? null,
    };
  }

  list(status?: Experiment['status']): Experiment[] {
    const rows = status
      ? this.repos.db.all<{ id: string }>('SELECT id FROM experiments WHERE status=? ORDER BY created_at DESC', [status])
      : this.repos.db.all<{ id: string }>('SELECT id FROM experiments ORDER BY created_at DESC LIMIT 100');
    return rows.map((r) => this.get(r.id));
  }

  /** Assign a subject to an arm. Sticky: the same subject always gets the same
   *  arm, or the comparison measures nothing. */
  assign(experimentId: string, subjectId: string): { arm: Arm; existing: boolean; reason: string } {
    const exp = this.get(experimentId);
    if (exp.status !== 'running') {
      const winner = exp.arms.find((a) => a.key === exp.winner) ?? exp.arms[0];
      return { arm: winner, existing: true, reason: `Experiment is ${exp.status}; everyone gets the winning arm.` };
    }

    const prior = this.repos.db.one<{ arm: string }>(
      'SELECT arm FROM experiment_assignments WHERE experiment_id=? AND subject_id=?',
      [experimentId, subjectId],
    );
    if (prior) {
      const arm = exp.arms.find((a) => a.key === prior.arm) ?? exp.arms[0];
      return { arm, existing: true, reason: 'Already assigned; assignment is sticky.' };
    }

    const stats = this.armStats(exp);
    let chosen: Arm;
    let reason: string;

    if (exp.allocation === 'uniform') {
      // Deterministic hash: an even split without a coin flip per request.
      const idx = hashStringToInt(`${experimentId}:${subjectId}`) % exp.arms.length;
      chosen = exp.arms[idx];
      reason = 'Uniform allocation by stable hash.';
    } else {
      const rng = seededRng(`${experimentId}:${subjectId}`);
      const draws = exp.arms.map((a) => {
        const s = stats.find((x) => x.key === a.key)!;
        const alpha = 1 + s.meanReward * s.observations;
        const beta = 1 + (1 - s.meanReward) * s.observations;
        return { arm: a, draw: sampleBeta(rng, Math.max(0.05, alpha), Math.max(0.05, beta)) };
      }).sort((a, b) => b.draw - a.draw);
      chosen = draws[0].arm;
      reason = `Thompson sampling drew ${round(draws[0].draw, 3)} for "${chosen.label}"`
        + (draws[1] ? `, beating "${draws[1].arm.label}" at ${round(draws[1].draw, 3)}.` : '.');
    }

    this.repos.db.insert('experiment_assignments', {
      id: newId('asg'), experiment_id: experimentId, subject_id: subjectId,
      arm: chosen.key, at: new Date().toISOString(),
    });
    bus.emit('experiment.assigned', { experimentId, learnerId: subjectId, arm: chosen.key });
    return { arm: chosen, existing: false, reason };
  }

  /** Record how well an arm worked, 0..1. */
  observe(experimentId: string, subjectId: string, reward: number, meta: Record<string, unknown> = {}): void {
    const exp = this.get(experimentId);
    const assignment = this.repos.db.one<{ arm: string }>(
      'SELECT arm FROM experiment_assignments WHERE experiment_id=? AND subject_id=?',
      [experimentId, subjectId],
    );
    if (!assignment) throw unprocessable('this subject was never assigned to an arm');

    this.repos.db.insert('experiment_observations', {
      id: newId('obs'), experiment_id: experimentId, subject_id: subjectId,
      arm: assignment.arm, reward: Math.max(0, Math.min(1, reward)),
      meta, at: new Date().toISOString(),
    });
    bus.emit('experiment.observed', { experimentId, arm: assignment.arm, reward });
    void exp;
  }

  private armStats(exp: Experiment): ArmStats[] {
    const rows = this.repos.db.all<{ arm: string; n: number; total: number }>(
      'SELECT arm, COUNT(*) as n, SUM(reward) as total FROM experiment_observations WHERE experiment_id=? GROUP BY arm',
      [exp.id],
    );
    const assignments = this.repos.db.all<{ arm: string; n: number }>(
      'SELECT arm, COUNT(*) as n FROM experiment_assignments WHERE experiment_id=? GROUP BY arm',
      [exp.id],
    );

    const base = exp.arms.map((a) => {
      const obs = rows.find((r) => r.arm === a.key);
      const n = Number(obs?.n ?? 0);
      const total = Number(obs?.total ?? 0);
      const alpha = 1 + total;
      const beta = 1 + (n - total);
      return {
        key: a.key,
        label: a.label,
        assignments: Number(assignments.find((x) => x.arm === a.key)?.n ?? 0),
        observations: n,
        meanReward: round(n ? total / n : 0, 4),
        interval: betaInterval(alpha, beta).map((v) => round(v, 3)) as [number, number],
        probabilityBest: 0,
        lift: null as number | null,
        _alpha: alpha,
        _beta: beta,
      };
    });

    // Probability each arm is the best, by Monte Carlo over the posteriors.
    const rng = seededRng(exp.id);
    const draws = 3000;
    const wins = new Map(base.map((b) => [b.key, 0]));
    for (let i = 0; i < draws; i++) {
      let bestKey = base[0].key;
      let bestVal = -1;
      for (const b of base) {
        const v = sampleBeta(rng, b._alpha, b._beta);
        if (v > bestVal) { bestVal = v; bestKey = b.key; }
      }
      wins.set(bestKey, (wins.get(bestKey) ?? 0) + 1);
    }

    const control = base[0];
    return base.map((b) => ({
      key: b.key,
      label: b.label,
      assignments: b.assignments,
      observations: b.observations,
      meanReward: b.meanReward,
      interval: b.interval,
      probabilityBest: round((wins.get(b.key) ?? 0) / draws, 4),
      lift: b.key === control.key || !control.meanReward
        ? null
        : round((b.meanReward - control.meanReward) / control.meanReward, 4),
    }));
  }

  report(experimentId: string): ExperimentReport {
    const exp = this.get(experimentId);
    const arms = this.armStats(exp).sort((a, b) => b.probabilityBest - a.probabilityBest);
    const total = arms.reduce((a, b) => a + b.observations, 0);
    const leader = arms[0];
    const runnerUp = arms[1];

    // Thompson sampling deliberately STARVES a losing arm - that starvation is
    // itself the evidence. Demanding a minimum on every arm would mean a
    // bandit-allocated experiment could never conclude, so the gate is: the
    // leader must be well sampled, and either every arm cleared the minimum or
    // the leader is overwhelming on a reasonable total.
    const allClearedMinimum = arms.every((a) => a.observations >= MIN_PER_ARM);
    const leaderWellSampled = leader.observations >= MIN_PER_ARM;
    const enough = leaderWellSampled
      && (allClearedMinimum || (leader.probabilityBest >= 0.99 && total >= MIN_PER_ARM * arms.length));
    const confident = leader.probabilityBest >= 0.95;

    const decision: ExperimentReport['decision'] =
      exp.status !== 'running' ? 'conclude'
      : confident && enough ? 'conclude'
      : total > MIN_PER_ARM * arms.length * 4 && leader.probabilityBest < 0.8 ? 'inconclusive'
      : 'keep_running';

    const recommendation = (() => {
      if (!enough) {
        if (!leaderWellSampled) {
          return `Not enough evidence yet: the leading arm "${leader.label}" has only `
            + `${leader.observations} of ${MIN_PER_ARM} observations.`;
        }
        const short = arms.filter((a) => a.observations < MIN_PER_ARM);
        return `"${leader.label}" leads at ${Math.round(leader.probabilityBest * 100)}%, but `
          + `${short.map((a) => `"${a.label}" has only ${a.observations} observation(s)`).join('; ')}. `
          + `Either keep running, or conclude with force if you accept the bandit's allocation as evidence.`;
      }
      if (decision === 'conclude') {
        const pct = Math.round(leader.probabilityBest * 100);
        const starved = arms.filter((a) => a.observations < MIN_PER_ARM);
        const note = starved.length
          ? `The allocator stopped sampling ${starved.map((a) => `"${a.label}"`).join(', ')}, which is itself the evidence. `
          : '';
        return `${note}"${leader.label}" is best with ${pct}% probability `
          + `(mean reward ${leader.meanReward} against ${runnerUp?.meanReward ?? 0}). `
          + `${leader.lift !== null && leader.lift > 0 ? `That is a ${Math.round(leader.lift * 100)}% lift over the control. ` : ''}`
          + `Ship it.`;
      }
      if (decision === 'inconclusive') {
        return `After ${total} observations no arm is clearly better. `
          + `They are probably equivalent for this population - pick on cost or simplicity.`;
      }
      return `"${leader.label}" leads at ${Math.round(leader.probabilityBest * 100)}% probability. `
        + `Keep running until it passes 95% or the arms separate.`;
    })();

    return {
      experiment: exp,
      arms,
      totalObservations: total,
      leader: leader.observations ? leader.key : null,
      confidence: leader.probabilityBest,
      decision,
      recommendation,
      minimumObservationsPerArm: MIN_PER_ARM,
    };
  }

  conclude(experimentId: string, force = false): ExperimentReport {
    const report = this.report(experimentId);
    if (report.decision !== 'conclude' && !force) {
      throw unprocessable(`not ready to conclude: ${report.recommendation}`, { report });
    }
    const winner = report.arms[0].key;
    this.repos.db.run(
      `UPDATE experiments SET status='concluded', winner=?, concluded_at=? WHERE id=?`,
      [winner, new Date().toISOString(), experimentId],
    );
    bus.emit('experiment.concluded', { experimentId, winner, probability: report.confidence });
    return this.report(experimentId);
  }

  stop(experimentId: string): Experiment {
    this.repos.db.run(`UPDATE experiments SET status='stopped', concluded_at=? WHERE id=?`,
      [new Date().toISOString(), experimentId]);
    return this.get(experimentId);
  }

  /** Probability A beats B directly, for a two-arm readout. */
  headToHead(experimentId: string, a: string, b: string): { probability: number; summary: string } {
    const arms = this.armStats(this.get(experimentId));
    const armA = arms.find((x) => x.key === a);
    const armB = arms.find((x) => x.key === b);
    if (!armA || !armB) throw unprocessable('unknown arm key');
    const p = betaProbGreater(
      1 + armA.meanReward * armA.observations, 1 + (1 - armA.meanReward) * armA.observations,
      1 + armB.meanReward * armB.observations, 1 + (1 - armB.meanReward) * armB.observations,
    );
    return {
      probability: round(p, 4),
      summary: `"${armA.label}" beats "${armB.label}" with ${Math.round(p * 100)}% probability `
        + `(${armA.observations} vs ${armB.observations} observations).`,
    };
  }

  /** A ready-made experiment comparing two ways of explaining one concept. */
  compareModalities(conceptId: string, modalities: string[], name?: string): Experiment {
    return this.create({
      name: name ?? `Modality comparison for ${conceptId}`,
      hypothesis: `One of ${modalities.join(', ')} produces more learning than the others for this concept.`,
      unit: 'learner',
      scope: 'concept',
      scopeRef: conceptId,
      allocation: 'thompson',
      arms: modalities.map((m) => ({
        key: m,
        label: `${m} explanation`,
        config: { modality: m, conceptId },
      })),
    });
  }
}

export { betaMean };
