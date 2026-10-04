import { Db, Row, parseJson, bool, numOr, strOr } from './sqlite.js';
import { id as newId } from '../core/ids.js';
import { notFound } from '../core/errors.js';
import type {
  Concept, ConceptEdge, ConceptExample, EdgeKind, ItemRecord, Learner, LearnerProfile,
  LessonBody, LessonRecord, MasteryRecord, Misconception, Modality, ModalityArm,
  RemediationPlan, ResponseRecord, SessionRecord, Subject, Term, PlanStep, Bloom, AccessNeed,
} from '../domain/types.js';

const now = () => new Date().toISOString();

/* ================================ mappers ================================= */

const toConcept = (r: Row): Concept => ({
  id: strOr(r.id), slug: strOr(r.slug), label: strOr(r.label), description: strOr(r.description),
  subject: strOr(r.subject, 'general') as Subject,
  gradeMin: numOr(r.grade_min, 1), gradeMax: numOr(r.grade_max, 12),
  difficulty: numOr(r.difficulty, 0.5), bloom: strOr(r.bloom, 'understand') as Bloom,
  tags: parseJson<string[]>(r.tags, []), standards: parseJson<string[]>(r.standards, []),
  documentId: (r.document_id as string) ?? null,
  meta: parseJson<Record<string, unknown>>(r.meta, {}), createdAt: strOr(r.created_at),
});

const toEdge = (r: Row): ConceptEdge => ({
  id: strOr(r.id), from: strOr(r.from_id), to: strOr(r.to_id),
  kind: strOr(r.kind, 'related') as EdgeKind, weight: numOr(r.weight, 1),
  rationale: (r.rationale as string) ?? null,
});

const toLearner = (r: Row): Learner => ({
  id: strOr(r.id), name: strOr(r.name), grade: numOr(r.grade, 6), locale: strOr(r.locale, 'en'),
  readingLevel: numOr(r.reading_level, numOr(r.grade, 6)),
  needs: parseJson<AccessNeed[]>(r.needs, []),
  ability: numOr(r.ability, 0), abilitySe: numOr(r.ability_se, 1),
  profile: parseJson<LearnerProfile>(r.profile, {}),
  createdAt: strOr(r.created_at), updatedAt: strOr(r.updated_at),
});

const toMastery = (r: Row): MasteryRecord => ({
  learnerId: strOr(r.learner_id), conceptId: strOr(r.concept_id),
  pKnown: numOr(r.p_known, 0.15), elo: numOr(r.elo, 1200),
  attempts: numOr(r.attempts), correct: numOr(r.correct), streak: numOr(r.streak),
  stability: numOr(r.stability), fsrsDifficulty: numOr(r.fsrs_difficulty, 5),
  reps: numOr(r.reps), lapses: numOr(r.lapses),
  lastSeen: (r.last_seen as string) ?? null, dueAt: (r.due_at as string) ?? null,
  firstMasteredAt: (r.first_mastered_at as string) ?? null,
});

const toItem = (r: Row): ItemRecord => ({
  id: strOr(r.id), conceptId: strOr(r.concept_id), kind: strOr(r.kind, 'mcq') as ItemRecord['kind'],
  stem: strOr(r.stem), choices: parseJson<ItemRecord['choices']>(r.choices, []),
  answer: parseJson<ItemRecord['answer']>(r.answer, { value: null }),
  rubric: parseJson<Record<string, unknown>>(r.rubric, {}),
  difficulty: numOr(r.difficulty), discrimination: numOr(r.discrimination, 1), guessing: numOr(r.guessing, 0),
  misconceptionMap: parseJson<Record<string, string>>(r.misconception_map, {}),
  bloom: strOr(r.bloom, 'apply') as Bloom, exposures: numOr(r.exposures),
  pCorrect: r.p_correct === null || r.p_correct === undefined ? null : numOr(r.p_correct),
  accessibility: parseJson<Record<string, unknown>>(r.accessibility, {}),
  meta: parseJson<Record<string, unknown>>(r.meta, {}), createdAt: strOr(r.created_at),
});

