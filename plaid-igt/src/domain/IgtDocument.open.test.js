import { describe, it, expect, beforeEach } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from './test-helpers.js';

// Opening a document in IGT writes nothing. The layer rules are declared at
// setup and by the settings that change them, and a morph type cached on a
// morpheme is written by the change that moves it (morphTypeCaches.js).

const twoWords = [
  { id: 'w-1', begin: 0, end: 3 },
  { id: 'w-2', begin: 4, end: 7 },
];
const m = (id, begin, end) => ({ id, text: 'text-1', begin, end, precedence: 1, metadata: {} });

beforeEach(() => resetIds());

// What reaches the server as a write (an operation is opened lazily and
// sends nothing until a write joins it).
const writes = (client) =>
  client.calls.filter(
    (c) =>
      /^(tokens|spans|vocab|texts|documents|batch|.*Layers)\./.test(c.kind) &&
      !/\.get$/.test(c.kind),
  );

describe('IgtDocument.reconcileOnOpen', () => {
  it('writes nothing for a bare word, which derives a morpheme of its own', async () => {
    const raw = buildRawDoc({ words: twoWords, morphemes: [m('m-1', 0, 3)] });
    const client = makeFakeClient();
    const doc = new IgtDocument({
      raw,
      project: { id: 'proj-1', vocabs: [], config: {} },
      vocabularies: {},
      client,
      projectId: 'proj-1',
    });

    const res = await doc.reconcileOnOpen();

    expect(res.findings).toEqual([]);
    expect(writes(client)).toEqual([]);
    const [first, second] = doc.sentences[0].tokens;
    expect(first.morphemes[0].id).toBe('m-1');
    expect(second.morphemes[0]).toMatchObject({ id: 'virtual:w-2', virtual: true });
  });

  // Until 2026-10-06 a maintainer's open declared IGT's layer rules on a
  // project whose layers held none, repairing first, and every open wrote a
  // morph type that had drifted from its entry's onto the morpheme, under the
  // name of whoever opened it.
  it('neither declares rules nor writes a drifted morph type', async () => {
    const client = makeFakeClient();
    const doc = new IgtDocument({
      raw: buildRawDoc(),
      project: {
        id: 'proj-1',
        vocabs: [{ id: 'v1' }],
        config: {},
        maintainers: ['me'],
      },
      user: { id: 'me' },
      vocabularies: {
        v1: {
          id: 'v1',
          items: [{ id: 'i1', form: 'the', metadata: { morphType: 'stem' } }],
          vocabLinks: [{ id: 'lk-1', tokens: ['m-1'], vocabItem: { id: 'i1', form: 'the' } }],
        },
      },
      client,
      projectId: 'proj-1',
    });

    const res = await doc.reconcileOnOpen();

    expect(res.findings).toEqual([]);
    expect(writes(client)).toEqual([]);
    expect(client.calls.some((c) => /Constraints$/.test(c.kind))).toBe(false);
    // The screen reads the entry's type all the same.
    expect(doc.sentences[0].tokens[0].morphemes[0].morphType).toBe('stem');
  });
});
