import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileStoryboard, sanitizeStoryboard, parseAtoms, parseBonds, parsePairs,
  parsePoints, parseValueLabels, toPrimitive, STORYBOARD_SCHEMA,
} from '../engines/animation/storyboard.js';
import { SceneAuthor, structuralStoryboard } from '../engines/animation/author.js';
import { auditScene } from '../engines/animation/compiler.js';
import { renderSvg } from '../engines/animation/svg.js';
import { validate } from '../llm/jsonschema.js';
import { ModelRouter } from '../llm/router.js';

const canvas = { width: 900, height: 520 };

describe('compact encodings', () => {
  test('points, pairs, value-labels', () => {
    assert.deepEqual(parsePoints('0,0 10,20 30,40'), [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 30, y: 40 }]);
    assert.deepEqual(parsePairs('before:4, after:6'), [{ label: 'before', value: 4 }, { label: 'after', value: 6 }]);
    assert.deepEqual(parseValueLabels('1905:special relativity'), [{ value: 1905, label: 'special relativity' }]);
  });

  test('molecules parse and reject out-of-range bonds', () => {
    const atoms = parseAtoms('C:0,0 O:-28,0 O:28,0');
    assert.equal(atoms.length, 3);
    assert.equal(atoms[0].el, 'C');
    assert.equal(parseBonds('0-1:2 0-2:2', 3).length, 2);
    assert.equal(parseBonds('0-9:1', 3).length, 0, 'bond to a non-existent atom must be dropped');
    assert.equal(parseBonds('1-1:1', 3).length, 0, 'self-bond must be dropped');
  });

  test('garbage encodings yield empty lists rather than throwing', () => {
    for (const junk of ['', 'nonsense', '1,2,3,4,5', ':::', 'a:b:c']) {
      assert.doesNotThrow(() => { parsePoints(junk); parsePairs(junk); parseAtoms(junk); parseValueLabels(junk); });
    }
  });
});

describe('element translation', () => {
  test('known kinds build, unknown kinds are rejected', () => {
    const repairs: string[] = [];
    assert.ok(toPrimitive({ id: 'a', kind: 'label', text: 'hi' }, canvas, repairs));
    assert.equal(toPrimitive({ id: 'a', kind: 'teleporter' }, canvas, repairs), null);
  });

  test('a label with no text is dropped rather than drawn empty', () => {
    assert.equal(toPrimitive({ id: 'a', kind: 'label' }, canvas, []), null);
  });

  test('coordinates are clamped to the canvas', () => {
    const p = toPrimitive({ id: 'a', kind: 'circle', x: 99999, y: -99999, r: 20 }, canvas, []) as { x: number; y: number };
    assert.ok(p.x <= canvas.width + 200 && p.y >= -200);
  });

  test('a number line with an absurd step is repaired, not left to draw 10000 ticks', () => {
    const repairs: string[] = [];
    const p = toPrimitive({ id: 'nl', kind: 'numberLine', min: 0, max: 1000, step: 0.001 }, canvas, repairs) as { step: number };
    assert.ok((1000 - 0) / p.step <= 80, `step still produces ${(1000) / p.step} ticks`);
    assert.ok(repairs.some((r) => /step/.test(r)));
  });

  test('a fraction bar can never be shaded beyond its own parts', () => {
    const p = toPrimitive({ id: 'f', kind: 'fractionBar', parts: 4, shaded: 99 }, canvas, []) as { parts: number; shaded: number };
    assert.equal(p.parts, 4);
    assert.equal(p.shaded, 4);
  });

  test('a colour outside the palette falls back rather than emitting raw hex', () => {
    const p = toPrimitive({ id: 'a', kind: 'label', text: 'x', color: 'javascript:alert(1)' }, canvas, []) as { color?: string };
    assert.equal(p.color, undefined);
    const ok = toPrimitive({ id: 'b', kind: 'label', text: 'x', color: 'warn' }, canvas, []) as { color?: string };
    assert.equal(ok.color, 'warn');
  });

  test('structures with no parseable content are dropped with a reason', () => {
    const repairs: string[] = [];
    assert.equal(toPrimitive({ id: 'm', kind: 'molecule', atoms: 'junk' }, canvas, repairs), null);
    assert.equal(toPrimitive({ id: 'b', kind: 'barChart', bars: '' }, canvas, repairs), null);
    assert.equal(toPrimitive({ id: 'p', kind: 'polygon', points: '0,0' }, canvas, repairs), null);
    assert.ok(repairs.length >= 3);
  });
});

