// What a save of the Text Editor deletes on this editor's own layers (R44):
// the tokens wholly inside a removed stretch, their words, the annotations on
// those words and the dependency relations attached to them, each counted
// once.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { withOps } from './helpers/stubClient.js';

// she 0-3, came 4-8, and 9-12, left 13-17, home 18-22, . 23-24
const INPUT = [
  '# text = she came and left home .',
  '1\tshe\tshe\tPRON\t_\t_\t2\tnsubj\t_\t_',
  '2\tcame\tcome\tVERB\t_\t_\t0\troot\t_\t_',
  '3\tand\tand\tCCONJ\t_\t_\t4\tcc\t_\t_',
  '4\tleft\tleave\tVERB\t_\t_\t2\tconj\t_\t_',
  '5\thome\thome\tNOUN\t_\t_\t4\tobj\t_\t_',
  '6\t.\t_\t_\t_\t_\t_\t_\t_\t_',
].join('\n');

// del 0-3 as two words, de + el, perro 4-9.
const MWT = [
  '# text = del perro',
  '1-2\tdel\t_\t_\t_\t_\t_\t_\t_\t_',
  '1\tde\tde\tADP\t_\t_\t3\tcase\t_\t_',
  '2\tel\tel\tDET\t_\t_\t3\tdet\t_\t_',
  '3\tperro\tperro\tNOUN\t_\t_\t0\troot\t_\t_',
].join('\n');

const open = (input = INPUT) => {
  const raw = rawDocFromConllu(input, 'w');
  return new ConlluDocument({ raw: structuredClone(raw), client: withOps({}) });
};

test('a token typed over whole goes with its word, its annotations and its relations', () => {
  // left: lemma leave, UPOS VERB, its head conj and two dependents.
  assert.deepEqual(open().textDeleteLoss([[13, 17]]), {
    tokens: 1,
    words: 1,
    annotations: 2,
    relations: 3,
  });
});

test('a relation between two tokens that go is counted once', () => {
  // and + left: CCONJ (lemma and repeats the form), leave and VERB, and the
  // relations cc, conj and obj.
  assert.deepEqual(open().textDeleteLoss([[9, 17]]), {
    tokens: 2,
    words: 2,
    annotations: 3,
    relations: 3,
  });
});

test('a stretch that only cuts a token, or takes only a space, deletes nothing', () => {
  const none = { tokens: 0, words: 0, annotations: 0, relations: 0 };
  assert.deepEqual(open().textDeleteLoss([[14, 16]]), none);
  assert.deepEqual(open().textDeleteLoss([[3, 4]]), none);
  assert.deepEqual(open().textDeleteLoss([]), none);
});

test("a multi-word token goes with every word and every word's form", () => {
  // de and el: ADP and DET, their two Form spans, and case and det.
  assert.deepEqual(open(MWT).textDeleteLoss([[0, 3]]), {
    tokens: 1,
    words: 2,
    annotations: 4,
    relations: 2,
  });
});
