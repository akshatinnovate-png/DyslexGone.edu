import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectAll, evalExpression, evalLeftToRight, parseFractions, simplify, answerMatches } from '../misconception/detectors.js';
import { MisconceptionEngine } from '../misconception/engine.js';
import { memoryDb } from '../db/sqlite.js';
import { makeRepos } from '../db/repos.js';
import { GraphService, seedCurriculum } from '../graph/service.js';
import { router } from '../llm/router.js';

describe('expression evaluation', () => {
  test('precedence is honoured', () => {
    assert.equal(evalExpression('2 + 3 * 4'), 14);
    assert.equal(evalExpression('2 * 3 + 4'), 10);
    assert.equal(evalExpression('10 - 2 * 3'), 4);
    assert.equal(evalExpression('(2 + 3) * 4'), 20);
    assert.equal(evalExpression('8 / 2 + 2'), 6);
  });

  test('left-to-right evaluation reproduces the classic error', () => {
    assert.equal(evalLeftToRight('2 + 3 * 4'), 20);
    assert.equal(evalLeftToRight('10 - 2 * 3'), 24);
  });

  test('malformed input returns null rather than throwing', () => {
    assert.equal(evalExpression('2 +'), null);
    assert.equal(evalExpression('(2 + 3'), null);
    assert.equal(evalExpression(''), null);
    assert.equal(evalExpression('1 / 0'), null);
  });
});

describe('fraction parsing', () => {
  test('parses and simplifies', () => {
    assert.deepEqual(parseFractions('2/3 + 1/4'), [{ n: 2, d: 3 }, { n: 1, d: 4 }]);
    assert.deepEqual(simplify({ n: 6, d: 8 }), { n: 3, d: 4 });
    assert.deepEqual(simplify({ n: 2, d: -4 }), { n: -1, d: 2 });
  });

  test('answer matching accepts equivalent forms', () => {
    assert.ok(answerMatches('6/8', { n: 3, d: 4 }));
    assert.ok(answerMatches('0.75', { n: 3, d: 4 }));
    assert.ok(answerMatches(' 4 ', 4));
    assert.ok(!answerMatches('5', 4));
  });
});

describe('rule detectors', () => {
  test('cross-addition of fractions is reproduced exactly', () => {
    const d = detectAll({ stem: 'What is 2/3 + 1/4?', learnerAnswer: '3/7', correctAnswer: '11/12' });
    assert.equal(d[0].code, 'FRAC_ADD_CROSS');
    assert.ok(d[0].confidence > 0.9);
    assert.equal(d[0].reproducedAnswer, '3/7');
    assert.match(d[0].reasoning, /add the tops/i);
  });

  test('a correct answer triggers nothing', () => {
    const d = detectAll({ stem: 'What is 2/3 + 1/4?', learnerAnswer: '11/12', correctAnswer: '11/12' });
    assert.equal(d.length, 0);
  });

  test('a random wrong answer triggers nothing - no false diagnosis', () => {
    const d = detectAll({ stem: 'What is 2/3 + 1/4?', learnerAnswer: '42/99', correctAnswer: '11/12' });
    assert.equal(d.length, 0);
  });

  test('denominator-size comparison is caught', () => {
    const d = detectAll({ stem: 'Which fraction is larger: 1/3 or 1/8?', learnerAnswer: '1/8', correctAnswer: '1/3' });
    assert.equal(d[0].code, 'FRAC_BIGGER_DENOM');
  });

  test('decimal digit-counting is caught', () => {
    const d = detectAll({ stem: 'Which number is larger: 0.4 or 0.125?', learnerAnswer: '0.125', correctAnswer: '0.4' });
    assert.equal(d[0].code, 'DEC_LONGER_BIGGER');
  });

  test('left-to-right arithmetic is caught and explained', () => {
    const d = detectAll({ stem: 'Evaluate 2 + 3 * 4', learnerAnswer: '20', correctAnswer: '14' });
    assert.equal(d[0].code, 'PEMDAS_LEFT_RIGHT');
    assert.match(d[0].reasoning, /20/);
    assert.match(d[0].reasoning, /14/);
  });

  test('subtracting a negative is caught', () => {
    const d = detectAll({ stem: 'What is 5 - (-3)?', learnerAnswer: '2', correctAnswer: '8' });
    assert.equal(d[0].code, 'NEG_SUBTRACT_SMALLER');
  });

  test('additive scaling is caught', () => {
    const d = detectAll({
      stem: 'A recipe for 2 people needs 4 cups of flour. How much for 3 people?',
      learnerAnswer: '5', correctAnswer: '6',
    });
    assert.ok(d.some((x) => x.code === 'PROP_ADDITIVE'), `got ${d.map((x) => x.code).join(',')}`);
  });

  test('perimeter-for-area is caught in both directions', () => {
    const a = detectAll({ stem: 'A rectangle is 5 cm by 3 cm. What is its area?', learnerAnswer: '16', correctAnswer: '15' });
    assert.equal(a[0].code, 'AREA_PERIM_CONFUSION');
    const b = detectAll({ stem: 'A rectangle is 5 cm by 3 cm. What is its perimeter?', learnerAnswer: '15', correctAnswer: '16' });
    assert.equal(b[0].code, 'AREA_PERIM_CONFUSION');
  });

  test('mean reported for median is caught', () => {
    const d = detectAll({ stem: 'What is the median of 2, 3, 4, 5, 100?', learnerAnswer: '22.8', correctAnswer: '4' });
    assert.equal(d[0].code, 'MEAN_IS_MIDDLE');
  });

  test('physics free-response misconceptions are caught', () => {
    const d = detectAll({
      stem: 'A puck slides across frictionless ice at a steady speed. What is the net force?',
      learnerAnswer: 'There must be a constant forward force keeping it going',
      correctAnswer: 'Zero',
    });
    assert.equal(d[0].code, 'PHYS_FORCE_NEEDED_FOR_MOTION');

    const c = detectAll({
      stem: 'How does the current after the bulb compare to before it?',
      learnerAnswer: 'It is smaller because the bulb uses some up',
      correctAnswer: 'The same',
    });
    assert.equal(c[0].code, 'PHYS_CURRENT_USED_UP');
  });

  test('seasons-by-distance is caught, and a tilt answer is not', () => {
    const wrong = detectAll({
      stem: 'Why is it summer in July in the northern hemisphere?',
      learnerAnswer: 'Because Earth is closest to the Sun then', correctAnswer: 'Axial tilt',
    });
    assert.equal(wrong[0].code, 'EARTH_SEASONS_DISTANCE');

    const right = detectAll({
      stem: 'Why is it summer in July in the northern hemisphere?',
      learnerAnswer: 'The northern hemisphere is tilted toward the Sun so light is less spread out',
      correctAnswer: 'Axial tilt',
    });
    assert.equal(right.length, 0);
  });

  test('detectors never throw on hostile input', () => {
    for (const answer of ['', '   ', '1/0', '////', 'NaN', '∞', '0/0', '-'.repeat(200), '🙂']) {
      assert.doesNotThrow(() => detectAll({ stem: 'What is 1/2 + 1/2?', learnerAnswer: answer, correctAnswer: '1' }));
    }
  });
});