describe('storyboard sanitizer', () => {
  const good = {
    title: 'Test', goal: 'Understand it', width: 900, height: 520,
    beats: [
      { say: 'First beat.', show: [{ id: 'a', kind: 'label', text: 'hello', x: 100, y: 100 }] },
      { say: 'Second beat.', show: [{ id: 'b', kind: 'circle', x: 200, y: 200, r: 30 }], animate: [{ target: 'b', channel: 'x', to: 300 }] },
      { say: 'Third beat.', hide: ['a'] },
    ],
  };

  test('a well-formed storyboard passes through intact', () => {
    const s = sanitizeStoryboard(good);
    assert.equal(s.beats.length, 3);
    assert.equal(s.rejected.length, 0);
    assert.equal(s.beats[1].animate!.length, 1);
    assert.equal(s.beats[2].hide!.length, 1);
  });

  test('a beat with no narration is dropped, because it is inaccessible', () => {
    const s = sanitizeStoryboard({ ...good, beats: [...good.beats, { say: '   ', show: [] }] });
    assert.equal(s.beats.length, 3);
    assert.ok(s.rejected.some((r) => /narration/.test(r)));
  });

  test('an animation targeting a non-existent element is rejected, not silently kept', () => {
    const s = sanitizeStoryboard({
      ...good,
      beats: [{ say: 'x', animate: [{ target: 'ghost', channel: 'x', to: 5 }] }, ...good.beats],
    });
    assert.ok(s.rejected.some((r) => /unknown element/.test(r)));
  });

  test('an invalid channel is rejected', () => {
    const s = sanitizeStoryboard({
      ...good,
      beats: [{ say: 'x', show: [{ id: 'z', kind: 'circle', r: 10 }], animate: [{ target: 'z', channel: 'colour', to: 5 }] }],
    });
    assert.ok(s.rejected.some((r) => /not an animatable channel/.test(r)));
  });

  test('duplicate ids are renamed so animations cannot cross-target', () => {
    const s = sanitizeStoryboard({
      ...good,
      beats: [
        { say: 'one', show: [{ id: 'dup', kind: 'circle', r: 10 }] },
        { say: 'two', show: [{ id: 'dup', kind: 'circle', r: 20 }] },
      ],
    });
    assert.ok(s.repairs.some((r) => /duplicate element id/.test(r)));
    const ids = s.beats.flatMap((b) => (b.show ?? []).map((e) => e.id));
    assert.equal(new Set(ids).size, ids.length);
  });

  test('runaway runtime is compressed into the attention budget', () => {
    const s = sanitizeStoryboard({
      ...good,
      beats: Array.from({ length: 8 }, (_, i) => ({ say: `Beat ${i}.`, hold: 40 })),
    });
    const total = s.beats.reduce((a, b) => a + (b.hold ?? 0), 0);
    assert.ok(total <= 111, `runtime not compressed: ${total}s`);
    assert.ok(s.repairs.some((r) => /attention budget/.test(r)));
  });

  test('too many beats and too many elements are trimmed', () => {
    const s = sanitizeStoryboard({
      ...good,
      beats: Array.from({ length: 20 }, () => ({
        say: 'beat', show: Array.from({ length: 30 }, (_, j) => ({ id: `e${j}`, kind: 'circle', r: 5 })),
      })),
    });
    assert.ok(s.beats.length <= 8);
    assert.ok(s.beats.every((b) => (b.show ?? []).length <= 8));
  });

  test('total garbage produces an empty but valid result, never a throw', () => {
    for (const junk of [null, undefined, 42, 'hello', [], { beats: 'no' }, { beats: [null, 3] }]) {
      assert.doesNotThrow(() => {
        const s = sanitizeStoryboard(junk);
        assert.ok(Array.isArray(s.beats));
      }, `threw on ${JSON.stringify(junk)}`);
    }
  });

  test('a sanitized storyboard always compiles and renders', () => {
    const s = sanitizeStoryboard(good);
    const scene = compileStoryboard(s);
    assert.ok(scene.durationSec > 0);
    assert.equal(scene.narration.length, 3);
    const svg = renderSvg(scene, { showCaptions: true });
    assert.ok(svg.startsWith('<svg'));
    assert.ok(svg.includes('</svg>'));
  });
});

