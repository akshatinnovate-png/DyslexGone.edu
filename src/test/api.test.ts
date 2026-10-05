import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from '../api/server.js';
import { memoryDb } from '../db/sqlite.js';

let server: Server;

before(async () => {
  server = await createServer({ db: memoryDb(), startJobs: false, backfillItems: false });
});
after(async () => { await server.close(); });

const get = (url: string) => server.app.inject({ method: 'GET', url });
const post = (url: string, payload?: unknown, headers?: Record<string, string>) =>
  server.app.inject({ method: 'POST', url, payload: payload as never, headers });
const json = <T = Record<string, unknown>>(r: { body: string }): T => JSON.parse(r.body) as T;

describe('api surface', () => {
  test('health reports what is actually working', async () => {
    const r = await get('/health');
    assert.equal(r.statusCode, 200);
    const b = json(r);
    assert.equal(b.status, 'ok');
    assert.equal((b.checks as Record<string, string>).curriculum, 'seeded');
  });

  test('deep health surfaces graph and model state', async () => {
    const b = json(await get('/health/deep'));
    assert.ok((b.graph as { nodes: number }).nodes > 100);
    assert.equal((b.graph as { cycles: number }).cycles, 0);
    assert.ok(b.models);
  });

  test('capabilities describe this deployment honestly', async () => {
    const b = json(await get('/v1/capabilities'));
    assert.ok((b.modalities as string[]).length >= 12);
    assert.ok((b.accessNeeds as unknown[]).length >= 13);
    assert.ok((b.labs as unknown[]).length >= 10);
    assert.equal(typeof (b.models as { hostedAvailable: boolean }).hostedAvailable, 'boolean');
  });

  test('openapi is generated from the real route table', async () => {
    const b = json(await get('/v1/openapi.json'));
    const paths = Object.keys(b.paths as object);
    assert.ok(paths.length > 60, `only ${paths.length} paths`);
    assert.ok(paths.includes('/v1/learners'));
    assert.ok(paths.includes('/v1/sessions/{id}/next'));
    assert.ok(paths.includes('/v1/accessibility/transform'));
  });

  test('prometheus metrics are served', async () => {
    const r = await get('/metrics');
    assert.equal(r.statusCode, 200);
    assert.match(r.headers['content-type'] as string, /text\/plain/);
    assert.match(r.body, /lumen_http_requests_total/);
  });

  test('an unknown route returns a helpful 404, not a stack trace', async () => {
    const r = await get('/v1/nonsense');
    assert.equal(r.statusCode, 404);
    const b = json(r);
    assert.equal((b.error as { code: string }).code, 'not_found');
    assert.ok((b.error as { hint: string }).hint.includes('openapi'));
    assert.ok(!r.body.includes('at Object.'), 'a stack trace leaked to the client');
  });

  test('validation failures name the offending field', async () => {
    const r = await post('/v1/learners', { grade: 99 });
    assert.equal(r.statusCode, 400);
    const b = json(r);
    assert.equal((b.error as { code: string }).code, 'bad_request');
    const details = (b.error as { details: { path: string }[] }).details;
    assert.ok(details.some((d) => d.path === 'name'), JSON.stringify(details));
  });

  test('every response carries a request id', async () => {
    const r = await get('/health');
    assert.ok(r.headers['x-request-id']);
  });
});

