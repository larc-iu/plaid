// R3-1, FX-R3: select all over every sentence and paste. The core leaves one
// sentence over the new text in the same write (segmentServer mirrors it),
// and igt cuts it into one sentence per line, in a batch of splits.
import { beforeEach, expect, it } from 'vitest';
import { buildRawDoc, resetIds, makeIgtDoc } from './test-helpers.js';
import { segmentServer } from '../test/segmentServer.js';

beforeEach(() => resetIds());

const sentencesOf = (raw) =>
  raw.textLayers[0].tokenLayers
    .find((l) => l.id === 'sentL')
    .tokens.map((t) => [t.begin, t.end])
    .sort((a, b) => a[0] - b[0]);
const wordsOf = (raw) =>
  raw.textLayers[0].tokenLayers
    .find((l) => l.id === 'wordL')
    .tokens.map((t) => [t.begin, t.end])
    .sort((a, b) => a[0] - b[0]);

it('a paste over every sentence ends with one sentence per line and the new words inside them', async () => {
  const raw = buildRawDoc({
    body: 'ab. cd.',
    words: [],
    morphemes: [],
    sentences: [
      { id: 's-1', begin: 0, end: 4 },
      { id: 's-2', begin: 4, end: 7 },
    ],
  });
  raw.textLayers[0].tokenLayers.find((l) => l.id === 'wordL').config.igt.tokenizeNewText = true;
  const server = segmentServer(raw);
  const doc = makeIgtDoc({ raw: structuredClone(server.stored), client: server.client });
  const gaps = [{ start: 0, end: 7, value: 'xy\nzw' }];
  expect(await doc.editBaselineText({ base: 'ab. cd.', digest: server.digest, gaps })).toBe(true);
  while (doc.isSaving) await new Promise((r) => setTimeout(r, 0));
  expect(server.body).toBe('xy\nzw');
  expect(sentencesOf(server.stored)).toEqual([
    [0, 3],
    [3, 5],
  ]);
  expect(wordsOf(server.stored)).toEqual([
    [0, 2],
    [3, 5],
  ]);
  // the edit's own answer already held a sentence: igt cut it, it made none
  const kinds = server.sent.flatMap((r) =>
    r.kind === 'batch' ? r.ops.map((o) => o.kind) : [r.kind],
  );
  expect(kinds).toContain('tokens.split');
  expect(kinds).not.toContain('tokens.bulkCreate');
  expect(sentencesOf(doc._raw)).toEqual(sentencesOf(server.stored));
});

// REV-FX-R3-1: a text with no token, and a paste whose text composes, so the
// edit goes alone: the server makes one sentence over the text at the end of
// the request, with the new words inside it, and igt cuts it per line.
it('a composing paste into a text with no token ends with one sentence per line', async () => {
  const raw = buildRawDoc({ body: 'hh', words: [], morphemes: [], sentences: [] });
  raw.textLayers[0].tokenLayers.find((l) => l.id === 'wordL').config.igt.tokenizeNewText = true;
  const server = segmentServer(raw);
  const doc = makeIgtDoc({ raw: structuredClone(server.stored), client: server.client });
  const typed = 'cafe\u0301\nzw';
  const gaps = [{ start: 0, end: 2, value: typed }];
  expect(await doc.editBaselineText({ base: 'hh', digest: server.digest, gaps })).toBe(true);
  while (doc.isSaving) await new Promise((r) => setTimeout(r, 0));
  expect(sentencesOf(server.stored)).toEqual([
    [0, 6],
    [6, 8],
  ]);
  const kinds = server.sent.flatMap((r) =>
    r.kind === 'batch' ? r.ops.map((o) => o.kind) : [r.kind],
  );
  expect(kinds).toContain('tokens.split');
  expect(kinds).not.toContain('tokens.bulkCreate');
  expect(sentencesOf(doc._raw)).toEqual(sentencesOf(server.stored));
});
