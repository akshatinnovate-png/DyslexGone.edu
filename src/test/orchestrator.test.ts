import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decide, type PolicyInput } from '../orchestrator/policy.js';
import { SessionEngine } from '../orchestrator/session.js';
import { AssessmentService } from '../assessment/service.js';
import { generateItems } from '../assessment/itemgen.js';
import { grade, scoreSelfExplanation } from '../assessment/grading.js';
import { memoryDb } from '../db/sqlite.js';
import { makeRepos } from '../db/repos.js';
import { GraphService, seedCurriculum } from '../graph/service.js';
import { TwinService } from '../twin/service.js';
import { MisconceptionEngine } from '../misconception/engine.js';
import { VisualEngine } from '../engines/visual.engine.js';
import { router } from '../llm/router.js';
import type { ItemRecord } from '../domain/types.js';

const basePolicy = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  mastery: [],
  load: { load: 0.3, contributors: { intrinsic: 0.3 }, recommendation: 'continue', confidence: 0.6 },
  friction: { score: 0.1, signals: [], intervene: false, action: 'none', message: 'fine' },
  activeMisconceptions: [],
  frontier: [],
  recovery: [],
  dueForReview: [],
  sessionConceptIds: [],
  deliveryCounts: {},
  answeredConceptIds: [],
  triedModalities: [],
  sessionSeconds: 60,
  itemsDelivered: 2,
  masteryThreshold: 0.8,
  loadCeiling: 0.78,
  conceptLabel: (id) => id,
  ...over,
});

describe('adaptive policy', () => {
  test('overload beats everything else', () => {
    const d = decide(basePolicy({
      load: { load: 0.95, contributors: { errors: 0.5, fatigue: 0.3 }, recommendation: 'break', confidence: 0.8 },
      activeMisconceptions: [{ code: 'X', confidence: 1, severity: 'critical', label: 'bad', conceptId: 'c1' }],
      frontier: [{ conceptId: 'c2', concept: { label: 'Next', difficulty: 0.4 }, readiness: 0.9, unlocks: 3 }],
    }));
    assert.equal(d.chosen.kind, 'break');
    assert.match(d.chosen.reason, /load/i);
  });

  test('a misconception outranks teaching something new', () => {
    const d = decide(basePolicy({
      activeMisconceptions: [{ code: 'FRAC_ADD_CROSS', confidence: 0.9, severity: 'critical', label: 'cross-adds', conceptId: 'c1' }],
      frontier: [{ conceptId: 'c2', concept: { label: 'Next', difficulty: 0.4 }, readiness: 0.95, unlocks: 5 }],
    }));
    assert.equal(d.chosen.kind, 'repair_misconception');
    assert.equal(d.chosen.misconceptionCode, 'FRAC_ADD_CROSS');
  });

  test('a prerequisite gap outranks teaching the goal', () => {
    const d = decide(basePolicy({
      gapTrace: {
        target: 'goal', ready: false, gaps: [], route: [], explanation: '',
        gapConcepts: [{ concept: { id: 'root', label: 'Division' }, mastery: 0.3, depth: 2 }],
      },
      goalConceptId: 'goal',
      frontier: [{ conceptId: 'c2', concept: { label: 'Next', difficulty: 0.4 }, readiness: 0.9, unlocks: 3 }],
    }));
    assert.equal(d.chosen.kind, 'repair_prerequisite');
    assert.equal(d.chosen.conceptId, 'root');
  });

  test('re-teaching the same concept escalates to a different representation', () => {
    const gapTrace = {
      target: 'goal', ready: false, gaps: [], route: [], explanation: '',
      gapConcepts: [{ concept: { id: 'root', label: 'Division' }, mastery: 0.3, depth: 1 }],
    };
    const first = decide(basePolicy({ gapTrace }));
    assert.equal(first.chosen.kind, 'repair_prerequisite');

    const second = decide(basePolicy({ gapTrace, deliveryCounts: { root: 1 }, answeredConceptIds: ['root'] }));
    assert.equal(second.chosen.kind, 'switch_modality');
    assert.match(second.chosen.reason, /different representation/i);
  });

  test('a concept explained twice with no answer is abandoned, not explained a third time', () => {
    const gapTrace = {
      target: 'goal', ready: false, gaps: [], route: [], explanation: '',
      gapConcepts: [{ concept: { id: 'root', label: 'Division' }, mastery: 0.3, depth: 1 }],
    };
    const d = decide(basePolicy({
      gapTrace,
      deliveryCounts: { root: 2 },
      answeredConceptIds: [],
      frontier: [{ conceptId: 'other', concept: { label: 'Other', difficulty: 0.3 }, readiness: 0.8, unlocks: 2 }],
    }));
    assert.notEqual(d.chosen.conceptId, 'root');
  });

  test('breaks are not offered endlessly', () => {
    const overloaded = {
      load: { load: 0.95, contributors: { errors: 0.6 }, recommendation: 'break' as const, confidence: 0.9 },
      frontier: [{ conceptId: 'c', concept: { label: 'C', difficulty: 0.3 }, readiness: 0.8, unlocks: 1 }],
    };
    assert.equal(decide(basePolicy(overloaded)).chosen.kind, 'break');
    assert.notEqual(decide(basePolicy({ ...overloaded, deliveryCounts: { __break__: 3 } })).chosen.kind, 'break');
  });

  test('decayed knowledge is refreshed before new material', () => {
    const d = decide(basePolicy({
      recovery: [{ conceptId: 'old', retention: 0.3, daysSince: 60, urgency: 0.9, refresherSeconds: 60, reason: 'faded' }],
      frontier: [{ conceptId: 'new', concept: { label: 'New', difficulty: 0.4 }, readiness: 0.85, unlocks: 2 }],
    }));
    assert.equal(d.chosen.kind, 'refresh_decayed');
  });

  test('with nothing known, it diagnoses rather than guessing', () => {
    const d = decide(basePolicy({ itemsDelivered: 0 }));
    assert.equal(d.chosen.kind, 'diagnose');
  });

  test('every decision explains itself and names what it rejected', () => {
    const d = decide(basePolicy({
      activeMisconceptions: [{ code: 'X', confidence: 0.8, severity: 'moderate', label: 'bad', conceptId: 'c1' }],
      frontier: [{ conceptId: 'c2', concept: { label: 'Next', difficulty: 0.4 }, readiness: 0.9, unlocks: 3 }],
    }));
    assert.ok(d.chosen.reason.length > 30);
    assert.ok(d.narrative.includes('Considered instead'));
    assert.ok(d.considered >= 2);
    assert.ok(d.runnersUp.length >= 1);
  });
});