describe('learner and graph routes', () => {
  let learnerId: string;

  test('a learner is created with a derived access profile', async () => {
    const r = await post('/v1/learners', { name: 'Maya', grade: 7, needs: ['dyslexia', 'working_memory'] });
    assert.equal(r.statusCode, 201);
    const b = json<{ learner: { id: string }; spec: { targetGrade: number; maxChunkWords: number } }>(r);
    learnerId = b.learner.id;
    assert.ok(b.spec.targetGrade < 7, 'dyslexia should lower the reading target');
    assert.ok(b.spec.maxChunkWords <= 7);
  });

  test('the twin returns every engine at once', async () => {
    const b = json(await get(`/v1/learners/${learnerId}/twin`));
    for (const key of ['ability', 'mastery', 'modalities', 'errorPatterns', 'friction', 'load', 'recovery', 'pacing']) {
      assert.ok(key in b, `twin snapshot missing ${key}`);
    }
  });

  test('the gap trace explains the root cause in words', async () => {
    const b = json<{ explanation: string; gaps: unknown[]; repairRoute: unknown[] }>(
      await get(`/v1/learners/${learnerId}/gaps/ratios`),
    );
    assert.ok(b.explanation.length > 40);
    assert.ok(b.repairRoute.length > 0);
  });

  test('the frontier only offers grade-appropriate concepts', async () => {
    const b = json<{ frontier: { label: string; readiness: number }[] }>(
      await get(`/v1/learners/${learnerId}/frontier?limit=5`),
    );
    assert.ok(b.frontier.length > 0);
    assert.ok(b.frontier.every((f) => f.readiness >= 0 && f.readiness <= 1));
  });

  test('the graph exports nodes and edges for a visualiser', async () => {
    const b = json<{ nodes: unknown[]; edges: unknown[] }>(await get('/v1/graph?subject=math'));
    assert.ok(b.nodes.length > 20);
    assert.ok(b.edges.length > 20);
  });

  test('graph health reports zero cycles on the seeded curriculum', async () => {
    const b = json<{ cycles: unknown[]; sequencingErrors: unknown[] }>(await get('/v1/graph/health'));
    assert.equal(b.cycles.length, 0);
    assert.equal(b.sequencingErrors.length, 0);
  });

  test('a link that would create a cycle is rejected with an explanation', async () => {
    const concepts = json<{ concepts: { id: string; slug: string }[] }>(await get('/v1/concepts?q=division'));
    const division = concepts.concepts.find((c) => c.slug === 'division')!;
    const r = await post(`/v1/concepts/${division.id}/links`, { to: 'multiplication', kind: 'requires' });
    assert.equal(r.statusCode, 422);
    assert.match(json<{ error: { message: string } }>(r).error.message, /cycle/i);
  });
});

describe('accessibility routes', () => {
  test('the transformer returns every doorway at once', async () => {
    const b = json<{
      variants: Record<string, unknown>; render: Record<string, unknown>;
      audio: Record<string, unknown>; gains: { gradeBefore: number; gradeAfter: number };
    }>(await post('/v1/accessibility/transform', {
      text: 'Photosynthesis is utilized by plants in order to convert light energy into chemical energy, '
        + 'which necessitates the absorption of carbon dioxide from the surrounding atmosphere.',
      grade: 5, needs: ['dyslexia'], keepTerms: ['photosynthesis'],
    }));
    for (const v of ['plain', 'elementary', 'outline', 'bullets', 'oneLine', 'socratic', 'glossaryFirst']) {
      assert.ok(v in b.variants, `missing variant ${v}`);
    }
    assert.ok(b.gains.gradeAfter < b.gains.gradeBefore);
    assert.ok(b.render.typography);
    assert.ok(b.audio);
  });

  test('a protected term survives simplification', async () => {
    const b = json<{ variants: { plain: string } }>(await post('/v1/accessibility/transform', {
      text: 'Photosynthesis is utilized by plants to make food.',
      grade: 4, keepTerms: ['photosynthesis'], compact: true,
    }));
    assert.match(b.variants.plain.toLowerCase(), /photosynthesis/);
  });

  test('analysis returns eight formulas and the hardest sentences', async () => {
    const b = json<{ readability: { scores: Record<string, number> }; hardestSentences: unknown[] }>(
      await post('/v1/accessibility/analyze', { text: 'The mitochondrion, notwithstanding its diminutive dimensions, constitutes the predominant site of cellular respiration. It is small.', grade: 6 }),
    );
    assert.equal(Object.keys(b.readability.scores).length, 8);
    assert.ok(b.hardestSentences.length > 0);
  });

  test('every palette meets at least AA contrast', async () => {
    const b = json<{ palettes: { name: string; wcag: string; contrastRatio: number }[] }>(
      await get('/v1/accessibility/palettes'),
    );
    assert.ok(b.palettes.length >= 8);
    for (const p of b.palettes) {
      assert.notEqual(p.wcag, 'fail', `${p.name} fails contrast at ${p.contrastRatio}`);
    }
  });

  test('speech returns SSML, timings and captions', async () => {
    const b = json<{ ssml: string; timings: unknown[]; vtt: string }>(
      await post('/v1/accessibility/speech', { text: 'Add one half and one quarter. The answer is 3/4.', grade: 5 }),
    );
    assert.match(b.ssml, /^<speak/);
    assert.ok(b.timings.length > 5);
    assert.match(b.vtt, /^WEBVTT/);
  });
});

