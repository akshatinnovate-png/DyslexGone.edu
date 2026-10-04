import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extract, extractHtml, extractMarkdown, extractCsv, parseCsv, decodeEntities, structureReport } from '../ingestion/extract.js';
import { IngestionPipeline, inferSubject } from '../ingestion/pipeline.js';
import { memoryDb } from '../db/sqlite.js';
import { makeRepos } from '../db/repos.js';
import { GraphService, seedCurriculum } from '../graph/service.js';
import { AssessmentService } from '../assessment/service.js';
import { router } from '../llm/router.js';

const setup = () => {
  const db = memoryDb();
  const repos = makeRepos(db);
  const graph = new GraphService(repos);
  seedCurriculum(repos, graph);
  return { repos, graph, pipe: new IngestionPipeline(repos, graph, new AssessmentService(repos), router) };
};

describe('extraction', () => {
  test('markdown keeps heading levels and separates lists and code', () => {
    const e = extractMarkdown('# Title\n\nSome prose here.\n\n## Sub\n\n- one\n- two\n\n```js\ncode();\n```\n');
    assert.equal(e.title, 'Title');
    assert.equal(e.blocks.filter((b) => b.kind === 'heading').length, 2);
    assert.equal(e.blocks.find((b) => b.kind === 'heading')!.level, 1);
    assert.equal(e.blocks.filter((b) => b.kind === 'list').length, 2);
    assert.ok(!e.text.includes('code()'), 'code must not pollute the prose');
  });

  test('html strips scripts and styles before anything else', () => {
    const e = extractHtml('<html><head><title>T</title><style>.a{color:red}</style></head>'
      + '<body><h2>Head</h2><p>Hello world.</p><script>alert(1)</script></body></html>');
    assert.equal(e.title, 'T');
    assert.ok(!e.text.includes('alert'), 'script content leaked into the text');
    assert.ok(!e.text.includes('color:red'), 'style content leaked into the text');
    assert.ok(e.text.includes('Hello world'));
    assert.equal(e.blocks.find((b) => b.kind === 'heading')!.text, 'Head');
  });

  test('html entities are decoded', () => {
    assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#65; &#x42; &nbsp;d'), 'a & b <c> A B  d');
    const e = extractHtml('<p>5 &lt; 10 &amp; 10 &gt; 5</p>');
    assert.ok(e.text.includes('5 < 10 & 10 > 5'));
  });

  test('csv parses quotes, escaped quotes and embedded newlines', () => {
    const rows = parseCsv('a,b\n"x, y","he said ""hi"""\n"multi\nline",z\n');
    assert.deepEqual(rows[1], ['x, y', 'he said "hi"']);
    assert.equal(rows[2][0], 'multi\nline');
  });

  test('a worksheet csv becomes question blocks with answers', () => {
    const e = extractCsv('question,answer\n"What is 2+2?",4\n"Name the gas",oxygen\n');
    const qs = e.blocks.filter((b) => b.kind === 'question');
    assert.equal(qs.length, 2);
    assert.equal(qs[0].meta?.answer, '4');
  });

  test('numbered exercises are recognised as questions, not list noise', () => {
    const e = extractMarkdown('## Exercises\n\n1. Calculate the current when 12 V is applied.\n2. Why does a longer wire resist more?\n');
    assert.equal(structureReport(e).questions, 2);
  });

  test('auto-detection picks the right parser', () => {
    assert.equal(extract('<p>hi there</p>').kind, 'html');
    assert.equal(extract('# Heading\n\ntext').kind, 'markdown');
    assert.equal(extract('a,b,c\n1,2,3\n4,5,6').kind, 'csv');
    assert.equal(extract('Just some ordinary prose about things.').kind, 'text');
  });

  test('a compressed PDF says so rather than returning silence', () => {
    const e = extract(Buffer.from('%PDF-1.4\n/Filter /FlateDecode\nstream\n\u0001\u0002\nendstream'), 'pdf');
    assert.equal(e.wordCount, 0);
    assert.ok(e.unsupported.length > 0);
    assert.match(e.unsupported[0], /compressed/i);
  });

  test('an uncompressed PDF text layer is read', () => {
    const pdf = '%PDF-1.4\n1 0 obj\n<< >>\nstream\nBT (Photosynthesis uses light energy.) Tj ET\n'
      + 'BT [(Plants) -250 (build) -250 (glucose.)] TJ ET\nendstream\n/Type /Page\n%%EOF';
    const e = extract(Buffer.from(pdf, 'latin1'), 'pdf');
    assert.match(e.text, /Photosynthesis uses light energy/);
    assert.match(e.text, /Plantsbuildglucose|Plants.*glucose/);
  });

  test('images and audio state what they would need, rather than failing silently', () => {
    const img = extract(Buffer.from([0x89, 0x50]), 'image');
    assert.match(img.unsupported[0], /optical character recognition/i);
    const aud = extract('', 'audio');
    assert.match(aud.unsupported[0], /speech recognition/i);
  });

  test('extraction never throws on hostile input', () => {
    const nasties = ['', '<<<<>>>>', '"'.repeat(500), '\u0000\u0001', '<p>'.repeat(2000), ','.repeat(500)];
    for (const n of nasties) {
      assert.doesNotThrow(() => extract(n), `threw on ${n.slice(0, 20)}`);
    }
  });
});

