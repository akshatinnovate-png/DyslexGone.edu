import type { Repos } from '../db/repos.js';
import type { GraphService } from '../graph/service.js';
import type { TwinService } from '../twin/service.js';
import type { MisconceptionEngine } from '../misconception/engine.js';
import type { Modality } from '../domain/types.js';
import { kmeans, mean, round } from '../core/mathx.js';
import { id as newId } from '../core/ids.js';
import { notFound } from '../core/errors.js';

/** THE CLASSROOM ORCHESTRATOR
 *
 *  Thirty students, one teacher, one period. This answers the only question
 *  that actually matters in that room: who needs what, right now, and what do
 *  I physically do about it?
 *
 *  Groups are formed from mastery vectors over the concepts being taught, not
 *  from a single overall score - because "struggling at maths" is not an
 *  instruction, and "these six are missing division" is. */

export interface Classroom {
  id: string;
  name: string;
  teacher: string;
  subject: string;
  grade: number;
  createdAt: string;
}

export interface GroupPlan {
  conceptIds: string[];
  conceptLabels: string[];
  groups: {
    id: string;
    label: string;
    intent: 'extend' | 'teach' | 'repair_prerequisite' | 'repair_misconception' | 'review';
    learners: { id: string; name: string; mastery: number; note: string }[];
    meanMastery: number;
    whatTheyNeed: string;
    doThis: string;
    modality: Modality;
    estimatedMinutes: number;
  }[];
  unplaced: { id: string; name: string; reason: string }[];
  teacherBriefing: string;
  wholeClassNote?: string;
}

export class ClassroomOrchestrator {
  constructor(
    private repos: Repos,
    private graph: GraphService,
    private twin: TwinService,
    private misconceptions: MisconceptionEngine,
  ) {}

  create(input: { name: string; teacher?: string; subject?: string; grade?: number }): Classroom {
    const c: Classroom = {
      id: newId('cls'),
      name: input.name,
      teacher: input.teacher ?? '',
      subject: input.subject ?? 'general',
      grade: input.grade ?? 6,
      createdAt: new Date().toISOString(),
    };
    this.repos.db.insert('classrooms', {
      id: c.id, name: c.name, teacher: c.teacher, subject: c.subject,
      grade: c.grade, meta: {}, created_at: c.createdAt,
    });
    return c;
  }

  get(id: string): Classroom {
    const r = this.repos.db.one<Record<string, unknown>>('SELECT * FROM classrooms WHERE id=?', [id]);
    if (!r) throw notFound('classroom', id);
    return {
      id: String(r.id), name: String(r.name), teacher: String(r.teacher),
      subject: String(r.subject), grade: Number(r.grade), createdAt: String(r.created_at),
    };
  }

  list(): Classroom[] {
    return this.repos.db.all<Record<string, unknown>>('SELECT * FROM classrooms ORDER BY created_at DESC')
      .map((r) => ({
        id: String(r.id), name: String(r.name), teacher: String(r.teacher),
        subject: String(r.subject), grade: Number(r.grade), createdAt: String(r.created_at),
      }));
  }

  enroll(classroomId: string, learnerIds: string[]): { enrolled: number } {
    this.get(classroomId);
    let enrolled = 0;
    this.repos.db.tx(() => {
      for (const learnerId of learnerIds) {
        this.repos.learners.require(learnerId);
        this.repos.db.upsert('enrollments', ['classroom_id', 'learner_id'], {
          classroom_id: classroomId, learner_id: learnerId, at: new Date().toISOString(),
        });
        enrolled++;
      }
    });
    return { enrolled };
  }

  roster(classroomId: string): { id: string; name: string; grade: number; needs: string[] }[] {
    return this.repos.db.all<{ learner_id: string }>(
      'SELECT learner_id FROM enrollments WHERE classroom_id=?', [classroomId],
    ).map((r) => {
      const l = this.repos.learners.get(r.learner_id);
      return l ? { id: l.id, name: l.name, grade: l.grade, needs: l.needs as string[] } : null;
    }).filter(Boolean) as { id: string; name: string; grade: number; needs: string[] }[];
  }