const toResponse = (r: Row): ResponseRecord => ({
  id: strOr(r.id), learnerId: strOr(r.learner_id), itemId: (r.item_id as string) ?? null,
  conceptId: (r.concept_id as string) ?? null, sessionId: (r.session_id as string) ?? null,
  raw: strOr(r.raw), correct: bool(r.correct), score: numOr(r.score), latencyMs: numOr(r.latency_ms),
  hintsUsed: numOr(r.hints_used), attempts: numOr(r.attempts, 1),
  misconceptionId: (r.misconception_id as string) ?? null,
  modality: (r.modality as Modality) ?? null,
  feedback: parseJson<Record<string, unknown>>(r.feedback, {}), at: strOr(r.at),
});

const toLesson = (r: Row): LessonRecord => ({
  id: strOr(r.id), conceptId: strOr(r.concept_id), learnerId: (r.learner_id as string) ?? null,
  modality: strOr(r.modality, 'text') as Modality, strategy: strOr(r.strategy, 'direct'),
  title: strOr(r.title), grade: numOr(r.grade, 6),
  body: parseJson<LessonBody>(r.body, { hook: '', objective: '', segments: [], keyTerms: [], checkpoints: [], summary: '' }),
  accessibility: parseJson<Record<string, unknown>>(r.accessibility, {}),
  verification: parseJson<Record<string, unknown>>(r.verification, {}),
  provenance: parseJson<Record<string, unknown>>(r.provenance, {}),
  version: numOr(r.version, 1), createdAt: strOr(r.created_at),
});

const toSession = (r: Row): SessionRecord => ({
  id: strOr(r.id), learnerId: strOr(r.learner_id), goalConceptId: (r.goal_concept_id as string) ?? null,
  status: strOr(r.status, 'active') as SessionRecord['status'],
  plan: parseJson<PlanStep[]>(r.plan, []), state: parseJson<Record<string, unknown>>(r.state, {}),
  metrics: parseJson<Record<string, number>>(r.metrics, {}), step: numOr(r.step),
  startedAt: strOr(r.started_at), endedAt: (r.ended_at as string) ?? null,
  endReason: (r.end_reason as string) ?? null,
});

const toMisconception = (r: Row): Misconception => ({
  id: strOr(r.id), conceptId: (r.concept_id as string) ?? null, code: strOr(r.code),
  label: strOr(r.label), description: strOr(r.description), subject: strOr(r.subject, 'general') as Subject,
  severity: strOr(r.severity, 'moderate') as Misconception['severity'],
  detector: strOr(r.detector, 'llm') as Misconception['detector'],
  signature: parseJson<Record<string, unknown>>(r.signature, {}),
  remediation: parseJson<RemediationPlan>(r.remediation, { strategy: 'reteach', steps: [], modality: 'worked_example' }),
});

/* ============================== repositories ============================== */

export class ConceptRepo {
  constructor(private db: Db) {}

  create(input: Partial<Concept> & { label: string }): Concept {
    const slug = input.slug ?? input.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const existing = this.bySlug(slug);
    if (existing) return existing;
    const c: Concept = {
      id: input.id ?? newId('cpt'), slug, label: input.label, description: input.description ?? '',
      subject: input.subject ?? 'general', gradeMin: input.gradeMin ?? 1, gradeMax: input.gradeMax ?? 12,
      difficulty: input.difficulty ?? 0.5, bloom: input.bloom ?? 'understand',
      tags: input.tags ?? [], standards: input.standards ?? [], documentId: input.documentId ?? null,
      meta: input.meta ?? {}, createdAt: now(),
    };
    this.db.insert('concepts', {
      id: c.id, slug: c.slug, label: c.label, description: c.description, subject: c.subject,
      grade_min: c.gradeMin, grade_max: c.gradeMax, difficulty: c.difficulty, bloom: c.bloom,
      tags: c.tags, standards: c.standards, document_id: c.documentId, meta: c.meta, created_at: c.createdAt,
    });
    return c;
  }