describe('subject inference', () => {
  test('identifies subjects from vocabulary', () => {
    assert.equal(inferSubject('The numerator and denominator of a fraction, and the quotient after you divide.'), 'math');
    assert.equal(inferSubject('Force equals mass times acceleration, and momentum is conserved.'), 'physics');
    assert.equal(inferSubject('The cell membrane controls what enters. DNA holds the gene sequence.'), 'biology');
  });

  test('falls back to general rather than guessing', () => {
    assert.equal(inferSubject('Some words about nothing in particular at all today.'), 'general');
  });
});

describe('ingestion pipeline', () => {
  const chapter = `# Chapter 7: Electricity

## Electric Current
An electric current is the rate at which charge flows past a point in a circuit. It is measured in amperes.

## Resistance
Resistance opposes the flow of charge and is measured in ohms. The resistance of a wire is subsequently increased by lengthening it, and consequently a longer wire permits less current for a given potential difference.

1. Calculate the current when 12 V is applied across 4 ohms.
`;

  test('a chapter becomes concepts, links, hard sections and items', async () => {
    const { pipe } = setup();
    const r = await pipe.ingest({ content: chapter, subject: 'physics', grade: 8 });
    assert.ok(r.documentId);
    assert.ok(r.concepts.length >= 2);
    assert.ok(r.itemsGenerated > 0, 'ingested concepts must be assessable');
    assert.ok(r.hardSections.length > 0, 'the 30-word passive sentence should be flagged');
    assert.ok(r.headline.length > 40);
    assert.equal(r.questionsFound.length, 1);
  });

  test('the document title is not mistaken for a teachable concept', async () => {
    const { pipe } = setup();
    const r = await pipe.ingest({ content: chapter, subject: 'physics', grade: 8 });
    assert.ok(!r.concepts.some((c) => /chapter 7/i.test(c.label)),
      `document title became a concept: ${r.concepts.map((c) => c.label).join(', ')}`);
  });

  test('a concept already in the graph is matched, not duplicated', async () => {
    const { repos, pipe } = setup();
    const before = repos.concepts.count();
    const r = await pipe.ingest({ content: chapter, subject: 'physics', grade: 8 });
    const matched = r.concepts.filter((c) => !c.created);
    assert.ok(matched.length >= 1, 'Electric Current should match the seeded concept');
    assert.ok(repos.concepts.count() - before < r.concepts.length, 'matching should avoid creating every concept');
  });

  test("section vocabulary does not bleed across headings", async () => {
    const { pipe } = setup();
    const r = await pipe.ingest({ content: chapter, subject: 'physics', grade: 8 });
    const current = r.concepts.find((c) => /current/i.test(c.label));
    const resistance = r.concepts.find((c) => /resistance/i.test(c.label));
    if (current && resistance) {
      const shared = current.keyTerms.filter((t) => resistance.keyTerms.includes(t));
      assert.ok(shared.length <= 1, `sections share too much vocabulary: ${shared.join(', ')}`);
    }
  });

  test('ingestion never creates a cycle in the curated graph', async () => {
    const { graph, pipe } = setup();
    await pipe.ingest({ content: chapter, subject: 'physics', grade: 8 });
    await pipe.ingest({ content: chapter, subject: 'physics', grade: 8 });
    assert.equal(graph.health().cycles.length, 0);
  });

  test('an empty upload is reported honestly, not written to the graph', async () => {
    const { repos, pipe } = setup();
    const before = repos.concepts.count();
    const r = await pipe.ingest({ content: '   ' });
    assert.equal(r.documentId, '');
    assert.equal(r.concepts.length, 0);
    assert.equal(repos.concepts.count(), before);
    assert.match(r.headline, /no readable text/i);
  });

  test('an unsupported upload explains what it would need', async () => {
    const { pipe } = setup();
    const r = await pipe.ingest({ content: Buffer.from([0x89, 0x50, 0x4e, 0x47]), kind: 'image' });
    assert.ok(r.unsupported.length > 0);
    assert.match(r.headline, /optical character recognition/i);
  });

  test('an accessibility preview reports the actual reading-level change', async () => {
    const { pipe } = setup();
    const r = await pipe.ingest({ content: chapter, subject: 'physics', grade: 6, previewNeeds: ['dyslexia'] });
    assert.ok(r.accessibilityPreview);
    assert.ok(r.accessibilityPreview!.gradeAfter < r.accessibilityPreview!.gradeBefore,
      'the preview should show the text getting easier');
    assert.ok(r.accessibilityPreview!.appliedTransforms.length > 3);
  });

  test('document and chunks are persisted for later citation', async () => {
    const { repos, pipe } = setup();
    const r = await pipe.ingest({ content: chapter, subject: 'physics', grade: 8 });
    const doc = repos.db.one('SELECT * FROM documents WHERE id=?', [r.documentId]);
    assert.ok(doc);
    const chunks = repos.db.all('SELECT * FROM doc_chunks WHERE document_id=?', [r.documentId]);
    assert.ok(chunks.length >= 4);
  });
});