describe('item generation', () => {
  const setup = () => {
    const db = memoryDb();
    const repos = makeRepos(db);
    const graph = new GraphService(repos);
    seedCurriculum(repos, graph);
    return { repos, graph, assessment: new AssessmentService(repos) };
  };

  test('every seeded concept can produce at least one item', () => {
    const { repos } = setup();
    const failures: string[] = [];
    for (const c of repos.concepts.all()) {
      const items = generateItems(c, repos.terms.forConcept(c.id), { count: 1 });
      if (!items.length) failures.push(c.slug);
    }
    assert.deepEqual(failures, [], `concepts that cannot be assessed: ${failures.join(', ')}`);
  });

  test('generated maths items are actually correct', () => {
    const { repos } = setup();
    const checks: [string, (i: ReturnType<typeof generateItems>[number]) => boolean][] = [
      ['order-of-operations', (i) => {
        const m = i.stem.match(/(\d+) \+ (\d+) × (\d+)/);
        if (!m) return true;
        const expected = Number(m[1]) + Number(m[2]) * Number(m[3]);
        const chosen = i.choices.find((c) => c.key === i.answer.value);
        return chosen?.text === String(expected);
      }],
      ['linear-equations', (i) => {
        const m = i.stem.match(/(\d+)x \+ (\d+) = (\d+)/);
        if (!m) return true;
        return Number(i.answer.value) === (Number(m[3]) - Number(m[2])) / Number(m[1]);
      }],
      ['pythagoras', (i) => {
        const m = i.stem.match(/legs of (\d+) and (\d+)/);
        if (!m) return true;
        return Number(i.answer.value) === Math.hypot(Number(m[1]), Number(m[2]));
      }],
      ['percentages', (i) => {
        const m = i.stem.match(/(\d+)% of (\d+)/);
        if (!m) return true;
        return Number(i.answer.value) === (Number(m[1]) / 100) * Number(m[2]);
      }],
    ];
    for (const [slug, check] of checks) {
      const c = repos.concepts.bySlug(slug)!;
      const items = generateItems(c, repos.terms.forConcept(c.id), { count: 6, seed: `${slug}-test` });
      for (const i of items) {
        assert.ok(check(i), `wrong generated answer for ${slug}: "${i.stem}" -> ${JSON.stringify(i.answer)}`);
      }
    }
  });

  test('fraction addition distractors are computed from the wrong rule', () => {
    const { repos } = setup();
    const c = repos.concepts.bySlug('fraction-addition')!;
    const items = generateItems(c, [], { count: 5, seed: 'frac', allowGeneric: false });
    assert.ok(items.length > 0);
    for (const i of items) {
      const m = i.stem.match(/(\d+)\/(\d+) \+ (\d+)\/(\d+)/);
      if (!m) continue;
      const [n1, d1, n2, d2] = m.slice(1).map(Number);
      const cross = i.choices.find((ch) => ch.misconceptionCode === 'FRAC_ADD_CROSS');
      assert.ok(cross, `no cross-add distractor in "${i.stem}"`);
      // The distractor must be exactly what the wrong rule produces.
      const g = (a: number, b: number): number => (b === 0 ? a : g(b, a % b));
      const k = g(n1 + n2, d1 + d2) || 1;
      assert.equal(cross!.text, `${(n1 + n2) / k}/${(d1 + d2) / k}`);
    }
  });

  test('generated items are distinct, not the same question repeated', () => {
    const { repos } = setup();
    const c = repos.concepts.bySlug('division')!;
    const items = generateItems(c, repos.terms.forConcept(c.id), { count: 5, seed: 'div' });
    assert.equal(new Set(items.map((i) => i.stem)).size, items.length);
  });

  test('the bank is topped up on demand for a concept that had none', () => {
    const { repos, assessment } = setup();
    const c = repos.concepts.bySlug('division')!;
    assert.equal(repos.items.forConcept(c.id).length, 0, 'division should start with no items');
    const items = assessment.ensureItems(c.id, 3);
    assert.ok(items.length >= 3);
    assert.equal(repos.items.forConcept(c.id).length, items.length, 'generated items must be persisted');
  });

  test('backfill reports which concepts were thin', () => {
    const { assessment } = setup();
    const report = assessment.backfill(2);
    assert.ok(report.length > 0);
    const bank = assessment.bankReport();
    assert.equal(bank.totals.empty, 0, 'no concept should be left unassessable');
    assert.ok(bank.totals.items >= bank.totals.concepts * 2, 'every concept should hold at least two items');
  });
});

