// A token made from a selection in the Text Editor (createWord).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { withOps } from './helpers/stubClient.js';

// A document over `body` with no sentence and no token, and the token rows
// its writes send.
const untokenized = (body) => {
  const raw = rawDocFromConllu('# text = x\n1\tx\tx\tX\t_\t_\t0\troot\t_\t_', 'd');
  const [textLayer] = raw.textLayers;
  textLayer.text.body = body;
  const empty = (layer) => {
    if (layer.tokens) layer.tokens = [];
    for (const sl of layer.spanLayers || []) {
      sl.spans = [];
      for (const rl of sl.relationLayers || []) rl.relations = [];
    }
  };
  textLayer.tokenLayers.forEach(empty);
  const rows = [];
  const client = withOps({
    tokens: {
      bulkCreate: async (ops) => {
        rows.push(...ops);
        return { ids: ops.map((op) => op.id) };
      },
    },
    spans: { bulkCreate: async (ops) => ({ ids: ops.map((op) => op.id) }) },
  });
  const doc = new ConlluDocument({ raw, client });
  const layerOf = (row) =>
    row.tokenLayerId === doc.layerInfo.sentenceTokenLayer.id
      ? 'sentence'
      : row.tokenLayerId === doc.layerInfo.wordTokenLayer.id
        ? 'token'
        : 'word';
  const sent = () => rows.map((r) => [layerOf(r), r.begin, r.end]);
  return { doc, sent };
};

// H3-3-3: a drag in the gap between two chips, or a selection that takes
// the space after a word, made a token of whitespace, an invalid CoNLL-U row.
test('a selection is trimmed to what is not whitespace, and one of whitespace makes nothing', async () => {
  const body = 'Él vino ayer.';
  const { doc, sent } = untokenized(body);
  assert.equal(await doc.createWord(2, 3, body), false);
  assert.deepEqual(sent(), []);
  assert.equal(await doc.createWord(3, 8, body), true);
  assert.deepEqual(
    sent().filter(([layer]) => layer !== 'sentence'),
    [
      ['token', 3, 7],
      ['word', 3, 7],
    ],
  );
});