  /** The grouping call: who needs what, and what to do about it. */
  group(classroomId: string, conceptRefs: string[], opts: { maxGroups?: number } = {}): GroupPlan {
    const roster = this.roster(classroomId);
    const concepts = conceptRefs.map((r) => this.graph.resolve(r));
    const conceptIds = concepts.map((c) => c.id);

    if (!roster.length) {
      return {
        conceptIds, conceptLabels: concepts.map((c) => c.label), groups: [], unplaced: [],
        teacherBriefing: 'No students are enrolled in this class yet.',
      };
    }

    // Each learner becomes a vector of mastery over the concepts being taught,
    // so grouping reflects WHICH gap they have, not just how big it is.
    const rows = roster.map((l) => {
      const lookup = this.graph.masteryLookup(l.id);
      const vector = conceptIds.map((cid) => lookup(cid));
      const active = this.twin.activeMisconceptions(l.id)
        .filter((m) => !m.conceptId || conceptIds.includes(m.conceptId));
      return { learner: l, vector, mean: mean(vector), misconceptions: active };
    });

    const groups: GroupPlan['groups'] = [];
    const placed = new Set<string>();

    /* 1. A shared misconception is its own group: the repair is the same for
          all of them, and it is not the same as "they are behind". */
    const byCode = new Map<string, typeof rows>();
    for (const r of rows) {
      for (const m of r.misconceptions) {
        if (m.confidence < 0.4) continue;
        const list = byCode.get(m.code) ?? [];
        list.push(r);
        byCode.set(m.code, list);
      }
    }
    for (const [code, members] of [...byCode.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const unique = members.filter((m) => !placed.has(m.learner.id));
      if (unique.length < 2) continue;
      const m = this.repos.misconceptions.byCode(code);
      const repair = m ? this.misconceptions.buildRemediation(code, { grade: 6 }) : undefined;
      for (const u of unique) placed.add(u.learner.id);
      groups.push({
        id: newId('grp'),
        label: `Repair: ${m?.label ?? code}`,
        intent: 'repair_misconception',
        learners: unique.map((u) => ({
          id: u.learner.id, name: u.learner.name, mastery: round(u.mean, 3),
          note: `${code} at ${Math.round((u.misconceptions.find((x) => x.code === code)?.confidence ?? 0) * 100)}% confidence`,
        })),
        meanMastery: round(mean(unique.map((u) => u.mean)), 3),
        whatTheyNeed: m?.description ?? 'A shared faulty rule, not a knowledge gap.',
        doThis: repair
          ? `Run the repair sequence: ${repair.microLesson.steps.slice(0, 2).map((s) => s.title).join(', then ')}. `
            + `Start by making their own rule fail in front of them.`
          : 'Work through the misconception with a concrete contradiction.',
        modality: repair?.microLesson.modality ?? 'manipulative',
        estimatedMinutes: Math.round((repair?.microLesson.estimatedSeconds ?? 300) / 60),
      });
    }

    /* 2. A missing prerequisite is its own group: teaching today's lesson to
          them is wasted time until it is fixed. */
    const gapBuckets = new Map<string, typeof rows>();
    for (const r of rows) {
      if (placed.has(r.learner.id)) continue;
      const trace = this.graph.traceGaps(r.learner.id, conceptIds[0]);
      const root = trace.gapConcepts[0];
      if (!root) continue;
      const list = gapBuckets.get(root.concept.id) ?? [];
      list.push(r);
      gapBuckets.set(root.concept.id, list);
    }
    for (const [rootId, members] of [...gapBuckets.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const unique = members.filter((m) => !placed.has(m.learner.id));
      if (!unique.length) continue;
      const root = this.repos.concepts.get(rootId);
      for (const u of unique) placed.add(u.learner.id);
      groups.push({
        id: newId('grp'),
        label: `Rebuild: ${root?.label ?? rootId}`,
        intent: 'repair_prerequisite',
        learners: unique.map((u) => ({
          id: u.learner.id, name: u.learner.name, mastery: round(u.mean, 3),
          note: `missing ${root?.label ?? 'a prerequisite'}`,
        })),
        meanMastery: round(mean(unique.map((u) => u.mean)), 3),
        whatTheyNeed: `${root?.label ?? 'A prerequisite'} is not secure. Today's lesson sits on top of it.`,
        doThis: `Pull this group aside and rebuild ${root?.label ?? 'the prerequisite'} with a concrete model before `
          + `they attempt the main task. They will not get there otherwise, and they know it.`,
        modality: 'worked_example',
        estimatedMinutes: 15,
      });
    }

    /* 3. Everyone else splits by how far into the concept they already are. */
    const remaining = rows.filter((r) => !placed.has(r.learner.id));
    if (remaining.length) {
      const k = Math.max(1, Math.min(opts.maxGroups ?? 3, Math.ceil(remaining.length / 3)));
      const { assignments } = kmeans(remaining.map((r) => r.vector), k, { seed: classroomId });

      const clusters = new Map<number, typeof remaining>();
      remaining.forEach((r, i) => {
        const list = clusters.get(assignments[i]) ?? [];
        list.push(r);
        clusters.set(assignments[i], list);
      });

      for (const members of [...clusters.values()].sort((a, b) => mean(b.map((x) => x.mean)) - mean(a.map((x) => x.mean)))) {
        const m = mean(members.map((x) => x.mean));
        const intent: GroupPlan['groups'][number]['intent'] =
          m >= 0.8 ? 'extend' : m >= 0.5 ? 'review' : 'teach';
        groups.push({
          id: newId('grp'),
          label: intent === 'extend' ? 'Ready to stretch'
            : intent === 'review' ? 'Nearly there'
            : 'Needs the full explanation',
          intent,
          learners: members.map((u) => ({
            id: u.learner.id, name: u.learner.name, mastery: round(u.mean, 3),
            note: u.learner.needs.length ? `needs: ${u.learner.needs.join(', ')}` : '',
          })),
          meanMastery: round(m, 3),
          whatTheyNeed: intent === 'extend'
            ? 'They have it. Repeating the explanation will bore them into switching off.'
            : intent === 'review'
              ? 'The idea is there but not reliable. They need practice, not re-teaching.'
              : 'They need the concept built from the beginning, concretely.',
          doThis: intent === 'extend'
            ? 'Give them the extension task and let them work independently. Use them as explainers in the last ten minutes.'
            : intent === 'review'
              ? 'Short practice set with immediate feedback. Watch for the common distractor.'
              : 'Teach this group directly with the worked example and a manipulative. This is where your time goes.',
          modality: intent === 'teach' ? 'worked_example' : intent === 'review' ? 'practice' as Modality : 'simulation',
          estimatedMinutes: intent === 'teach' ? 20 : 12,
        });
      }
    }

    const needsSummary = new Map<string, number>();
    for (const r of roster) for (const n of r.needs) needsSummary.set(n, (needsSummary.get(n) ?? 0) + 1);

    const briefing = [
      `${roster.length} students, ${groups.length} group${groups.length === 1 ? '' : 's'} for ${concepts.map((c) => c.label).join(' and ')}.`,
      groups.find((g) => g.intent === 'repair_prerequisite')
        ? `Your time goes to "${groups.find((g) => g.intent === 'repair_prerequisite')!.label}" — that group cannot access today's lesson at all until it is fixed.`
        : groups.find((g) => g.intent === 'teach')
          ? `Your time goes to the direct-teaching group.`
          : `No one is blocked: run this as a whole class and use the extension task for the fast finishers.`,
      needsSummary.size
        ? `Access needs in the room: ${[...needsSummary.entries()].map(([n, c]) => `${n.replace(/_/g, ' ')} (${c})`).join(', ')}.`
        : '',
    ].filter(Boolean).join(' ');

    const wholeClassMisconception = [...byCode.entries()].find(([, members]) => members.length >= roster.length * 0.5);

    return {
      conceptIds,
      conceptLabels: concepts.map((c) => c.label),
      groups,
      unplaced: [],
      teacherBriefing: briefing,
      wholeClassNote: wholeClassMisconception
        ? `Over half the class shows "${this.repos.misconceptions.byCode(wholeClassMisconception[0])?.label}". `
          + `This is worth addressing with the whole class rather than in groups — it is a teaching problem, not a student problem.`
        : undefined,
    };
  }

  /** Class-level mastery heat map across a set of concepts. */
  heatmap(classroomId: string, conceptRefs?: string[]) {
    const roster = this.roster(classroomId);
    const concepts = conceptRefs?.length
      ? conceptRefs.map((r) => this.graph.resolve(r))
      : this.repos.concepts.list({ subject: this.get(classroomId).subject, limit: 25 });

    const cells = roster.map((l) => {
      const lookup = this.graph.masteryLookup(l.id);
      return {
        learnerId: l.id,
        name: l.name,
        needs: l.needs,
        mastery: concepts.map((c) => ({ conceptId: c.id, value: round(lookup(c.id), 3) })),
      };
    });

    const byConcept = concepts.map((c, i) => {
      const values = cells.map((row) => row.mastery[i].value);
      const struggling = values.filter((v) => v < 0.45).length;
      return {
        conceptId: c.id,
        slug: c.slug,
        label: c.label,
        mean: round(mean(values), 3),
        struggling,
        mastered: values.filter((v) => v >= 0.8).length,
        /** The concept most worth a whole-class reteach. */
        priority: round(struggling / Math.max(1, roster.length), 3),
      };
    }).sort((a, b) => b.priority - a.priority);

    return {
      classroom: this.get(classroomId),
      learners: cells,
      concepts: byConcept,
      recommendation: byConcept[0] && byConcept[0].priority > 0.4
        ? `${byConcept[0].struggling} of ${roster.length} students are below threshold on "${byConcept[0].label}". `
          + `That is a whole-class problem, not a group one.`
        : 'No concept is failing across the class. Group work is the right move.',
    };
  }

  /** Who needs attention first, and why. */
  atRisk(classroomId: string) {
    const roster = this.roster(classroomId);
    return roster.map((l) => {
      const snap = this.twin.snapshot(l.id);
      const signals: string[] = [];
      if (snap.mastery.strugglingCount >= 3) signals.push(`${snap.mastery.strugglingCount} concepts below threshold`);
      if (snap.misconceptions.length) signals.push(`${snap.misconceptions.length} active misconception(s)`);
      if (snap.load.load > 0.75) signals.push(`high cognitive load (${snap.load.load})`);
      if (snap.friction.intervene) signals.push(`friction: ${snap.friction.signals.map((s) => s.kind).join(', ')}`);
      if (snap.activity.last7Days === 0) signals.push('no activity in the last week');
      if (snap.errorPatterns.patterns.some((p) => p.verdict === 'confirmed')) {
        signals.push(`confirmed pattern: ${snap.errorPatterns.patterns[0].label}`);
      }
      return {
        learnerId: l.id,
        name: l.name,
        needs: l.needs,
        overallMastery: snap.mastery.overall,
        riskScore: round(Math.min(1, signals.length / 4), 3),
        signals,
        suggestedAction: signals.length === 0
          ? 'On track. No action needed.'
          : snap.misconceptions.length
            ? `Start with the misconception: ${snap.misconceptions[0].label}.`
            : snap.mastery.strugglingCount >= 3
              ? 'Trace the prerequisites before reteaching anything.'
              : 'Check in. Something is interfering that the scores alone do not explain.',
      };
    }).sort((a, b) => b.riskScore - a.riskScore);
  }
}