describe('grading', () => {
  const item = (over: Partial<ItemRecord>): ItemRecord => ({
    id: 'i', conceptId: 'c', kind: 'numeric', stem: 'x', choices: [], answer: { value: 4 },
    rubric: {}, difficulty: 0, discrimination: 1, guessing: 0, misconceptionMap: {},
    bloom: 'apply', exposures: 0, pCorrect: null, accessibility: {}, meta: {}, createdAt: '', ...over,
  });

  test('numeric answers accept equivalent forms and units', () => {
    const i = item({ answer: { value: 15 } });
    for (const raw of ['15', ' 15 ', '15 cm', '15.0']) {
      assert.equal(grade(i, raw).correct, true, `rejected "${raw}"`);
    }
  });

  test('a sign slip is distinguished from not knowing', () => {
    const r = grade(item({ answer: { value: 8 } }), '-8');
    assert.equal(r.correct, false);
    assert.ok(r.signals.includes('sign_error'));
    assert.ok(r.score > 0, 'a sign slip deserves partial credit');
    assert.match(r.feedback, /sign/i);
  });

  test('a place-value slip is named', () => {
    const r = grade(item({ answer: { value: 15 } }), '150');
    assert.ok(r.signals.includes('place_value_error'));
    assert.match(r.feedback, /place value/i);
  });

  test('fractions and decimals naming the same value both pass', () => {
    const i = item({ kind: 'short_answer', answer: { value: '1/2', aliases: ['0.5'] } });
    assert.equal(grade(i, '1/2').correct, true);
    assert.equal(grade(i, '2/4').correct, true, 'equivalent fraction should pass');
    assert.equal(grade(i, '0.5').correct, true);
    assert.equal(grade(i, '3/4').correct, false);
  });

  test('a spelling slip is not treated as not knowing', () => {
    const i = item({ kind: 'short_answer', answer: { value: 'photosynthesis' } });
    const r = grade(i, 'photosynthesus');
    assert.equal(r.correct, true);
    assert.ok(r.signals.includes('spelling'));
    assert.match(r.feedback, /spelling/i);
  });

  test('choosing a diagnostic distractor is flagged for the misconception engine', () => {
    const i = item({
      kind: 'mcq',
      choices: [{ key: 'a', text: '11/12' }, { key: 'b', text: '3/7', misconceptionCode: 'FRAC_ADD_CROSS' }],
      answer: { value: 'a' },
      misconceptionMap: { b: 'FRAC_ADD_CROSS' },
    });
    const r = grade(i, 'b');
    assert.equal(r.correct, false);
    assert.ok(r.signals.includes('distractor:FRAC_ADD_CROSS'));
  });

  test('an answer outside the options is reported as such', () => {
    const i = item({ kind: 'mcq', choices: [{ key: 'a', text: 'yes' }], answer: { value: 'a' } });
    assert.ok(grade(i, 'z').signals.includes('off_option'));
  });

  test('a blank answer is never marked correct', () => {
    for (const kind of ['numeric', 'mcq', 'short_answer', 'explain'] as const) {
      assert.equal(grade(item({ kind }), '   ').correct, false);
    }
  });

  test('open responses are scored on ideas, not wording', () => {
    const i = item({
      kind: 'explain',
      answer: { value: 'denominator numerator equal parts whole' },
    });
    const good = grade(i, 'The denominator is how many equal parts the whole is cut into, and the numerator is how many of those parts you have.');
    const empty = grade(i, 'it is a fraction');
    assert.ok(good.score > empty.score);
    assert.ok(good.rubric && good.rubric.length > 0);
  });
});