  get(id: string): Concept | undefined {
    const r = this.db.one('SELECT * FROM concepts WHERE id=?', [id]);
    return r ? toConcept(r) : undefined;
  }
  require(id: string): Concept {
    const c = this.get(id);
    if (!c) throw notFound('concept', id);
    return c;
  }
  bySlug(slug: string): Concept | undefined {
    const r = this.db.one('SELECT * FROM concepts WHERE slug=?', [slug]);
    return r ? toConcept(r) : undefined;
  }
  all(): Concept[] { return this.db.all('SELECT * FROM concepts ORDER BY subject, grade_min, label').map(toConcept); }
  list(filter: { subject?: string; grade?: number; q?: string; limit?: number; offset?: number } = {}): Concept[] {
    const where: string[] = [];
    const p: unknown[] = [];
    if (filter.subject) { where.push('subject=?'); p.push(filter.subject); }
    if (filter.grade !== undefined) { where.push('grade_min<=? AND grade_max>=?'); p.push(filter.grade, filter.grade); }
    if (filter.q) { where.push('(label LIKE ? OR description LIKE ? OR slug LIKE ?)'); p.push(`%${filter.q}%`, `%${filter.q}%`, `%${filter.q}%`); }
    p.push(filter.limit ?? 100, filter.offset ?? 0);
    return this.db.all(
      `SELECT * FROM concepts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY subject, grade_min, label LIMIT ? OFFSET ?`, p,
    ).map(toConcept);
  }
  update(id: string, patch: Partial<Concept>): Concept {
    const c = this.require(id);
    const merged = { ...c, ...patch };
    this.db.run(
      `UPDATE concepts SET label=?, description=?, subject=?, grade_min=?, grade_max=?, difficulty=?, bloom=?, tags=?, standards=?, meta=? WHERE id=?`,
      [merged.label, merged.description, merged.subject, merged.gradeMin, merged.gradeMax,
        merged.difficulty, merged.bloom, JSON.stringify(merged.tags), JSON.stringify(merged.standards),
        JSON.stringify(merged.meta), id],
    );
    return merged;
  }
  delete(id: string): boolean { return this.db.run('DELETE FROM concepts WHERE id=?', [id]).changes > 0; }
  count(): number { return this.db.count('SELECT COUNT(*) FROM concepts'); }
}

export class EdgeRepo {
  constructor(private db: Db) {}

  link(from: string, to: string, kind: EdgeKind, weight = 1, rationale?: string): ConceptEdge {
    const e: ConceptEdge = { id: newId('edg'), from, to, kind, weight, rationale: rationale ?? null };
    this.db.upsert('concept_edges', ['from_id', 'to_id', 'kind'], {
      id: e.id, from_id: from, to_id: to, kind, weight, rationale: rationale ?? null, created_at: now(),
    });
    const r = this.db.one('SELECT * FROM concept_edges WHERE from_id=? AND to_id=? AND kind=?', [from, to, kind]);
    return r ? toEdge(r) : e;
  }
  all(): ConceptEdge[] { return this.db.all('SELECT * FROM concept_edges').map(toEdge); }
  outgoing(from: string, kind?: EdgeKind): ConceptEdge[] {
    return (kind
      ? this.db.all('SELECT * FROM concept_edges WHERE from_id=? AND kind=?', [from, kind])
      : this.db.all('SELECT * FROM concept_edges WHERE from_id=?', [from])).map(toEdge);
  }
  incoming(to: string, kind?: EdgeKind): ConceptEdge[] {
    return (kind
      ? this.db.all('SELECT * FROM concept_edges WHERE to_id=? AND kind=?', [to, kind])
      : this.db.all('SELECT * FROM concept_edges WHERE to_id=?', [to])).map(toEdge);
  }
  unlink(from: string, to: string, kind?: EdgeKind): number {
    return kind
      ? this.db.run('DELETE FROM concept_edges WHERE from_id=? AND to_id=? AND kind=?', [from, to, kind]).changes
      : this.db.run('DELETE FROM concept_edges WHERE from_id=? AND to_id=?', [from, to]).changes;
  }
  count(): number { return this.db.count('SELECT COUNT(*) FROM concept_edges'); }
}

