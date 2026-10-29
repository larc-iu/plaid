// R54 (R4-1, P3-1): a sentence join keeps the sentence before's fields and
// deletes the joined sentence's `# key = value` fields. The Text Editor asks
// first, and this is what it counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';

const INPUT = [
  '# sent_id = s1',
  '# text = Hello world.',
  '# translation = Hallo Welt.',
  '1\tHello\thello\tINTJ\t_\t_\t0\troot\t_\t_',
  '2\tworld.\tworld\tNOUN\t_\t_\t1\tvocative\t_\t_',
  '',
  '# sent_id = s2',
  '# text = Goodbye friend.',
  '# translation = Tschuess Freund.',
  '# note = typed by hand',
  '1\tGoodbye\tgoodbye\tINTJ\t_\t_\t0\troot\t_\t_',
  '2\tfriend.\tfriend\tNOUN\t_\t_\t1\tvocative\t_\t_',
].join('\n');

const open = () => {
  const raw = rawDocFromConllu(INPUT, 'join');
  const doc = new ConlluDocument({ raw, client: {} });
  const sentences = [...doc.layerInfo.sentenceTokenLayer.tokens].sort((a, b) => a.begin - b.begin);
  return { doc, sentences };
};

test("a join at a sentence's first token names the joined sentence's fields, not the one before's", () => {
  const { doc, sentences } = open();
  const [s1, s2] = sentences;
  assert.ok(s2.metadata?.translation, 'the import stored the field on the sentence');
  assert.deepEqual(doc.sentenceFieldsLostByJoin(s2.begin).sort(), ['note', 'translation']);
  // The first sentence joins nothing, and a position inside a sentence splits.
  assert.deepEqual(doc.sentenceFieldsLostByJoin(s1.begin), []);
  assert.deepEqual(doc.sentenceFieldsLostByJoin(s2.begin + 2), []);
});

test('a join of a sentence with no fields of its own deletes none', () => {
  const { doc, sentences } = open();
  const s2 = sentences[1];
  for (const k of Object.keys(s2.metadata)) {
    if (k !== 'sent_id' && k !== 'text') delete s2.metadata[k];
  }
  assert.deepEqual(doc.sentenceFieldsLostByJoin(s2.begin), []);
});