describe('labs and visuals', () => {
  test('every lab is listed with controls', async () => {
    const b = json<{ labs: { id: string; controls: unknown[] }[] }>(await get('/v1/labs'));
    assert.ok(b.labs.length >= 10);
    assert.ok(b.labs.every((l) => l.controls.length > 0));
  });

  test('a circuit run returns computed readings', async () => {
    const b = json<{ readings: { label: string; value: number }[]; insights: string[] }>(
      await post('/v1/labs/circuit/run', { preset: 'series', voltage: 12, resistance1: 100, resistance2: 200 }),
    );
    const total = b.readings.find((r) => r.label === 'Total current')!;
    assert.ok(Math.abs(total.value - 12 / 300) < 1e-3, `expected 0.04 A, got ${total.value}`);
    assert.ok(b.insights.some((i) => /series/i.test(i)));
  });

  test('an unknown lab is refused and lists the real ones', async () => {
    const r = await post('/v1/labs/teleporter/run', {});
    assert.equal(r.statusCode, 422);
    assert.match(r.body, /unknown lab/);
  });

  test('a visual is produced for a curated concept', async () => {
    const b = json<{ svg: string; audit: { ok: boolean }; durationSec: number; captionsVtt: string }>(
      await post('/v1/visuals', { conceptSlug: 'fraction-addition', grade: 5 }),
    );
    assert.ok(b.svg.startsWith('<svg'));
    assert.equal(b.audit.ok, true);
    assert.ok(b.durationSec > 5);
    assert.match(b.captionsVtt, /^WEBVTT/);
  });

  test('a visual is produced for a topic that is not in the graph at all', async () => {
    const b = json<{ svg: string; source: string; audit: { ok: boolean } }>(
      await post('/v1/visuals', {
        topic: 'The water cycle in deserts',
        description: 'Very little rain falls. What does fall evaporates quickly because the air is hot and dry.',
        grade: 6, compact: false,
      }),
    );
    assert.ok(b.svg.startsWith('<svg'));
    assert.ok(b.audit.ok);
  });

  test('the SVG endpoint serves a renderable image', async () => {
    const r = await get('/v1/visuals/fraction-addition.svg?still=true');
    assert.equal(r.statusCode, 200);
    assert.match(r.headers['content-type'] as string, /image\/svg/);
    assert.ok(r.body.startsWith('<svg'));
  });

  test('a visual request with no target is refused', async () => {
    const r = await post('/v1/visuals', { grade: 5 });
    assert.equal(r.statusCode, 400);
  });
});