export class TermRepo {
  constructor(private db: Db) {}
  put(conceptId: string, t: Omit<Term, 'id' | 'conceptId'>): void {
    this.db.upsert('concept_terms', ['concept_id', 'term'], {
      id: newId('trm'), concept_id: conceptId, term: t.term, definition: t.definition,
      kid_definition: t.kidDefinition, syllables: t.syllables, importance: t.importance,
    });
  }
  forConcept(conceptId: string): Term[] {
    return this.db.all('SELECT * FROM concept_terms WHERE concept_id=? ORDER BY importance DESC', [conceptId])
      .map((r) => ({
        id: strOr(r.id), conceptId: strOr(r.concept_id), term: strOr(r.term),
        definition: strOr(r.definition), kidDefinition: strOr(r.kid_definition),
        syllables: strOr(r.syllables), importance: numOr(r.importance, 0.5),
      }));
  }
  search(q: string, limit = 20): Term[] {
    return this.db.all('SELECT * FROM concept_terms WHERE term LIKE ? LIMIT ?', [`%${q}%`, limit])
      .map((r) => ({
        id: strOr(r.id), conceptId: strOr(r.concept_id), term: strOr(r.term),
        definition: strOr(r.definition), kidDefinition: strOr(r.kid_definition),
        syllables: strOr(r.syllables), importance: numOr(r.importance, 0.5),
      }));
  }
}

export class ExampleRepo {
  constructor(private db: Db) {}
  add(e: Omit<ConceptExample, 'id'>): ConceptExample {
    const rec = { ...e, id: newId('exm') };
    this.db.insert('concept_examples', {
      id: rec.id, concept_id: rec.conceptId, kind: rec.kind, title: rec.title,
      body: rec.body, quality: rec.quality,
    });
    return rec;
  }
  forConcept(conceptId: string, kind?: string): ConceptExample[] {
    const rows = kind
      ? this.db.all('SELECT * FROM concept_examples WHERE concept_id=? AND kind=? ORDER BY quality DESC', [conceptId, kind])
      : this.db.all('SELECT * FROM concept_examples WHERE concept_id=? ORDER BY quality DESC', [conceptId]);
    return rows.map((r) => ({
      id: strOr(r.id), conceptId: strOr(r.concept_id), kind: strOr(r.kind, 'worked') as ConceptExample['kind'],
      title: strOr(r.title), body: parseJson<Record<string, unknown>>(r.body, {}), quality: numOr(r.quality, 0.5),
    }));
  }
}

export class MisconceptionRepo {
  constructor(private db: Db) {}
  upsert(m: Omit<Misconception, 'id'> & { id?: string }): Misconception {
    const rec: Misconception = { ...m, id: m.id ?? newId('msc') };
    this.db.upsert('misconceptions', ['code'], {
      id: rec.id, concept_id: rec.conceptId ?? null, code: rec.code, label: rec.label,
      description: rec.description, subject: rec.subject, severity: rec.severity,
      detector: rec.detector, signature: rec.signature, remediation: rec.remediation, created_at: now(),
    });
    return this.byCode(rec.code) ?? rec;
  }
  byCode(code: string): Misconception | undefined {
    const r = this.db.one('SELECT * FROM misconceptions WHERE code=?', [code]);
    return r ? toMisconception(r) : undefined;
  }
  get(id: string): Misconception | undefined {
    const r = this.db.one('SELECT * FROM misconceptions WHERE id=?', [id]);
    return r ? toMisconception(r) : undefined;
  }
  all(subject?: string): Misconception[] {
    return (subject
      ? this.db.all('SELECT * FROM misconceptions WHERE subject=? ORDER BY code', [subject])
      : this.db.all('SELECT * FROM misconceptions ORDER BY code')).map(toMisconception);
  }
  forConcept(conceptId: string): Misconception[] {
    return this.db.all('SELECT * FROM misconceptions WHERE concept_id=?', [conceptId]).map(toMisconception);
  }
}

