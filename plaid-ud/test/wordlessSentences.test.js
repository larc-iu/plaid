// A sentence holding no word (a punctuation-only line igt left untokenized)
// has no row and no number: the rows after it number on without a gap, as the
// ud assistant's reader numbers them (plaid-agent test_ud_rows_mirror.py).
// Removing the boundary before the next row joins that row to the row above
// on screen, the word-less sentence between included.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { withOps } from './helpers/stubClient.js';

const INPUT = [
  '# text = Kanu bata',
  '1\tKanu\tkanu\tNOUN\t_\t_\t2\tnsubj\t_\t_',
  '2\tbata\tbata\tVERB\t_\t_\t0\troot\t_\t_',
  '',
  '# text = gap',
  '1\tgap\tgap\tX\t_\t_\t0\troot\t_\t_',
  '',
  '# text = ina mo',
  '1\tina\tina\tNOUN\t_\t_\t2\tnsubj\t_\t_',
  '2\tmo\tmo\tVERB\t_\t_\t0\troot\t_\t_',
].join('\n');

// The CoNLL-U above with every word of its second sentence taken away, as a
// sentence another app made with no words stands.
// `alsoFirst` takes the first sentence's words away too.
const wordless = ({ alsoFirst = false } = {}) => {
  const raw = rawDocFromConllu(INPUT, 'gap');
  const layers = raw.textLayers[0].tokenLayers;
  const sorted = [...layers[0].tokens].sort((a, b) => a.begin - b.begin);
  const emptied = alsoFirst ? sorted.slice(0, 2) : [sorted[1]];
  const inside = (t) => emptied.some((s) => t.begin >= s.begin && t.end <= s.end);
  const gone = new Set();
  for (const layer of layers.slice(1)) {
    layer.tokens.filter(inside).forEach((t) => gone.add(t.id));
    layer.tokens = layer.tokens.filter((t) => !inside(t));
  }
  const spansGone = new Set();
  for (const sl of layers[2].spanLayers) {
    sl.spans.filter((s) => s.tokens.some((id) => gone.has(id))).forEach((s) => spansGone.add(s.id));
    sl.spans = sl.spans.filter((s) => !spansGone.has(s.id));
    for (const rl of sl.relationLayers || []) {
      rl.relations = rl.relations.filter(
        (r) => !spansGone.has(r.source) && !spansGone.has(r.target),
      );
    }
  }
  return raw;
};

test('a sentence with no words has no row, and the next row takes the next number', () => {
  const doc = new ConlluDocument({ raw: wordless() });
  assert.equal(doc.layerInfo.sentenceTokenLayer.tokens.length, 3);
  assert.deepEqual(
    doc.sentences.map((row) => row.tokens.map((t) => t.tokenForm).join(' ')),
    ['Kanu bata', 'ina mo'],
  );
});

test('removing the boundary before a row joins it to the row above, the word-less sentence between included', async () => {
  const calls = [];
  const client = withOps({
    tokens: {
      merge: async (...args) => {
        calls.push(args);
      },
    },
    documents: { get: async () => wordless() },
  });
  const raw = wordless();
  const doc = new ConlluDocument({ raw: structuredClone(raw), client });
  const [first, gap, third] = [...doc.layerInfo.sentenceTokenLayer.tokens].sort(
    (a, b) => a.begin - b.begin,
  );
  const merged = doc.toggleSentenceBoundary(third.begin);
  // Shown before the server answers: one sentence over both rows.
  assert.deepEqual(
    doc.layerInfo.sentenceTokenLayer.tokens.map((t) => [t.id, t.begin, t.end]),
    [[first.id, first.begin, third.end]],
  );
  assert.equal(doc.sentences.length, 1);
  assert.equal(await merged, true);
  assert.deepEqual(calls, [
    [first.id, gap.id],
    [first.id, third.id],
  ]);
});

test('with no words before, the boundary joins the sentence right before, as ever', async () => {
  const calls = [];
  const client = withOps({
    tokens: {
      merge: async (...args) => {
        calls.push(args);
      },
    },
    documents: { get: async () => null },
  });
  const raw = wordless({ alsoFirst: true });
  const sorted = [...raw.textLayers[0].tokenLayers[0].tokens].sort((a, b) => a.begin - b.begin);
  const doc = new ConlluDocument({ raw, client });
  assert.equal(doc.sentences.length, 1);
  assert.equal(await doc.toggleSentenceBoundary(sorted[2].begin), true);
  assert.deepEqual(calls, [[sorted[1].id, sorted[2].id]]);
});