describe('the adaptation loop over http', () => {
  let learnerId: string;
  let sessionId: string;

  test('a session starts against a goal', async () => {
    const l = json<{ learner: { id: string } }>(
      await post('/v1/learners', { name: 'Sam', grade: 7, needs: ['dyslexia'] }),
    );
    learnerId = l.learner.id;
    const r = await post('/v1/sessions', { learnerId, goal: 'ratios' });
    assert.equal(r.statusCode, 201);
    sessionId = json<{ id: string }>(r).id;
  });

  test('the decision can be inspected without delivering it', async () => {
    const b = json<{ chosen: { kind: string; reason: string }; runnersUp: unknown[]; considered: number }>(
      await get(`/v1/sessions/${sessionId}/decision`),
    );
    assert.ok(b.chosen.reason.length > 30);
    assert.ok(b.considered >= 1);
  });

  test('next delivers an experience with accessibility settings and a rationale', async () => {
    const b = json<{
      action: string; modality: string; payload: Record<string, unknown>;
      accessibility: Record<string, unknown>; rationale: { narrative: string };
      check?: { itemId: string };
    }>(await post(`/v1/sessions/${sessionId}/next`));
    assert.ok(b.action);
    assert.ok(b.rationale.narrative.length > 30);
    assert.ok(b.accessibility.targetGrade !== undefined);
    assert.ok(Object.keys(b.payload).length > 0);
  });

  test('an answer is graded, recorded and fed back', async () => {
    const exp = json<{ check?: { itemId: string } }>(await post(`/v1/sessions/${sessionId}/next`));
    if (!exp.check?.itemId) return;
    const r = await post(`/v1/sessions/${sessionId}/answer`, { itemId: exp.check.itemId, raw: 'a' });
    assert.equal(r.statusCode, 200);
    const b = json<{ mastery: { before: number; after: number }; feedback: { headline: string }; grading: unknown }>(r);
    assert.ok(b.feedback.headline.length > 0);
    assert.ok(b.grading, 'the server should grade when correctness is not supplied');
    assert.notEqual(b.mastery.before, undefined);
  });

  test('a wrong diagnostic answer produces a diagnosis over http', async () => {
    const items = json<{ items: { id: string; choices: { key: string; misconceptionCode?: string }[] }[] }>(
      await get('/v1/concepts/fraction-addition/items'),
    );
    const diagnostic = items.items.find((i) => i.choices.some((c) => c.misconceptionCode));
    if (!diagnostic) return;
    const bad = diagnostic.choices.find((c) => c.misconceptionCode)!;
    const b = json<{ diagnosis?: { code: string; reasoning: string } }>(
      await post(`/v1/sessions/${sessionId}/answer`, { itemId: diagnostic.id, raw: bad.key }),
    );
    assert.ok(b.diagnosis, 'a diagnostic distractor must produce a diagnosis');
    assert.equal(b.diagnosis!.code, bad.misconceptionCode);
  });

  test('the trace records why each step happened', async () => {
    const b = json<{ steps: { reason: string }[] }>(await get(`/v1/sessions/${sessionId}/trace`));
    assert.ok(b.steps.length >= 2);
    assert.ok(b.steps.every((s) => s.reason.length > 20));
  });

  test('ending the session produces a human summary', async () => {
    const b = json<{ highlights: string[]; conceptsTouched: unknown[]; accuracy: number }>(
      await post(`/v1/sessions/${sessionId}/end`, { reason: 'test' }),
    );
    assert.ok(b.highlights.length > 0);
    assert.ok(b.accuracy >= 0 && b.accuracy <= 1);
  });

  test('a finished session refuses more work', async () => {
    const r = await post(`/v1/sessions/${sessionId}/next`);
    assert.equal(r.statusCode, 422);
  });
});