export class LearnerRepo {
  constructor(private db: Db) {}

  create(input: Partial<Learner> & { name: string }): Learner {
    const l: Learner = {
      id: input.id ?? newId('lrn'), name: input.name, grade: input.grade ?? 6,
      locale: input.locale ?? 'en', readingLevel: input.readingLevel ?? (input.grade ?? 6),
      needs: input.needs ?? [], ability: input.ability ?? 0, abilitySe: input.abilitySe ?? 1,
      profile: input.profile ?? {}, createdAt: now(), updatedAt: now(),
    };
    this.db.insert('learners', {
      id: l.id, name: l.name, grade: l.grade, locale: l.locale, reading_level: l.readingLevel,
      needs: l.needs, profile: l.profile, ability: l.ability, ability_se: l.abilitySe,
      created_at: l.createdAt, updated_at: l.updatedAt,
    });
    return l;
  }
  get(id: string): Learner | undefined {
    const r = this.db.one('SELECT * FROM learners WHERE id=?', [id]);
    return r ? toLearner(r) : undefined;
  }
  require(id: string): Learner {
    const l = this.get(id);
    if (!l) throw notFound('learner', id);
    return l;
  }
  list(limit = 100, offset = 0): Learner[] {
    return this.db.all('SELECT * FROM learners ORDER BY created_at DESC LIMIT ? OFFSET ?', [limit, offset]).map(toLearner);
  }
  update(id: string, patch: Partial<Learner>): Learner {
    const l = this.require(id);
    const m = { ...l, ...patch, profile: { ...l.profile, ...(patch.profile ?? {}) }, updatedAt: now() };
    this.db.run(
      `UPDATE learners SET name=?, grade=?, locale=?, reading_level=?, needs=?, profile=?, ability=?, ability_se=?, updated_at=? WHERE id=?`,
      [m.name, m.grade, m.locale, m.readingLevel, JSON.stringify(m.needs), JSON.stringify(m.profile),
        m.ability, m.abilitySe, m.updatedAt, id],
    );
    return m;
  }
  delete(id: string): boolean { return this.db.run('DELETE FROM learners WHERE id=?', [id]).changes > 0; }
  count(): number { return this.db.count('SELECT COUNT(*) FROM learners'); }
}

export class MasteryRepo {
  constructor(private db: Db) {}

