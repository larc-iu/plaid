// Pure-fn tests for the review sweep's stops (domain/reviewTargets.js). The
// grid is virtualized, so these read sentence data rather than the DOM; that is
// the whole point of the module and the reason it can be tested at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsReview, isMachine } from '@larc-iu/plaid-client';

import {
  wordsInOrder,
  reviewWords,
  adjacentWord,
  nextReviewWord,
  markedFields,
  findWord,
  wordHasMaterial,
} from '../src/domain/reviewTargets.js';

const machine = { prov: 'inferred', provSource: 'service:p' };
const contributed = { prov: 'contributed', provSource: 'user:u1' };
const verified = { ...machine, provConfirmed: true };

// A word: id, plus whichever spans it carries. Spans are `{ id, metadata }`,
// which is all these functions read.
const word = (id, { lemma, upos, feats = [] } = {}) => ({
  token: { id },
  form: null,
  lemma: lemma === undefined ? null : { id: `${id}-lem`, metadata: lemma },
  upos: upos === undefined ? null : { id: `${id}-up`, metadata: upos },
  xpos: null,
  feats: feats.map((m, i) => ({ id: `${id}-f${i}`, metadata: m })),
});

const doc = [
  {
    id: 's1',
    tokens: [word('w1'), word('w2', { upos: machine }), word('w3', { upos: {} })],
    relations: [],
  },
  {
    id: 's2',
    // w5's incoming relation is machine-made; nothing else on it is.
    tokens: [word('w4', { upos: verified }), word('w5', { lemma: {} }), word('w6')],
    relations: [{ id: 'r1', source: 'w4-lem', target: 'w5-lem', metadata: machine }],
  },
];

test('wordsInOrder reads every word in every sentence, in order', () => {
  assert.deepEqual(
    wordsInOrder(doc).map((w) => w.tokenId),
    ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'],
  );
  assert.deepEqual(wordsInOrder(doc)[3], { sentenceId: 's2', tokenId: 'w4' });
  assert.deepEqual(wordsInOrder(undefined), []);
});

test('reviewWords stops at unreviewed spans and unreviewed incoming relations', () => {
  assert.deepEqual(
    reviewWords(doc, needsReview).map((w) => w.tokenId),
    ['w2', 'w5'],
  );
});

test('reviewWords skips confirmed material', () => {
  // w4's only annotation is machine-made AND confirmed, so it is settled.
  assert.ok(!reviewWords(doc, needsReview).some((w) => w.tokenId === 'w4'));
});

test('reviewWords narrows for a contributor, who reviews machine work only', () => {
  const contributedDoc = [
    {
      id: 's1',
      tokens: [word('a', { upos: contributed }), word('b', { upos: machine })],
      relations: [],
    },
  ];
  assert.deepEqual(
    reviewWords(contributedDoc, needsReview).map((w) => w.tokenId),
    ['a', 'b'],
  );
  assert.deepEqual(
    reviewWords(contributedDoc, isMachine).map((w) => w.tokenId),
    ['b'],
  );
});

test('reviewWords counts a feature span', () => {
  const featsDoc = [{ id: 's', tokens: [word('a', { feats: [{}, machine] })], relations: [] }];
  assert.deepEqual(
    reviewWords(featsDoc, needsReview).map((w) => w.tokenId),
    ['a'],
  );
});

test('adjacentWord crosses the sentence boundary and stops at the ends', () => {
  assert.equal(adjacentWord(doc, 'w3').tokenId, 'w4');
  assert.equal(adjacentWord(doc, 'w4', 'previous').tokenId, 'w3');
  assert.equal(adjacentWord(doc, 'w6'), null);
  assert.equal(adjacentWord(doc, 'w1', 'previous'), null);
  assert.equal(adjacentWord(doc, 'nope'), null);
});

test('nextReviewWord walks the stops from wherever the caret is', () => {
  assert.equal(nextReviewWord(doc, needsReview, 'w1').tokenId, 'w2');
  assert.equal(nextReviewWord(doc, needsReview, 'w2').tokenId, 'w5');
  assert.equal(nextReviewWord(doc, needsReview, 'w5'), null);
  assert.equal(nextReviewWord(doc, needsReview, 'w5', 'previous').tokenId, 'w2');
  // From a word with nothing to review: the next stop past it, not the first.
  assert.equal(nextReviewWord(doc, needsReview, 'w3').tokenId, 'w5');
  assert.equal(nextReviewWord(doc, needsReview, 'w4', 'previous').tokenId, 'w2');
  // Caret outside the grid: start from the appropriate end.
  assert.equal(nextReviewWord(doc, needsReview, null).tokenId, 'w2');
  assert.equal(nextReviewWord(doc, needsReview, null, 'previous').tokenId, 'w5');
  // Nothing to review at all.
  assert.equal(
    nextReviewWord(doc, () => false, 'w1'),
    null,
  );
});

test('markedFields names the cells that earned the stop, in grid order', () => {
  const entry = word('a', { lemma: machine, upos: {}, feats: [{}, machine] });
  assert.deepEqual(markedFields(entry, needsReview), ['lemma', 'feats']);
  assert.deepEqual(markedFields(word('b'), needsReview), []);
  assert.deepEqual(markedFields(null, needsReview), []);
  // A contributor does not review a colleague's work, so it is not a stop.
  const theirs = word('c', { lemma: contributed });
  assert.deepEqual(markedFields(theirs, needsReview), ['lemma']);
  assert.deepEqual(markedFields(theirs, isMachine), []);
});

test('findWord reaches into any sentence', () => {
  assert.equal(findWord(doc, 'w5').token.id, 'w5');
  assert.equal(findWord(doc, 'nope'), null);
});

test('wordHasMaterial sees the incoming relation, which is not one of the cells', () => {
  // w5 carries a plain lemma and nothing else; its head was the parser's guess.
  assert.deepEqual(markedFields(findWord(doc, 'w5'), needsReview), []);
  assert.equal(wordHasMaterial(doc, 'w5', needsReview), true);
  assert.equal(wordHasMaterial(doc, 'w5', isMachine), true);
  // w4 heads that relation but its own material is confirmed, so it is settled.
  assert.equal(wordHasMaterial(doc, 'w4', needsReview), false);
  assert.equal(wordHasMaterial(doc, 'w2', needsReview), true);
  assert.equal(wordHasMaterial(doc, 'w1', needsReview), false);
  assert.equal(wordHasMaterial(doc, 'nope', needsReview), false);
});

test("wordHasMaterial and the discard gesture spare a contributor's work", () => {
  const theirs = [{ id: 's', tokens: [word('a', { upos: contributed })], relations: [] }];
  // A verifier reviews it, so Ctrl+Enter acts. Discard takes machine material
  // only, so Ctrl+Backspace does not.
  assert.equal(wordHasMaterial(theirs, 'a', needsReview), true);
  assert.equal(wordHasMaterial(theirs, 'a', isMachine), false);
});
