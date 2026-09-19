// What a node says about the document-level triples it takes part in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docTagText } from '../src/domain/sentenceGraph.js';

// `(author :full-affirmative s1l)`: the constant is the SOURCE, which is
// nearly every triple with a constant in it.
test('a tag reads the triple in its own order, leaving the node out', () => {
  const fromConstant = { source: 'c-author', target: 'n1', rel: ':full-affirmative' };
  assert.equal(docTagText(fromConstant, 'n1', 'author'), 'author :full-affirmative');

  // The other way round: the node is the source, so the relation comes first
  // and the constant after it. Reading this one constant-first reversed what
  // the annotation says.
  const toConstant = { source: 'n1', target: 'c-dct', rel: ':before' };
  assert.equal(
    docTagText(toConstant, 'n1', 'document-creation-time'),
    ':before document-creation-time',
  );
});

test('both ends of a node-to-node triple read it the same way', () => {
  const t = { source: 'n1', target: 'n2', rel: ':before' };
  assert.equal(docTagText(t, 'n1', 's1e'), ':before s1e');
  assert.equal(docTagText(t, 'n2', 's1l'), 's1l :before');
});