describe('self-explanation scoring', () => {
  test('causal reasoning scores above restatement', () => {
    const source = 'Plants capture light energy and build glucose from carbon dioxide and water.';
    const copied = scoreSelfExplanation(source, { sourceText: source, keyTerms: ['glucose'] });
    const reasoned = scoreSelfExplanation(
      'The plant takes in carbon dioxide and makes glucose, because light gives it the energy it needs to join the atoms together.',
      { sourceText: source, keyTerms: ['glucose'] },
    );
    assert.equal(copied.depth, 'restatement');
    assert.equal(reasoned.depth, 'reasoning');
    assert.ok(reasoned.score > copied.score);
  });

  test('an analogy plus reasoning reads as transfer', () => {
    const r = scoreSelfExplanation(
      'It is like a factory, because the leaf takes in raw materials and uses light as the power supply to build sugar.',
      { keyTerms: [] },
    );
    assert.equal(r.depth, 'transfer');
    assert.ok(r.usesCausalLanguage);
  });

  test('an empty response asks for something rather than scoring it', () => {
    const r = scoreSelfExplanation('', {});
    assert.equal(r.depth, 'none');
    assert.equal(r.score, 0);
    assert.ok(r.feedback.length > 10);
  });

  test('missing key terms become the next prompt', () => {
    const r = scoreSelfExplanation('It makes food somehow.', { keyTerms: ['chlorophyll', 'glucose'] });
    assert.ok(r.missingTerms.includes('chlorophyll'));
    assert.match(r.prompt, /chlorophyll/);
  });
});