describe('scene author', () => {
  const router = new ModelRouter();
  const author = new SceneAuthor(router);

  test('a curated concept uses the hand-tuned builder', async () => {
    const r = await author.author({ topic: 'Adding fractions', conceptSlug: 'fraction-addition', grade: 5 });
    assert.equal(r.source, 'curated');
    assert.ok(r.audit.ok);
  });

  test('an unmapped concept still produces an audited, renderable scene', async () => {
    const r = await author.author({
      topic: 'Supply and demand',
      description: 'When the price of a good rises, producers want to sell more of it. '
        + 'At the same time buyers want to buy less of it. The price where those two quantities '
        + 'match is called the equilibrium price. If the price sits above equilibrium there is a surplus.',
      subject: 'economics',
      grade: 9,
    });
    assert.ok(['model', 'model_repaired', 'offline_structural'].includes(r.source), `unexpected source ${r.source}`);
    assert.ok(r.scene.narration.length >= 3, 'every scene must be narrated');
    assert.ok(r.scene.durationSec > 3);
    const svg = renderSvg(r.scene, { showCaptions: true });
    assert.ok(svg.startsWith('<svg'));
  });

  test('mode "model" bypasses the curated builder entirely', async () => {
    const r = await author.author({ topic: 'Adding fractions', conceptSlug: 'fraction-addition', mode: 'model' });
    assert.notEqual(r.source, 'curated');
  });

  test('the structural fallback says only what the source text said', () => {
    const sb = structuralStoryboard({
      topic: 'Osmosis',
      description: 'Water moves across a membrane from low concentration to high concentration. This needs no energy.',
      keyTerms: ['membrane', 'concentration'],
    });
    const joined = sb.beats.map((b) => b.say).join(' ');
    assert.match(joined, /Osmosis/);
    assert.match(joined, /membrane/);
    assert.ok(sb.beats.every((b) => b.say.trim().length > 0));
    const scene = compileStoryboard(sanitizeStoryboard(sb));
    assert.ok(auditScene(scene).ok, `structural fallback failed its own audit: ${auditScene(scene).issues.join('; ')}`);
  });

  test('the structural fallback copes with no description at all', () => {
    const scene = compileStoryboard(sanitizeStoryboard(structuralStoryboard({ topic: 'Entropy' })));
    assert.ok(scene.narration.length >= 2);
    assert.ok(auditScene(scene).ok);
  });

  test('reduced motion produces a scene with no travel', async () => {
    const r = await author.author({ topic: 'Tides', description: 'The Moon pulls the ocean toward it.', reduceMotion: true });
    for (const node of r.scene.nodes) {
      for (const track of node.tracks) {
        assert.ok(track.keyframes.length <= 1, 'reduced motion should collapse tracks to a single state');
      }
    }
  });

  test('prompt scaffolding never leaks into learner-facing narration', async () => {
    // Regression: the offline fallback once derived "key terms" from the whole
    // assembled prompt, which contains the primitive guide - so learners were
    // told the key vocabulary was "charge neutral label spring".
    const r = await author.author({
      topic: 'The Treaty of Versailles',
      description: 'The treaty ended the First World War in 1919. It forced Germany to accept blame and pay reparations.',
      grade: 9,
      mode: 'model',
    });
    const spoken = r.scene.narration.map((n) => n.text).join(' ').toLowerCase();
    for (const leaked of ['svg', 'primitive', 'storyboard', 'fractionbar', 'anchor:start', 'angledeg', 'json', 'canvas is 900']) {
      assert.ok(!spoken.includes(leaked), `prompt scaffolding leaked into narration: "${leaked}" in ${spoken.slice(0, 200)}`);
    }
    assert.match(spoken, /treaty|versailles|germany|war/);
  });

  test('a long scene is chaptered, never sped up, for a short attention block', async () => {
    const { segmentScene } = await import('../engines/animation/compiler.js');
    const r = await author.author({ topic: 'Adding fractions', conceptSlug: 'fraction-addition', grade: 5 });
    const before = r.scene.durationSec;
    const segments = segmentScene(r.scene, 20);
    assert.ok(segments.length > 1, 'a 57s scene should chapter into a 20s attention block');
    assert.equal(r.scene.durationSec, before, 'chaptering must not alter the scene timing');
    // Chapters must tile the scene with no gaps and no overlaps.
    assert.equal(segments[0].startSec, 0);
    for (let i = 1; i < segments.length; i++) {
      assert.equal(segments[i].startSec, segments[i - 1].endSec, 'chapters must tile without gaps');
    }
    assert.equal(segments[segments.length - 1].endSec, r.scene.durationSec);
    assert.ok(segments.every((s) => s.narration.length > 0), 'every chapter must carry narration');
    assert.ok(segments.reduce((a, s) => a + s.beats, 0) === r.scene.narration.length, 'no beat may be lost');
  });

  test('a short scene yields exactly one chapter', async () => {
    const { segmentScene } = await import('../engines/animation/compiler.js');
    const r = await author.author({ topic: 'Entropy', mode: 'model' });
    assert.equal(segmentScene(r.scene, 600).length, 1);
  });

  test('the exemplar in the prompt is itself valid against the schema', async () => {
    const { _internals } = await import('../engines/animation/author.js');
    const parsed = JSON.parse(_internals.EXEMPLAR);
    const issues = validate(parsed, STORYBOARD_SCHEMA);
    const fatal = issues.filter((i) => /missing required|expected/.test(i.message));
    assert.equal(fatal.length, 0, `exemplar violates its own schema: ${fatal.map((f) => `${f.path} ${f.message}`).join('; ')}`);
    const scene = compileStoryboard(sanitizeStoryboard(parsed));
    assert.ok(auditScene(scene).ok, 'the exemplar must pass the same audit we demand of the model');
  });
});
