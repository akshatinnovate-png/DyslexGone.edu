import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simplify, splitLongSentence } from '../accessibility/simplify.js';
import { analyzeReadability } from '../accessibility/readability.js';

/** Every piece a splitter emits must be a sentence. A fragment is a harder
 *  read than the long sentence it came from, so these assertions matter more
 *  than the grade-level drop. */
function assertNoFragments(text: string): void {
  for (const piece of text.split(/(?<=[.!?])\s+/).filter(Boolean)) {
    const body = piece.replace(/^[-\s]+/, '');
    if (!body) continue;
    // "Since X, Y." is a complete sentence; "Since X." is a fragment. The
    // difference is whether a main clause follows the subordinate one.
    assert.ok(
      !/^(?:since|because|although|though|whereas|unless|until|whereby|wherein)\b/i.test(body) || body.includes(','),
      `dependent clause left standing alone: "${body}"`,
    );
    assert.ok(
      !/^(?:in|on|at|by|with|from|of|during|through|within|throughout)\s/i.test(body),
      `prepositional phrase left standing alone: "${body}"`,
    );
    assert.ok(/[a-z]/i.test(body), `empty piece: "${piece}"`);
  }
}

test('simplify', async (t) => {
  await t.test('splits a mechanism clause introduced by "whereby"', () => {
    const r = simplify(
      'Photosynthesis is utilized by plants, whereby light energy is converted into chemical energy which is subsequently stored in glucose molecules.',
      5,
    );
    assert.ok(r.after.grade < r.before.grade - 5, `expected a large drop, got ${r.before.grade} -> ${r.after.grade}`);
    assert.ok(r.text.split(/[.!?]/).filter((s) => s.trim()).length >= 3, r.text);
    assertNoFragments(r.text);
  });

  await t.test('promotes a restrictive relative clause even without a comma', () => {
    const pieces = splitLongSentence(
      'The cell makes a molecule which is used by every other process in the body today',
      12,
    );
    assert.ok(pieces.length > 1, 'expected a split');
    assert.ok(pieces.some((p) => /^This is/i.test(p.trim())), pieces.join(' | '));
  });

  await t.test('leads with the claim when a subordinate clause is fronted', () => {
    const r = simplify(
      'Since the denominator represents the number of equal parts, you cannot add denominators when you add two fractions together.',
      5,
    );
    assertNoFragments(r.text);
    assert.match(r.text, /^You cannot add denominators/, r.text);
    assert.ok(r.after.grade < r.before.grade, `${r.before.grade} -> ${r.after.grade}`);
  });

  await t.test('never strands a trailing prepositional phrase', () => {
    const r = simplify(
      'The mitochondria generate adenosine triphosphate, which is the molecule that cells use for energy, in a process that requires oxygen.',
      5,
    );
    assertNoFragments(r.text);
  });

  await t.test('keeps a defining clause attached to the noun it defines', () => {
    const input = 'Plants that photosynthesise need light to grow properly in the summer months.';
    assert.equal(simplify(input, 5).text, input);
  });

  await t.test('invents no non-words when turning passive into active', () => {
    const r = simplify('The data is utilized by researchers and the results are published by the journal.', 6);
    assert.match(r.text, /researchers use/i);
    assert.doesNotMatch(r.text, /\butiliz(?:s|es by)\b/i);
  });

  await t.test('reports the grade it actually achieved', () => {
    const r = simplify('The photosynthetic apparatus converts electromagnetic radiation into chemical potential energy.', 5);
    assert.equal(r.after.grade, analyzeReadability(r.text, 5).gradeLevel);
  });
});