  get(learnerId: string, conceptId: string): MasteryRecord | undefined {
    const r = this.db.one('SELECT * FROM learner_mastery WHERE learner_id=? AND concept_id=?', [learnerId, conceptId]);
    return r ? toMastery(r) : undefined;
  }
  getOrInit(learnerId: string, conceptId: string, prior = 0.15): MasteryRecord {
    const existing = this.get(learnerId, conceptId);
    if (existing) return existing;
    const rec: MasteryRecord = {
      learnerId, conceptId, pKnown: prior, elo: 1200, attempts: 0, correct: 0, streak: 0,
      stability: 0, fsrsDifficulty: 5, reps: 0, lapses: 0, lastSeen: null, dueAt: null, firstMasteredAt: null,
    };
    this.save(rec);
    return rec;
  }
  save(m: MasteryRecord): void {
    this.db.upsert('learner_mastery', ['learner_id', 'concept_id'], {
      learner_id: m.learnerId, concept_id: m.conceptId, p_known: m.pKnown, elo: m.elo,
      attempts: m.attempts, correct: m.correct, streak: m.streak, stability: m.stability,
      fsrs_difficulty: m.fsrsDifficulty, reps: m.reps, lapses: m.lapses,
      last_seen: m.lastSeen, due_at: m.dueAt, first_mastered_at: m.firstMasteredAt,
    });
  }
  forLearner(learnerId: string): MasteryRecord[] {
    return this.db.all('SELECT * FROM learner_mastery WHERE learner_id=?', [learnerId]).map(toMastery);
  }
  dueFor(learnerId: string, atIso = now(), limit = 20): MasteryRecord[] {
    return this.db.all(
      'SELECT * FROM learner_mastery WHERE learner_id=? AND due_at IS NOT NULL AND due_at<=? ORDER BY due_at LIMIT ?',
      [learnerId, atIso, limit],
    ).map(toMastery);
  }
  forConcept(conceptId: string): MasteryRecord[] {
    return this.db.all('SELECT * FROM learner_mastery WHERE concept_id=?', [conceptId]).map(toMastery);
  }
  weakest(learnerId: string, limit = 5): MasteryRecord[] {
    return this.db.all(
      'SELECT * FROM learner_mastery WHERE learner_id=? AND attempts>0 ORDER BY p_known ASC LIMIT ?',
      [learnerId, limit],
    ).map(toMastery);
  }
}

export class ModalityRepo {
  constructor(private db: Db) {}
  get(learnerId: string, modality: Modality): ModalityArm | undefined {
    const r = this.db.one('SELECT * FROM learner_modality WHERE learner_id=? AND modality=?', [learnerId, modality]);
    return r ? {
      learnerId: strOr(r.learner_id), modality: strOr(r.modality) as Modality,
      alpha: numOr(r.alpha, 1), beta: numOr(r.beta, 1), trials: numOr(r.trials),
      rewardSum: numOr(r.reward_sum), lastAt: (r.last_at as string) ?? null,
    } : undefined;
  }
  forLearner(learnerId: string): ModalityArm[] {
    return this.db.all('SELECT * FROM learner_modality WHERE learner_id=?', [learnerId]).map((r) => ({
      learnerId: strOr(r.learner_id), modality: strOr(r.modality) as Modality,
      alpha: numOr(r.alpha, 1), beta: numOr(r.beta, 1), trials: numOr(r.trials),
      rewardSum: numOr(r.reward_sum), lastAt: (r.last_at as string) ?? null,
    }));
  }
  save(a: ModalityArm): void {
    this.db.upsert('learner_modality', ['learner_id', 'modality'], {
      learner_id: a.learnerId, modality: a.modality, alpha: a.alpha, beta: a.beta,
      trials: a.trials, reward_sum: a.rewardSum, last_at: a.lastAt ?? now(),
    });
  }
}

export class ItemRepo {
  constructor(private db: Db) {}
  create(i: Omit<ItemRecord, 'id' | 'createdAt' | 'exposures'> & { id?: string }): ItemRecord {
    const rec: ItemRecord = { ...i, id: i.id ?? newId('itm'), exposures: 0, createdAt: now() };
    this.db.insert('items', {
      id: rec.id, concept_id: rec.conceptId, kind: rec.kind, stem: rec.stem, choices: rec.choices,
      answer: rec.answer, rubric: rec.rubric, difficulty: rec.difficulty, discrimination: rec.discrimination,
      guessing: rec.guessing, misconception_map: rec.misconceptionMap, bloom: rec.bloom,
      exposures: 0, p_correct: rec.pCorrect ?? null, accessibility: rec.accessibility,
      meta: rec.meta, created_at: rec.createdAt,
    });
    return rec;
  }
  get(id: string): ItemRecord | undefined {
    const r = this.db.one('SELECT * FROM items WHERE id=?', [id]);
    return r ? toItem(r) : undefined;
  }
  require(id: string): ItemRecord {
    const i = this.get(id);
    if (!i) throw notFound('item', id);
    return i;
  }
  forConcept(conceptId: string, limit = 50): ItemRecord[] {
    return this.db.all('SELECT * FROM items WHERE concept_id=? ORDER BY difficulty LIMIT ?', [conceptId, limit]).map(toItem);
  }
  bank(conceptIds: string[], limit = 200): ItemRecord[] {
    if (!conceptIds.length) return [];
    const marks = conceptIds.map(() => '?').join(',');
    return this.db.all(`SELECT * FROM items WHERE concept_id IN (${marks}) LIMIT ?`, [...conceptIds, limit]).map(toItem);
  }
  recordExposure(id: string, correct: boolean): void {
    this.db.run(
      `UPDATE items SET exposures = exposures + 1,
         p_correct = CASE WHEN p_correct IS NULL THEN ? ELSE (p_correct * exposures + ?) / (exposures + 1) END
       WHERE id=?`,
      [correct ? 1 : 0, correct ? 1 : 0, id],
    );
  }
  updateCalibration(id: string, difficulty: number, discrimination: number): void {
    this.db.run('UPDATE items SET difficulty=?, discrimination=? WHERE id=?', [difficulty, discrimination, id]);
  }
  count(): number { return this.db.count('SELECT COUNT(*) FROM items'); }
}