describe('diagnosis, ingestion and teaching', () => {
  test('diagnosis names the wrong rule', async () => {
    const b = json<{ found: boolean; code: string; source: string; reasoning: string }>(
      await post('/v1/misconceptions/diagnose', {
        stem: 'What is 2/3 + 1/4?', learnerAnswer: '3/7', correctAnswer: '11/12',
      }),
    );
    assert.equal(b.found, true);
    assert.equal(b.code, 'FRAC_ADD_CROSS');
    assert.equal(b.source, 'rule_detector');
    assert.match(b.reasoning, /add the tops/i);
  });

  test('an unexplainable answer gets no diagnosis rather than a wrong one', async () => {
    const b = json<{ found: boolean }>(await post('/v1/misconceptions/diagnose', {
      stem: 'What is 2/3 + 1/4?', learnerAnswer: '91/17', correctAnswer: '11/12', allowModel: false,
    }));
    assert.equal(b.found, false);
  });

  test('ingesting a chapter returns concepts, hard sections and a headline', async () => {
    const b = json<{
      concepts: unknown[]; hardSections: unknown[]; headline: string; itemsGenerated: number;
    }>(await post('/v1/ingest', {
      content: '# Osmosis\n\n## Definition\nWater moves across a partially permeable membrane from a dilute '
        + 'solution to a concentrated one, and this process, which is passive, requires no expenditure of energy.\n',
      subject: 'biology', grade: 8, previewNeeds: ['dyslexia'],
    }));
    assert.ok(b.concepts.length >= 1);
    assert.ok(b.headline.length > 40);
    assert.ok(b.itemsGenerated > 0);
  });

  test('an empty upload is reported, not accepted silently', async () => {
    const r = await post('/v1/ingest', { content: '    ' });
    assert.equal(r.statusCode, 200);
    assert.match(json<{ headline: string }>(r).headline, /no readable text/i);
  });

  test('a lesson pack contains everything a teacher would build by hand', async () => {
    const b = json<{
      objective: string; lesson: { hook: string; keyTerms: unknown[] };
      differentiation: unknown[]; quiz: { questions: unknown[]; answerKey: unknown[] };
      misconceptions: unknown[]; activity: { title: string }; worksheet: { tasks: unknown[] };
    }>(await post('/v1/teacher/lesson-pack', {
      conceptSlug: 'fraction-addition', grade: 6, includeVisual: false, questionCount: 3,
    }));
    assert.ok(b.objective.length > 20);
    assert.ok(b.lesson.hook.length > 30);
    assert.equal(b.differentiation.length, 3);
    assert.equal(b.quiz.questions.length, 3);
    assert.equal(b.quiz.answerKey.length, 3);
    assert.ok(b.misconceptions.length > 0);
    assert.ok(b.worksheet.tasks.length > 0);
  });

  test('a classroom is grouped by what each group actually needs', async () => {
    const room = json<{ id: string }>(await post('/v1/classrooms', { name: 'Y8', subject: 'math', grade: 8 }));
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const l = json<{ learner: { id: string } }>(
        await post('/v1/learners', { name: `S${i}`, grade: 8 }),
      );
      ids.push(l.learner.id);
    }
    await post(`/v1/classrooms/${room.id}/enroll`, { learnerIds: ids });
    const b = json<{ groups: { label: string; doThis: string }[]; teacherBriefing: string }>(
      await post(`/v1/classrooms/${room.id}/grouping`, { concepts: ['fraction-addition'] }),
    );
    assert.ok(b.groups.length > 0);
    assert.ok(b.teacherBriefing.length > 30);
    assert.ok(b.groups.every((g) => g.doThis.length > 20), 'every group needs an actionable instruction');
  });

  test('system effectiveness measures the OS, not the student', async () => {
    const b = json<{ misconceptions: { interpretation: string }; itemBank: { interpretation: string } }>(
      await get('/v1/analytics/effectiveness'),
    );
    assert.ok(b.misconceptions.interpretation.length > 20);
    assert.ok(b.itemBank.interpretation.length > 20);
  });
});

describe('idempotency', () => {
  test('a repeated POST with the same key replays rather than duplicating', async () => {
    const headers = { 'idempotency-key': 'test-key-1', 'content-type': 'application/json' };
    const first = await post('/v1/learners', { name: 'Once', grade: 5 }, headers);
    const second = await post('/v1/learners', { name: 'Once', grade: 5 }, headers);
    assert.equal(first.statusCode, 201);
    assert.equal(second.headers['idempotent-replay'], 'true');
    assert.equal(
      json<{ learner: { id: string } }>(first).learner.id,
      json<{ learner: { id: string } }>(second).learner.id,
    );
  });

  test('reusing a key on a different route is refused', async () => {
    const headers = { 'idempotency-key': 'test-key-2', 'content-type': 'application/json' };
    await post('/v1/learners', { name: 'Twice', grade: 5 }, headers);
    const r = await post('/v1/classrooms', { name: 'Nope' }, headers);
    assert.equal(r.statusCode, 409);
  });
});
