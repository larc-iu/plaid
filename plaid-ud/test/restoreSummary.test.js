// The restore confirm step's change list, built from the server's dry-run
// summary. Uses Node's built-in test runner — run `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  changeLines,
  historyMessage,
  indexLayers,
  restoreError,
  skippedLines,
} from '../src/domain/restoreSummary.js';

// A UD document's layers, plus one token layer belonging to another app that
// shares the substrate (IGT's morphemes) to check the fallback naming.
const raw = {
  textLayers: [
    {
      id: 'text',
      tokenLayers: [
        { id: 'sent', name: 'Sentences', config: { plaid: { role: 'sentence' } } },
        { id: 'tok', name: 'Tokens', config: { plaid: { role: 'word' } } },
        {
          id: 'word',
          name: 'Words',
          config: { plaid: { role: 'syntactic-word' } },
          spanLayers: [
            { id: 'upos', name: 'UPOS' },
            {
              id: 'lemma',
              name: 'Lemma',
              relationLayers: [{ id: 'deprel', name: 'Dependency Relations' }],
            },
          ],
        },
        { id: 'morph', name: 'Morphemes', config: { plaid: { role: 'morpheme' } } },
      ],
    },
  ],
};

const layers = indexLayers(raw);

test('indexLayers names every layer and keeps token-layer roles', () => {
  assert.deepEqual(layers.tok, { name: 'Tokens', role: 'word' });
  assert.deepEqual(layers.upos, { name: 'UPOS' });
  assert.deepEqual(layers.deprel, { name: 'Dependency Relations' });
});

test('token layers are named in UD terms, by role', () => {
  const lines = changeLines(
    {
      tokens: {
        byLayer: [
          { layerId: 'sent', inserted: 1, updated: 0, deleted: 0 },
          { layerId: 'tok', inserted: 2, updated: 1, deleted: 0 },
          { layerId: 'word', inserted: 0, updated: 0, deleted: 4 },
        ],
      },
    },
    layers,
  );
  // The `word`-role layer holds UD's TOKENS and `syntactic-word` holds its
  // WORDS — the inverse of the internal names.
  assert.deepEqual(lines, ['1 sentence', '3 tokens', '4 words']);
});

test('a token layer from another app falls back to its own name', () => {
  const lines = changeLines(
    { tokens: { byLayer: [{ layerId: 'morph', inserted: 0, updated: 7, deleted: 0 }] } },
    layers,
  );
  assert.deepEqual(lines, ['7 tokens in Morphemes']);
});

test('spans and relations are named by their layer', () => {
  const lines = changeLines(
    {
      spans: { byLayer: [{ layerId: 'upos', inserted: 0, updated: 1, deleted: 0 }] },
      relations: { byLayer: [{ layerId: 'deprel', inserted: 3, updated: 0, deleted: 2 }] },
    },
    layers,
  );
  assert.deepEqual(lines, ['1 annotation in UPOS', '5 relations in Dependency Relations']);
});

test('layers absent from the document still produce a line', () => {
  const lines = changeLines(
    { spans: { byLayer: [{ layerId: 'gone', inserted: 1, updated: 0, deleted: 0 }] } },
    layers,
  );
  assert.deepEqual(lines, ['1 annotation in a field']);
});

test('zero-change layers are left out', () => {
  const lines = changeLines(
    {
      tokens: { byLayer: [{ layerId: 'tok', inserted: 0, updated: 0, deleted: 0 }] },
      spans: { byLayer: [{ layerId: 'upos', inserted: 0, updated: 0, deleted: 0 }] },
    },
    layers,
  );
  assert.deepEqual(lines, []);
});

test('the name, the text, tokens read from it, vocabulary links and metadata, in order', () => {
  const lines = changeLines(
    {
      name: 'Renamed',
      texts: { inserted: 0, updated: 1, deleted: 0 },
      tokens: { byLayer: [{ layerId: 'sent', inserted: 2, updated: 0, deleted: 0 }] },
      vocabLinks: { inserted: 1, updated: 0, deleted: 1 },
      documentMetadata: true,
    },
    layers,
  );
  // The text line names the tokens that read from it: a token is a slice of
  // the body, so a restored text changes what they read while their own rows
  // are untouched and counted nowhere else in the list.
  assert.deepEqual(lines, [
    'The document name',
    'The text, and the words read from it',
    '2 sentences',
    '2 vocabulary links',
    'Metadata',
  ]);
});

test('an empty or absent summary lists nothing', () => {
  assert.deepEqual(changeLines(null, layers), []);
  assert.deepEqual(changeLines({}, layers), []);
});

test('skipped items are reported by kind, singular and plural', () => {
  assert.deepEqual(
    skippedLines([
      { kind: 'span', count: 1 },
      { kind: 'relation', count: 3 },
      { kind: 'vocab-link', count: 2 },
      { kind: 'mystery', count: 1 },
    ]),
    [
      '1 annotation cannot come back.',
      '3 relations cannot come back.',
      '2 vocabulary links cannot come back.',
      '1 item cannot come back.',
    ],
  );
  assert.deepEqual(skippedLines(undefined), []);
});

test('a restore refused because a layer changed is passed through, stripped', () => {
  const err = new Error(
    'HTTP 409 The state of layer l1 no longer fits it at http://localhost:8085/api/v1/documents/d1/restore',
  );
  assert.equal(
    restoreError(err, 'The restore was not applied.'),
    'The state of layer l1 no longer fits it',
  );
});

test('any other failure reads as it does everywhere', () => {
  assert.equal(
    restoreError({ status: 423 }, 'The restore was not applied.'),
    'This document is being edited right now (by another user or a service). Try again in a moment.',
  );
  assert.equal(restoreError(null, 'The restore was not applied.'), 'The restore was not applied.');
});

test('the audit message names the moment, and the entry it follows', () => {
  const at = '2026-09-14T12:00:00.000Z';
  assert.match(historyMessage(at, null), /^Restore to \S/);
  assert.ok(historyMessage(at, 'Tokenize').endsWith('(after \u201cTokenize\u201d)'));
});