describe('misconception engine', () => {
  const setup = () => {
    const db = memoryDb();
    const repos = makeRepos(db);
    const graph = new GraphService(repos);
    seedCurriculum(repos, graph);
    return { repos, graph, engine: new MisconceptionEngine(repos, router) };
  };

  test('distractor mapping beats everything else and is near-certain', async () => {
    const { repos, engine } = setup();
    const concept = repos.concepts.bySlug('fraction-addition')!;
    const item = repos.items.forConcept(concept.id).find((i) => i.kind === 'mcq')!;
    const d = await engine.diagnose({ itemId: item.id, learnerAnswer: 'b', choiceKey: 'b', conceptId: concept.id });
    assert.equal(d.found, true);
    assert.equal(d.source, 'distractor_map');
    assert.equal(d.code, 'FRAC_ADD_CROSS');
    assert.ok(d.confidence > 0.95);
    assert.ok(d.remediation!.steps.length > 0);
  });

  test('rule detection works without an item record', async () => {
    const { engine } = setup();
    const d = await engine.diagnose({ stem: 'What is 2/3 + 1/4?', learnerAnswer: '3/7', correctAnswer: '11/12' });
    assert.equal(d.source, 'rule_detector');
    assert.equal(d.code, 'FRAC_ADD_CROSS');
    assert.ok(d.reproducedAnswer === '3/7');
  });

  test('nothing is claimed when nothing explains the answer', async () => {
    const { engine } = setup();
    const d = await engine.diagnose({
      stem: 'What is 2/3 + 1/4?', learnerAnswer: '77/13', correctAnswer: '11/12', allowModel: false,
    });
    assert.equal(d.found, false);
    assert.equal(d.source, 'none');
    assert.match(d.reasoning, /slip|gap/i);
    assert.ok(d.feedback.nextStep.length > 10);
  });

  test('remediation leads with contradiction, then rebuild, then teach-back', () => {
    const { engine } = setup();
    const r = engine.buildRemediation('FRAC_ADD_CROSS', { grade: 5 });
    const kinds = r.microLesson.steps.map((s) => s.kind);
    assert.equal(kinds[0], 'contradict');
    assert.ok(kinds.includes('rebuild'));
    assert.equal(kinds[kinds.length - 1], 'verify');
    assert.ok(r.microLesson.prerequisiteChecks.length > 0, 'should check the prerequisites the catalogue names');
    assert.ok(r.microLesson.estimatedSeconds > 60);
  });

  test('an unknown code is rejected loudly', () => {
    const { engine } = setup();
    assert.throws(() => engine.buildRemediation('NOT_A_REAL_CODE'), /unknown misconception/);
  });

  test('the catalogue reports which misconceptions are rule-detectable', () => {
    const { engine } = setup();
    const cat = engine.catalogue({ subject: 'math' });
    assert.ok(cat.length >= 8);
    assert.ok(cat.some((c) => c.ruleDetectable));
    assert.ok(cat.every((c) => c.strategy && c.stepCount > 0));
  });

  test('cohort prevalence aggregates across learners', () => {
    const { repos, engine } = setup();
    const m = repos.misconceptions.byCode('FRAC_ADD_CROSS')!;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const l = repos.learners.create({ name: `kid${i}`, grade: 6 });
      ids.push(l.id);
      if (i < 2) {
        repos.db.insert('learner_misconceptions', {
          learner_id: l.id, misconception_id: m.id, concept_id: m.conceptId,
          confidence: 0.8, occurrences: 2, status: 'active',
          first_at: new Date().toISOString(), last_at: new Date().toISOString(),
        });
      }
    }
    const prev = engine.cohortPrevalence(ids);
    assert.equal(prev[0].code, 'FRAC_ADD_CROSS');
    assert.equal(prev[0].affected, 2);
    assert.ok(Math.abs(prev[0].share - 2 / 3) < 0.01);
    assert.match(prev[0].teachingNote, /2 of 3/);
  });
});
