// What a save of the Text Editor deletes on this editor's own layers (R44):
// the tokens wholly inside a removed stretch, their words, the annotations on
// those words and the dependency relations attached to them, each counted
// once.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { withOps } from './helpers/stubClient.js';
import { removedStretches } from '../../plaid-ui/src/lib/editLog.js';

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
    sentences: 0,
    sentenceFields: 0,
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
    sentences: 0,
    sentenceFields: 0,
  });
});

test('a stretch that only cuts a token, or takes only a space, deletes nothing', () => {
  const none = {
    tokens: 0,
    words: 0,
    annotations: 0,
    relations: 0,
    sentences: 0,
    sentenceFields: 0,
  };
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
    sentences: 0,
    sentenceFields: 0,
  });
});

// Two sentences, `hi .` 0-4 and `bye .` 5-10, the first with a note.
const TWO = [
  '# sent_id = s1',
  '# note = greeting',
  '# text = hi .',
  '1\thi\thi\tINTJ\t_\t_\t0\troot\t_\t_',
  '2\t.\t.\tPUNCT\t_\t_\t1\tpunct\t_\t_',
  '',
  '# sent_id = s2',
  '# text = bye .',
  '1\tbye\tbye\tINTJ\t_\t_\t0\troot\t_\t_',
  '2\t.\t.\tPUNCT\t_\t_\t1\tpunct\t_\t_',
].join('\n');

test('a sentence a stretch covers whole goes with its fields, and one typed over exactly stays (R45)', () => {
  const doc = open(TWO);
  const [s1] = doc.layerInfo.sentenceTokenLayer.tokens;
  // the first sentence and more: it goes, with its note
  const gone = doc.textDeleteLoss([[s1.begin, s1.end + 1, true]]);
  assert.equal(gone.sentences, 1);
  assert.equal(gone.sentenceFields, 1);
  // exactly the first sentence, typed over: it stays
  const kept = doc.textDeleteLoss([[s1.begin, s1.end, true]]);
  assert.equal(kept.sentences, 0);
  assert.equal(kept.sentenceFields, 0);
  // exactly the first sentence, deleted with nothing typed: it goes
  assert.equal(doc.textDeleteLoss([[s1.begin, s1.end, false]]).sentences, 1);
});

test('a sentence whose text is deleted, its line break left, goes with its fields, and so does one blanked (REV-DUMB round 2)', () => {
  const doc = open(TWO);
  const [s1] = doc.layerInfo.sentenceTokenLayer.tokens;
  const letters = s1.begin + [...'hi .'].length;
  // H1: `hi .` deleted, what follows it left
  const h1 = doc.textDeleteLoss(
    removedStretches(doc.body, [{ start: s1.begin, end: letters, value: '' }]),
  );
  assert.equal(h1.sentences, 1);
  assert.equal(h1.sentenceFields, 1);
  // H3: the sentence typed over exactly with a space
  const h3 = doc.textDeleteLoss(
    removedStretches(doc.body, [{ start: s1.begin, end: s1.end, value: ' ' }]),
  );
  assert.equal(h3.sentences, 1);
  // letters typed over it exactly keep it
  const kept = doc.textDeleteLoss(
    removedStretches(doc.body, [{ start: s1.begin, end: s1.end, value: 'yo' }]),
  );
  assert.equal(kept.sentences, 0);
});
