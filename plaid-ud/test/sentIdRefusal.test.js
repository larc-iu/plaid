// H3-3-4 and H3-5-9: a sent_id typed in Edit metadata was saved and exported
// with a space in it, or one another sentence of the document has, and UD's
// validator refuses both. The exporter keeps both rules for the ids it makes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { withOps } from './helpers/stubClient.js';

const INPUT = [
  '# sent_id = es-1',
  '# text = uno',
  '1\tuno\tuno\tNUM\t_\t_\t0\troot\t_\t_',
  '',
  '# sent_id = en-1',
  '# text = one',
  '1\tone\tone\tNUM\t_\t_\t0\troot\t_\t_',
  '',
  '# text = echad',
  '1\techad\techad\tNUM\t_\t_\t0\troot\t_\t_',
].join('\n');

const open = () => {
  const sent = [];
  const client = withOps({
    tokens: {
      patchMetadata: async (id, ops) => {
        sent.push([id, ops]);
        return {};
      },
    },
  });
  const doc = new ConlluDocument({ raw: rawDocFromConllu(INPUT, 'sid'), client });
  const refusals = [];
  doc.onError = (message) => refusals.push(message);
  const sentences = [...doc.layerInfo.sentenceTokenLayer.tokens].sort((a, b) => a.begin - b.begin);
  return { doc, sent, refusals, sentences };
};

test('a sent_id another sentence has is refused, and the sentence keeps its own', async () => {
  const { doc, sent, refusals, sentences } = open();
  assert.equal(await doc.setSentenceMetadata(sentences[1].id, 'sent_id', 'es-1'), false);
  assert.deepEqual(refusals, ['Another sentence has sent_id es-1.']);
  assert.equal(sentences[1].metadata.sent_id, 'en-1');
  assert.deepEqual(sent, []);
});

test('a sent_id with a space is refused', async () => {
  const { doc, sent, refusals, sentences } = open();
  assert.equal(await doc.setSentenceMetadata(sentences[2].id, 'sent_id', 'he 1'), false);
  assert.deepEqual(refusals, ['A sent_id cannot contain spaces.']);
  assert.equal(sentences[2].metadata?.sent_id, undefined);
  assert.deepEqual(sent, []);
});

test('a new sent_id is written, and another field may repeat a value', async () => {
  const { doc, sent, refusals, sentences } = open();
  assert.equal(await doc.setSentenceMetadata(sentences[2].id, 'sent_id', 'he-1'), true);
  assert.equal(await doc.setSentenceMetadata(sentences[2].id, 'comment', 'es-1 again'), true);
  assert.equal(await doc.setSentenceMetadata(sentences[1].id, 'note', 'es-1'), true);
  assert.deepEqual(refusals, []);
  assert.equal(sent.length, 3);
});
