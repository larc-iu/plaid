// H8-ASSISTANT-2: Discard is offered only where it would delete something,
// by the rule discardTokens applies. A tree approved over lemmas seeded from
// the form keeps those lemmas (the verified relations hang on them), so the
// sentence holds nothing to discard, and the button and the chord say so.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { hasDiscardable, wordHasDiscardable } from '../src/domain/reviewTargets.js';
import { sentenceArcs } from '../src/domain/enhancedGraph.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { withOps } from './helpers/stubClient.js';

const INPUT = [
  '# text = el perro',
  '1\tel\tel\tDET\t_\t_\t2\tdet\t_\t_',
  '2\tperro\tperro\tNOUN\t_\t_\t0\troot\t_\t_',
].join('\n');

const seeded = { prov: 'inferred', provSource: 'rule:lemma-from-form' };
const approved = { prov: 'inferred', provSource: 'service:ud:assist', provConfirmed: true };
const parsed = { prov: 'inferred', provSource: 'service:stanza-parser' };

// Every lemma seeded, every UPOS and relation as `rest`.
function setup(rest) {
  const raw = rawDocFromConllu(INPUT, 'd');
  const calls = [];
  const record = (name) => () => {
    calls.push(name);
    return Promise.resolve({});
  };
  const client = withOps({
    spans: { delete: record('spans.delete'), bulkDelete: record('spans.bulkDelete') },
    relations: { delete: record('relations.delete'), bulkDelete: record('relations.bulkDelete') },
  });
  const doc = new ConlluDocument({ raw, client });
  const info = doc.layerInfo;
  info.lemmaLayer.spans.forEach((s) => (s.metadata = { ...seeded }));
  info.uposLayer.spans.forEach((s) => (s.metadata = { ...rest }));
  info.xposLayer.spans.length = 0;
  info.featuresLayer.spans.length = 0;
  info.relationLayer.relations.forEach((r) => (r.metadata = { ...rest }));
  doc._dataVersion = (doc._dataVersion || 0) + 1;
  return { doc, calls };
}

test('an approved tree over seeded lemmas holds nothing to discard', async () => {
  const { doc, calls } = setup(approved);
  const sentence = doc.sentences[0];
  assert.equal(hasDiscardable(sentence.tokens, sentenceArcs(sentence)), false);
  for (const entry of sentence.tokens) {
    assert.equal(wordHasDiscardable(doc.sentences, entry.token.id), false);
  }
  await doc.discardTokens(sentence.tokens.map((e) => e.token.id));
  assert.deepEqual(calls, []);
});

test('a parsed tree holds something to discard, and discard deletes it', async () => {
  const { doc, calls } = setup(parsed);
  const sentence = doc.sentences[0];
  assert.equal(hasDiscardable(sentence.tokens, sentenceArcs(sentence)), true);
  await doc.discardTokens(sentence.tokens.map((e) => e.token.id));
  assert.ok(calls.length > 0);
});