export class ResponseRepo {
  constructor(private db: Db) {}
  add(r: Omit<ResponseRecord, 'id' | 'at'> & { id?: string; at?: string }): ResponseRecord {
    const rec: ResponseRecord = { ...r, id: r.id ?? newId('rsp'), at: r.at ?? now() };
    this.db.insert('responses', {
      id: rec.id, learner_id: rec.learnerId, item_id: rec.itemId, concept_id: rec.conceptId,
      session_id: rec.sessionId, raw: rec.raw, correct: rec.correct ? 1 : 0, score: rec.score,
      latency_ms: rec.latencyMs, hints_used: rec.hintsUsed, attempts: rec.attempts,
      misconception_id: rec.misconceptionId, modality: rec.modality, feedback: rec.feedback, at: rec.at,
    });
    return rec;
  }
  forLearner(learnerId: string, limit = 100): ResponseRecord[] {
    return this.db.all('SELECT * FROM responses WHERE learner_id=? ORDER BY at DESC LIMIT ?', [learnerId, limit]).map(toResponse);
  }
  forLearnerConcept(learnerId: string, conceptId: string, limit = 50): ResponseRecord[] {
    return this.db.all(
      'SELECT * FROM responses WHERE learner_id=? AND concept_id=? ORDER BY at DESC LIMIT ?',
      [learnerId, conceptId, limit],
    ).map(toResponse);
  }
  forItem(itemId: string, limit = 500): ResponseRecord[] {
    return this.db.all('SELECT * FROM responses WHERE item_id=? ORDER BY at DESC LIMIT ?', [itemId, limit]).map(toResponse);
  }
  forSession(sessionId: string): ResponseRecord[] {
    return this.db.all('SELECT * FROM responses WHERE session_id=? ORDER BY at', [sessionId]).map(toResponse);
  }
  count(): number { return this.db.count('SELECT COUNT(*) FROM responses'); }
}