describe('session engine', () => {
  const setup = () => {
    const db = memoryDb();
    const repos = makeRepos(db);
    const graph = new GraphService(repos);
    seedCurriculum(repos, graph);
    const twin = new TwinService(repos, graph);
    const assessment = new AssessmentService(repos);
    const engine = new SessionEngine(
      repos, graph, twin,
      new MisconceptionEngine(repos, router),
      new VisualEngine(repos, router),
      assessment,
    );
    return { repos, graph, twin, engine, assessment };
  };

  const withHistory = (repos: ReturnType<typeof makeRepos>, learnerId: string) => {
    const set = (slug: string, p: number) => {
      const c = repos.concepts.bySlug(slug)!;
      repos.mastery.save({
        learnerId, conceptId: c.id, pKnown: p, elo: 1200, attempts: 6, correct: Math.round(p * 6),
        streak: 0, stability: 4, fsrsDifficulty: 5, reps: 2, lapses: 0,
        lastSeen: new Date(Date.now() - 3 * 864e5).toISOString(), dueAt: null, firstMasteredAt: null,
      });
    };
    ['counting', 'addition', 'subtraction', 'place-value', 'multiplication'].forEach((s) => set(s, 0.92));
    set('division', 0.33);
    set('fractions', 0.41);
  };

  test('starting a second session ends the first, so evidence is not interleaved', () => {
    const { repos, twin, engine } = setup();
    const l = twin.create({ name: 'A', grade: 7 });
    const first = engine.start(l.id);
    const second = engine.start(l.id);
    assert.notEqual(first.id, second.id);
    assert.equal(repos.sessions.get(first.id)!.status, 'ended');
    assert.equal(repos.sessions.get(first.id)!.endReason, 'superseded_by_new_session');
  });

  test('the first step on a known gap targets the root cause, not the goal', async () => {
    const { repos, twin, engine } = setup();
    const l = twin.create({ name: 'Maya', grade: 7, needs: ['dyslexia'] });
    withHistory(repos, l.id);
    const s = engine.start(l.id, { goalSlug: 'ratios' });
    const x = await engine.next(s.id);
    assert.equal(x.action, 'repair_prerequisite');
    assert.equal(x.conceptLabel, 'Division');
    assert.ok(x.rationale.narrative.length > 40);
  });

  test('a full session advances and never loops on one concept', async () => {
    const { repos, twin, engine } = setup();
    const l = twin.create({ name: 'Maya', grade: 7 });
    withHistory(repos, l.id);
    const s = engine.start(l.id, { goalSlug: 'ratios' });

    const seenPairs = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const x = await engine.next(s.id);
      const key = `${x.action}:${x.conceptId ?? ''}:${x.modality}`;
      assert.ok(!seenPairs.has(key), `repeated identical experience: ${key}`);
      seenPairs.add(key);
      if (x.check) {
        const item = repos.items.require(x.check.itemId!);
        await engine.answer(s.id, {
          itemId: item.id, raw: String(item.answer.value), correct: true, latencyMs: 12_000, modality: x.modality,
        });
      }
    }
    const sum = engine.end(s.id);
    assert.ok(sum.itemsDelivered > 0, 'a session must be able to check what it taught');
    assert.ok(sum.conceptsTouched.length >= 2, 'the session should progress beyond one concept');
    assert.ok(sum.highlights.length > 0);
  });

  test('every delivered experience carries accessibility settings and a rationale', async () => {
    const { repos, twin, engine } = setup();
    const l = twin.create({ name: 'Leo', grade: 6, needs: ['dyslexia', 'adhd'] });
    withHistory(repos, l.id);
    const s = engine.start(l.id, { goalSlug: 'ratios' });
    for (let i = 0; i < 3; i++) {
      const x = await engine.next(s.id);
      assert.ok(x.accessibility.targetGrade !== undefined);
      assert.ok((x.accessibility.maxChunkWords as number) <= 9, 'dyslexia + adhd should cap chunk size');
      assert.ok(x.rationale.chosen.length > 0);
      assert.ok(x.estimatedSec > 0);
      assert.ok(x.sessionProgress.step === i);
    }
  });

  test('a wrong answer on a diagnostic distractor produces a diagnosis in the response', async () => {
    const { repos, twin, engine } = setup();
    const l = twin.create({ name: 'Sam', grade: 6 });
    const concept = repos.concepts.bySlug('fraction-addition')!;
    const item = repos.items.forConcept(concept.id).find((i) => i.kind === 'mcq')!;
    const s = engine.start(l.id);
    const r = await engine.answer(s.id, { itemId: item.id, raw: 'b', correct: false, latencyMs: 30_000 });
    assert.ok(r.diagnosis, 'a diagnostic distractor must produce a diagnosis');
    assert.equal(r.diagnosis!.code, 'FRAC_ADD_CROSS');
    assert.equal(r.feedback.tone, 'diagnostic');
  });

  test('correct unhinted answers decay and eventually close a misconception', () => {
    const { repos, twin } = setup();
    const l = twin.create({ name: 'Ana', grade: 6 });
    const concept = repos.concepts.bySlug('fractions')!;
    const m = repos.misconceptions.byCode('FRAC_BIGGER_DENOM')!;
    twin.noteMisconception(l.id, m.id, concept.id, 0.8);
    assert.equal(twin.activeMisconceptions(l.id).length, 1);

    let repaired: string[] = [];
    for (let i = 0; i < 4 && !repaired.length; i++) {
      repaired = twin.creditCorrectAnswer(l.id, concept.id).repaired;
    }
    assert.ok(repaired.includes('FRAC_BIGGER_DENOM'), 'repeated correct answers should close the misconception');
    assert.equal(twin.activeMisconceptions(l.id).length, 0);
  });

  test('the session trace records why each step was chosen', async () => {
    const { repos, twin, engine } = setup();
    const l = twin.create({ name: 'Trace', grade: 7 });
    withHistory(repos, l.id);
    const s = engine.start(l.id, { goalSlug: 'ratios' });
    await engine.next(s.id);
    await engine.next(s.id);
    const trace = engine.trace(s.id);
    assert.equal(trace.steps.length, 2);
    assert.ok(trace.steps.every((st) => st.reason.length > 20), 'every step must record its reasoning');
    assert.ok(trace.steps[0].conceptLabel);
  });

  test('answering an ended session is refused', async () => {
    const { twin, engine } = setup();
    const l = twin.create({ name: 'Z', grade: 7 });
    const s = engine.start(l.id);
    engine.end(s.id);
    await assert.rejects(() => engine.next(s.id), /already ended/);
  });
});
