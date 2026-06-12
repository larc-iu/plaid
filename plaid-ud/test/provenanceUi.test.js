// Pure-fn tests for the prediction-extras read side (provenanceUi.js):
// ranking selector suggestions by a parser's declared distribution and
// describing a machine-made annotation for tooltips.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  readFieldProbs, groupSuggestions, probLabel, provCellTitle, PARSER_GROUP,
} from '../src/utils/provenanceUi.js';

const MACHINE_META = {
  prov: 'inferred',
  provSource: 'service:my-parser',
  provProb: 0.84,
  provDetail: {
    model: 'my-parser==2.1',
    language: 'en',
    uposProbs: { NOUN: 0.84, PROPN: 0.1, ADJ: 0.02 },
    deprelProbs: { det: 0.9, nsubj: 0.05 },
  },
};

test('readFieldProbs reads the field-specific distribution, sanitized', () => {
  assert.deepEqual(readFieldProbs(MACHINE_META, 'upos'),
    { NOUN: 0.84, PROPN: 0.1, ADJ: 0.02 });
  assert.deepEqual(readFieldProbs(MACHINE_META, 'deprel'), { det: 0.9, nsubj: 0.05 });
  assert.equal(readFieldProbs(MACHINE_META, 'xpos'), null);
  assert.equal(readFieldProbs(undefined, 'upos'), null);
  assert.equal(readFieldProbs({ provDetail: { uposProbs: { NOUN: 'high' } } }, 'upos'), null,
    'non-numeric entries are dropped; an all-junk map reads as no distribution');
});

test('groupSuggestions floats the top-k above the rest, ranked by prob', () => {
  const vocab = ['ADJ', 'ADV', 'NOUN', 'PROPN', 'VERB'];
  const grouped = groupSuggestions(vocab, readFieldProbs(MACHINE_META, 'upos'));
  assert.deepEqual(grouped, [
    { group: PARSER_GROUP, items: ['NOUN', 'PROPN', 'ADJ'] },
    { group: 'All tags', items: ['ADV', 'VERB'] },
  ]);
});

test('groupSuggestions keeps off-vocab parser labels and falls back without probs', () => {
  const grouped = groupSuggestions(['det'], { 'obl:arg': 0.7, det: 0.2 });
  assert.deepEqual(grouped[0], { group: PARSER_GROUP, items: ['obl:arg', 'det'] });
  // No distribution -> the plain list, untouched.
  const vocab = ['NOUN', 'VERB'];
  assert.equal(groupSuggestions(vocab, null), vocab);
});

test('groupSuggestions caps at topK', () => {
  const probs = Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [`t${i}`, (10 - i) / 100]));
  const grouped = groupSuggestions([], probs, { topK: 3 });
  assert.deepEqual(grouped, [{ group: PARSER_GROUP, items: ['t0', 't1', 't2'] }]);
});

test('probLabel renders a percentage only for covered options', () => {
  const probs = readFieldProbs(MACHINE_META, 'upos');
  assert.equal(probLabel(probs, 'NOUN'), '84%');
  assert.equal(probLabel(probs, 'VERB'), null);
  assert.equal(probLabel(null, 'NOUN'), null);
});

test('provCellTitle describes machine-made annotations and passes humans through', () => {
  assert.equal(provCellTitle('Edit upos', undefined), 'Edit upos');
  assert.equal(provCellTitle('Edit upos', {}), 'Edit upos');
  assert.equal(
    provCellTitle('Edit upos', MACHINE_META),
    'Edit upos — machine-made, unverified (service:my-parser · my-parser==2.1 · en · p=0.84)');
  assert.equal(
    provCellTitle('Edit upos', { ...MACHINE_META, provConfirmed: true }),
    'Edit upos — machine-made, human-verified (service:my-parser · my-parser==2.1 · en · p=0.84)');
  // Sparse record: just the source.
  assert.equal(
    provCellTitle('deprel', { prov: 'inferred', provSource: 'service:p' }),
    'deprel — machine-made, unverified (service:p)');
});
