// What a node says about the document-level triples it takes part in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docTagText, docTagsOf } from '../src/domain/sentenceGraph.js';

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

// A small document: an author, an event in each of three sentences, and an
// entity in the first that the third refers back to.
const graphOf = () => {
  const node = (id, v, sentence, constant = false) => ({
    id,
    var: v,
    sentence,
    constant,
    docOut: [],
    docIn: [],
  });
  const nodes = [
    node('author', 'author', null, true),
    node('e1', 's1e', 1),
    node('p1', 's1p', 1),
    node('e2', 's2e', 2),
    node('e3', 's3e', 3),
    node('p3', 's3p', 3),
  ];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const triple = (id, source, rel, target, group) => {
    const t = { id, source, target, rel, group };
    byId.get(source).docOut.push(t);
    byId.get(target).docIn.push(t);
  };
  triple('t1', 'e3', ':after', 'e1', 'temporal');
  triple('t2', 'e3', ':after', 'e2', 'temporal');
  triple('t3', 'author', ':full-affirmative', 'e3', 'modal');
  triple('t4', 'p3', ':same-entity', 'p1', 'coref');
  triple('t5', 'e3', ':overlap', 'p3', 'temporal');
  return byId;
};

test('the earlier end of a cross-sentence triple wears it too', () => {
  const byId = graphOf();
  const e1 = docTagsOf(byId.get('e1'), byId);
  assert.deepEqual(
    e1.map((t) => [t.text, t.cross]),
    [['s3e :after', true]],
  );
  const p1 = docTagsOf(byId.get('p1'), byId);
  assert.deepEqual(
    p1.map((t) => t.text),
    ['s3p :same-entity'],
  );
});

test('a constant first, then the same sentence, then the nearest sentence', () => {
  const byId = graphOf();
  assert.deepEqual(
    docTagsOf(byId.get('e3'), byId).map((t) => t.text),
    ['author :full-affirmative', ':overlap s3p', ':after s2e', ':after s1e'],
  );
});
