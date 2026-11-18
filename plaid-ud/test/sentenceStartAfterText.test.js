// H3-3-1: a sentence whose first token begins after its start (text no token
// covers, such as a deleted `«`, or a line's leading spaces) showed no start
// of sentence, and a click on that token split off a sentence of no words
// where the guide says it joins the sentence to the one above.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { getUdLayerInfo } from '../src/utils/udLayerUtils.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { withOps } from './helpers/stubClient.js';

const INPUT = [
  '# sent_id = q-1',
  '# text = « Hola » dijo ella.',
  '1\t«\t«\tPUNCT\t_\t_\t4\tpunct\t_\t_',
  '2\tHola\thola\tINTJ\t_\t_\t4\tobj\t_\t_',
  '3\t»\t»\tPUNCT\t_\t_\t4\tpunct\t_\t_',
  '4\tdijo\tdecir\tVERB\t_\t_\t0\troot\t_\t_',
  '5\tella\tella\tPRON\t_\t_\t4\tnsubj\t_\t_',
  '6\t.\t.\tPUNCT\t_\t_\t4\tpunct\t_\t_',
  '',
  '# sent_id = q-2',
  '# note = second',
  '# text = « Adiós » dijo él.',
  '1\t«\t«\tPUNCT\t_\t_\t4\tpunct\t_\t_',
  '2\tAdiós\tadiós\tINTJ\t_\t_\t4\tobj\t_\t_',
  '3\t»\t»\tPUNCT\t_\t_\t4\tpunct\t_\t_',
  '4\tdijo\tdecir\tVERB\t_\t_\t0\troot\t_\t_',
  '5\tél\tél\tPRON\t_\t_\t4\tnsubj\t_\t_',
  '6\t.\t.\tPUNCT\t_\t_\t4\tpunct\t_\t_',
].join('\n');

// The document with the first token of each sentence taken out, so each
// sentence begins on a `«` no token covers.
const open = () => {
  const raw = rawDocFromConllu(INPUT, 'q');
  const info = getUdLayerInfo(raw);
  const body = info.textLayer.text.body;
  const at = (t) => [...body].slice(t.begin, t.end).join('');
  const gone = new Set(
    info.wordTokenLayer.tokens.filter((t) => at(t) === '«').flatMap((t) => [t.begin]),
  );
  for (const layer of [info.wordTokenLayer, info.morphemeTokenLayer]) {
    layer.tokens = layer.tokens.filter((t) => !gone.has(t.begin));
  }
  const calls = [];
  const client = withOps({
    tokens: {
      merge: async (...args) => {
        calls.push(['merge', ...args]);
        return {};
      },
      split: async (...args) => {
        calls.push(['split', ...args]);
        return {};
      },
    },
  });
  const doc = new ConlluDocument({ raw, client });
  const word = (form, n = 0) =>
    doc.layerInfo.wordTokenLayer.tokens
      .filter((t) => at(t) === form)
      .sort((a, b) => a.begin - b.begin)[n];
  const sentences = () =>
    [...doc.layerInfo.sentenceTokenLayer.tokens].sort((a, b) => a.begin - b.begin);
  return { doc, calls, word, sentences };
};

test("a click on a sentence's first token joins it to the one above, wherever in the sentence it begins", async () => {
  const { doc, calls, word, sentences } = open();
  const [s1, s2] = sentences();
  const adios = word('Adiós');
  assert.ok(adios.begin > s2.begin, 'the sentence begins before its first token');
  assert.deepEqual(doc.sentenceFieldsLostByJoin(adios.begin), ['note']);
  assert.deepEqual(doc.otherLossForSentenceSplit(adios.begin), { annotations: 0, links: 0 });
  assert.equal(await doc.toggleSentenceBoundary(adios.begin), true);
  assert.deepEqual(calls, [['merge', s1.id, s2.id]]);
  assert.equal(sentences().length, 1);
});

test("a click on the first sentence's first token changes nothing", async () => {
  const { doc, calls, word, sentences } = open();
  assert.equal(await doc.toggleSentenceBoundary(word('Hola').begin), false);
  assert.deepEqual(calls, []);
  assert.equal(sentences().length, 2);
});

test('a click on a later token still splits its sentence there', async () => {
  const { doc, calls, word, sentences } = open();
  assert.equal(await doc.toggleSentenceBoundary(word('dijo', 1).begin), true);
  assert.equal(calls[0][0], 'split');
  assert.equal(sentences().length, 3);
});
