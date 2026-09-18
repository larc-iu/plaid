import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeRow, layoutSentence } from '../src/domain/umrLayout.js';

const noOverlap = (positions, items, gap) => {
  const sorted = [...items].sort((a, b) => positions.get(a.id) - positions.get(b.id));
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    const aRight = positions.get(a.id) + a.width / 2;
    const bLeft = positions.get(b.id) - b.width / 2;
    assert.ok(bLeft >= aRight + gap - 1e-6, `${a.id} and ${b.id} overlap`);
  }
};

test('a row with room leaves every node at its preference', () => {
  const items = [
    { id: 'a', pref: 0, tie: 0, width: 40 },
    { id: 'b', pref: 100, tie: 1, width: 40 },
    { id: 'c', pref: 200, tie: 2, width: 40 },
  ];
  const xs = placeRow(items, 10);
  assert.deepEqual([...xs.values()], [0, 100, 200]);
});

test('two nodes over one token part symmetrically', () => {
  const items = [
    { id: 'a', pref: 100, tie: 0, width: 40 },
    { id: 'b', pref: 100, tie: 1, width: 40 },
  ];
  const xs = placeRow(items, 10);
  assert.equal(xs.get('a'), 75);
  assert.equal(xs.get('b'), 125);
  noOverlap(xs, items, 10);
});

test('a crowded row spreads without overlap and keeps order', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    id: `n${i}`,
    pref: 30 * i + (i % 3) * 5,
    tie: i,
    width: 50 + (i % 4) * 10,
  }));
  const xs = placeRow(items, 8);
  noOverlap(xs, items, 8);
  const order = items.map((it) => xs.get(it.id));
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
});

// A three-node sentence: leave-02 :ARG0 person :purpose eat-01, eat-01 :ARG0
// person (re-entrant).
const sentenceFixture = () => {
  const words = [
    { id: 'w1', index: 1, begin: 0, end: 7 },
    { id: 'w2', index: 2, begin: 8, end: 12 },
    { id: 'w3', index: 3, begin: 13, end: 16 },
  ];
  const mk = (id, v, concept, wordIds, sentence = 1) => ({
    id,
    var: v,
    concept,
    wordIds,
    pieces: [{ begin: 0, end: 1 }],
    sentence,
    out: [],
    in: [],
    attrs: [],
  });
  const leave = mk('n1', 's1l', 'leave-02', ['w2']);
  const person = mk('n2', 's1p', 'person', []);
  const eat = mk('n3', 's1e', 'eat-01', ['w3']);
  const e1 = { id: 'e1', source: 'n1', target: 'n2', role: ':ARG0', order: 0 };
  const e2 = { id: 'e2', source: 'n1', target: 'n3', role: ':purpose', order: 1 };
  const e3 = { id: 'e3', source: 'n3', target: 'n2', role: ':ARG0', order: 0 };
  leave.out.push(e1, e2);
  person.in.push(e1, e3);
  eat.in.push(e2);
  eat.out.push(e3);
  const nodesById = new Map([
    ['n1', leave],
    ['n2', person],
    ['n3', eat],
  ]);
  const sentence = {
    index: 1,
    words,
    nodes: [leave, person, eat],
    edges: [e1, e2, e3],
    roots: [leave],
  };
  return { sentence, nodesById };
};

test('layout rows follow tree depth and marks the re-entrant edge', () => {
  const { sentence, nodesById } = sentenceFixture();
  const columns = new Map([
    ['w1', { x: 40 }],
    ['w2', { x: 120 }],
    ['w3', { x: 200 }],
  ]);
  const layout = layoutSentence(sentence, nodesById, { columns, sizes: new Map(), sentenceX: 40 });
  assert.equal(layout.nodes.get('n1').row, 0);
  assert.equal(layout.nodes.get('n2').row, 1);
  assert.equal(layout.nodes.get('n3').row, 1);
  // The predicate sits over its own word.
  assert.equal(layout.nodes.get('n1').x, 120);
  const byId = Object.fromEntries(layout.edges.map((e) => [e.id, e]));
  assert.equal(byId.e1.tree, true);
  assert.equal(byId.e2.tree, true);
  assert.equal(byId.e3.tree, false);
  assert.equal(layout.rows, 2);
});