export class LessonRepo {
  constructor(private db: Db) {}
  create(l: Omit<LessonRecord, 'id' | 'createdAt'> & { id?: string }): LessonRecord {
    const rec: LessonRecord = { ...l, id: l.id ?? newId('lsn'), createdAt: now() };
    this.db.insert('lessons', {
      id: rec.id, concept_id: rec.conceptId, learner_id: rec.learnerId, modality: rec.modality,
      strategy: rec.strategy, title: rec.title, grade: rec.grade, body: rec.body,
      accessibility: rec.accessibility, verification: rec.verification, provenance: rec.provenance,
      version: rec.version, created_at: rec.createdAt,
    });
    return rec;
  }
  get(id: string): LessonRecord | undefined {
    const r = this.db.one('SELECT * FROM lessons WHERE id=?', [id]);
    return r ? toLesson(r) : undefined;
  }
  require(id: string): LessonRecord {
    const l = this.get(id);
    if (!l) throw notFound('lesson', id);
    return l;
  }
  find(conceptId: string, modality?: Modality, grade?: number): LessonRecord | undefined {
    const where = ['concept_id=?'];
    const p: unknown[] = [conceptId];
    if (modality) { where.push('modality=?'); p.push(modality); }
    if (grade !== undefined) { where.push('ABS(grade-?)<=1'); p.push(grade); }
    const r = this.db.one(`SELECT * FROM lessons WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 1`, p);
    return r ? toLesson(r) : undefined;
  }
  forConcept(conceptId: string): LessonRecord[] {
    return this.db.all('SELECT * FROM lessons WHERE concept_id=? ORDER BY created_at DESC', [conceptId]).map(toLesson);
  }
  setVerification(id: string, verification: Record<string, unknown>): void {
    this.db.run('UPDATE lessons SET verification=? WHERE id=?', [JSON.stringify(verification), id]);
  }
  count(): number { return this.db.count('SELECT COUNT(*) FROM lessons'); }
}

export class SessionRepo {
  constructor(private db: Db) {}
  create(s: Omit<SessionRecord, 'id' | 'startedAt'> & { id?: string }): SessionRecord {
    const rec: SessionRecord = { ...s, id: s.id ?? newId('ses'), startedAt: now() };
    this.db.insert('sessions', {
      id: rec.id, learner_id: rec.learnerId, goal_concept_id: rec.goalConceptId, status: rec.status,
      plan: rec.plan, state: rec.state, metrics: rec.metrics, step: rec.step, started_at: rec.startedAt,
    });
    return rec;
  }
  get(id: string): SessionRecord | undefined {
    const r = this.db.one('SELECT * FROM sessions WHERE id=?', [id]);
    return r ? toSession(r) : undefined;
  }
  require(id: string): SessionRecord {
    const s = this.get(id);
    if (!s) throw notFound('session', id);
    return s;
  }
  save(s: SessionRecord): void {
    this.db.run(
      `UPDATE sessions SET status=?, plan=?, state=?, metrics=?, step=?, ended_at=?, end_reason=? WHERE id=?`,
      [s.status, JSON.stringify(s.plan), JSON.stringify(s.state), JSON.stringify(s.metrics),
        s.step, s.endedAt ?? null, s.endReason ?? null, s.id],
    );
  }
  activeFor(learnerId: string): SessionRecord | undefined {
    const r = this.db.one(
      "SELECT * FROM sessions WHERE learner_id=? AND status='active' ORDER BY started_at DESC LIMIT 1", [learnerId],
    );
    return r ? toSession(r) : undefined;
  }
  forLearner(learnerId: string, limit = 20): SessionRecord[] {
    return this.db.all('SELECT * FROM sessions WHERE learner_id=? ORDER BY started_at DESC LIMIT ?', [learnerId, limit]).map(toSession);
  }
}

export interface Repos {
  db: Db;
  concepts: ConceptRepo;
  edges: EdgeRepo;
  terms: TermRepo;
  examples: ExampleRepo;
  misconceptions: MisconceptionRepo;
  learners: LearnerRepo;
  mastery: MasteryRepo;
  modality: ModalityRepo;
  items: ItemRepo;
  responses: ResponseRepo;
  lessons: LessonRepo;
  sessions: SessionRepo;
}

export function makeRepos(db: Db): Repos {
  return {
    db,
    concepts: new ConceptRepo(db),
    edges: new EdgeRepo(db),
    terms: new TermRepo(db),
    examples: new ExampleRepo(db),
    misconceptions: new MisconceptionRepo(db),
    learners: new LearnerRepo(db),
    mastery: new MasteryRepo(db),
    modality: new ModalityRepo(db),
    items: new ItemRepo(db),
    responses: new ResponseRepo(db),
    lessons: new LessonRepo(db),
    sessions: new SessionRepo(db),
  };
}
