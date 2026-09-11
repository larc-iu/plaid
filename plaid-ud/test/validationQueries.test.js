// Pure-fn tests for the Validation tab's arithmetic (domain/validationQueries.js).
//
// The queries themselves are shapes handed to the server, so what is worth
// testing is the diffing done on this side: which stored values a project's own
// list does not have, and which of those it is being offered to adopt.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  spanValueCounts,
  relationValueCounts,
  spanValueSentences,
  offListValues,
  seedCandidates,
  featureSeedCandidates,
} from '../src/domain/validationQueries.js';
import { makeValidators } from '../src/utils/udVocabMode.js';

test('the inventory queries group by value and count, scoped to the project', () => {
  const q = spanValueCounts('p1', 'L1');
  assert.deepEqual(q.return, { aggregates: [['count']], group: ['?val'] });
  assert.deepEqual(q.scope, { projectIds: ['p1'] });
  // Every span in the layer whatever its value: the UDF matches on contains,
  // so '.' means "has at least one character".
  assert.deepEqual(q.where[0], ['span', '?s', { layer: 'L1', value: { regex: '.' } }]);
  assert.equal(relationValueCounts('p1', 'R1').where[0][0], 'relation');
});

test('"where is it" groups by SENTENCE, since that is what a link needs', () => {
  const q = spanValueSentences('p1', 'S1', 'L1', 'WIDGET');
  // Landing on the document and leaving the reader to find the word is most of
  // the work not done, so the sentence token comes back with the document.
  assert.deepEqual(q.return.group, ['?d', '?S']);
  assert.ok(q.where.some((c) => c[0] === 'within' && c[1] === '?t' && c[2] === '?S'));
  // A span constraint map takes only :doc, :layer, :metadata and :value, so a
  // span reaches its token through `covers` and not a `tokens` key. Asking the
  // wrong way is an HTTP 400 that only shows up when a row is expanded.
  assert.ok(q.where.some((c) => c[0] === 'covers' && c[1] === '?s' && c[2] === '?t'));
  assert.ok(!q.where.some((c) => c[0] === 'span' && c[2] && 'tokens' in c[2]));
  assert.ok(q.where.some((c) => c[0] === 'token' && c[1] === '?S' && c[2].layer === 'S1'));
});

const closedUpos = {
  vocab: { upos: ['NOUN', 'VERB'], xpos: [], deprel: ['nsubj', 'det'], featureInventory: {} },
  modes: { upos: 'closed', deprel: 'closed' },
};

test('offListValues asks the same question the cells do', () => {
  const v = makeValidators(closedUpos);
  const counts = [
    ['NOUN', 40],
    ['WIDGET', 3],
    ['VERB', 12],
    ['GIZMO', 7],
  ];
  assert.deepEqual(offListValues(counts, v.upos), [
    { value: 'GIZMO', count: 7 },
    { value: 'WIDGET', count: 3 },
  ]);
});

test('offListValues judges a DEPREL by its base, as the editor does', () => {
  const v = makeValidators(closedUpos);
  const counts = [
    ['nsubj:pass', 9],
    ['det', 20],
    ['zzz', 2],
  ];
  // A plain set difference would flag nsubj:pass, which is legal.
  assert.deepEqual(offListValues(counts, v.deprel), [{ value: 'zzz', count: 2 }]);
});

test('offListValues finds nothing in an OPEN vocabulary, whatever is stored', () => {
  const v = makeValidators({ vocab: { upos: ['NOUN'] }, modes: {} });
  assert.deepEqual(offListValues([['WIDGET', 3]], v.upos), []);
});

test('seedCandidates ignores the mode: a suggestion list is worth completing too', () => {
  assert.deepEqual(
    seedCandidates(
      [
        ['NOUN', 5],
        ['WIDGET', 9],
        ['', 3],
        [null, 1],
      ],
      ['NOUN'],
    ),
    [{ value: 'WIDGET', count: 9 }],
  );
  assert.deepEqual(
    seedCandidates(
      [
        ['A', 1],
        ['B', 1],
      ],
      [],
    ),
    [
      { value: 'A', count: 1 },
      { value: 'B', count: 1 },
    ],
  );
});

test('featureSeedCandidates splits Key=Value and respects an open-valued key', () => {
  const inventory = new Map([
    ['Number', ['Sing']],
    ['Gender', []], // listed with no values: accepts anything, so no candidates
  ]);
  const counts = [
    ['Number=Sing', 30],
    ['Number=Plur', 12],
    ['Gender=Masc', 8],
    ['Mood=Ind', 5],
    ['Mood=Sub', 9],
    ['broken', 4],
    ['Empty=', 2],
  ];
  assert.deepEqual(featureSeedCandidates(counts, inventory), [
    {
      key: 'Mood',
      known: false,
      values: [
        { value: 'Sub', count: 9 },
        { value: 'Ind', count: 5 },
      ],
    },
    { key: 'Number', known: true, values: [{ value: 'Plur', count: 12 }] },
  ]);
});

test('featureSeedCandidates against an empty inventory offers everything', () => {
  const out = featureSeedCandidates(
    [
      ['A=1', 2],
      ['A=2', 5],
      ['B=1', 1],
    ],
    new Map(),
  );
  assert.deepEqual(out, [
    {
      key: 'A',
      known: false,
      values: [
        { value: '2', count: 5 },
        { value: '1', count: 2 },
      ],
    },
    { key: 'B', known: false, values: [{ value: '1', count: 1 }] },
  ]);
});

test('seedCandidates takes an equivalence, so a DEPREL subtype is not re-offered', () => {
  const sameBase = (a, b) => a.split(':')[0] === b.split(':')[0];
  const counts = [
    ['nsubj:pass', 9],
    ['obj', 4],
  ];
  // Listing `nsubj` already makes `nsubj:pass` legal; offering to add it would
  // start the re-listing of the language that closed mode exists to avoid.
  assert.deepEqual(seedCandidates(counts, ['nsubj'], sameBase), [{ value: 'obj', count: 4 }]);
  // Without the equivalence it IS offered, which is right for a plain tag set.
  assert.deepEqual(
    seedCandidates(counts, ['nsubj']).map((c) => c.value),
    ['nsubj:pass', 'obj'],
  );
});
