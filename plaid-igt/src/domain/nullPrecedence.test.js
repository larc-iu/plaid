import { describe, it, expect, beforeEach } from 'vitest';
import { buildRawDoc, makeFakeClient, resetIds, makeIgtDoc } from './test-helpers.js';

// A morpheme that stores no precedence reads after every one that stores one,
// as the server orders a chain (R4-1-2). A writer that puts pieces beside one
// writes its slot in the same batch, or the first piece reads last
// (REV-R4-TOKENS T1). Such morphemes come from older typed-space stubs, native
// archives, scripts and the API.

const project = { id: 'proj-1', vocabs: [], config: {} };
const docFor = (raw, client) => makeIgtDoc({ raw, client, project, projectId: project.id });
const formsOf = (doc, wordIdx) =>
  doc.sentences[0].tokens[wordIdx].morphemes.map((m) => m.metadata.form ?? m.content);
const precedenceUpdates = (client) =>
  client.calls
    .filter((c) => c.kind === 'tokens.update')
    .map((c) => [c.args[0], c.args[3]])
    .filter(([, p]) => p !== undefined);
const createdPrecedences = (client) =>
  client.calls.flatMap((c) => {
    if (c.kind === 'tokens.bulkCreate') return c.args[0].map((m) => m.precedence);
    if (c.kind === 'tokens.create') return [c.args[4]];
    return [];
  });

const kat = (morphemes) =>
  buildRawDoc({
    body: 'the kat',
    morphemes: [
      { id: 'm-1', text: 'text-1', begin: 0, end: 3, precedence: 1, metadata: {} },
      ...morphemes,
    ],
  });

const kaT = {
  word: { vocabItemId: null, fields: {} },
  morphemes: [
    { form: 'ka', morphType: null, vocabItemId: null, fields: {} },
    { form: 't', morphType: null, vocabItemId: null, fields: {} },
  ],
};

beforeEach(() => resetIds());

describe('a morpheme storing no precedence', () => {
  it('splitMorpheme numbers it before the pieces made after it', async () => {
    const client = makeFakeClient();
    const raw = buildRawDoc({
      body: 'the',
      words: [{ id: 'w-1', begin: 0, end: 3 }],
      morphemes: [{ id: 'm-a', text: 'text-1', begin: 0, end: 3, precedence: null, metadata: {} }],
    });
    const doc = docFor(raw, client);
    expect(await doc.splitMorpheme('m-a', 'th', 'e')).toBe(true);
    expect(formsOf(doc, 0)).toEqual(['th', 'e']);
    expect(precedenceUpdates(client)).toEqual([['m-a', 1]]);
    expect(createdPrecedences(client)).toEqual([2]);
  });

  // REV-R4R R1: the target is numbered one past the highest stored sibling,
  // not by its index, so gapped stored siblings keep reading ahead of it.
  it.each([[[1, 2]], [[1, 3]], [[1, 5]]])(
    'splitMorpheme numbers it past stored siblings %j',
    async (stored) => {
      const client = makeFakeClient();
      const m = (id, precedence, form) => ({
        id,
        text: 'text-1',
        begin: 0,
        end: 6,
        precedence,
        metadata: { form },
      });
      const raw = buildRawDoc({
        body: 'abcdef',
        words: [{ id: 'w-1', begin: 0, end: 6 }],
        morphemes: [m('m-a', stored[0], 'ab'), m('m-b', stored[1], 'cd'), m('m-c', null, 'ef')],
      });
      const doc = docFor(raw, client);
      expect(await doc.splitMorpheme('m-c', 'e', 'f')).toBe(true);
      expect(formsOf(doc, 0)).toEqual(['ab', 'cd', 'e', 'f']);
      expect(precedenceUpdates(client)).toEqual([['m-c', stored[1] + 1]]);
      expect(createdPrecedences(client)).toEqual([stored[1] + 2]);
    },
  );

  it('splitMorpheme numbers every morpheme storing none in the order it reads', async () => {
    const client = makeFakeClient();
    const m = (id, precedence, form) => ({
      id,
      text: 'text-1',
      begin: 0,
      end: 6,
      precedence,
      metadata: { form },
    });
    const raw = buildRawDoc({
      body: 'abcdef',
      words: [{ id: 'w-1', begin: 0, end: 6 }],
      morphemes: [m('m-a', 4, 'ab'), m('m-b', null, 'cd'), m('m-c', null, 'ef')],
    });
    const doc = docFor(raw, client);
    expect(formsOf(doc, 0)).toEqual(['ab', 'cd', 'ef']);
    expect(await doc.splitMorpheme('m-c', 'e', 'f')).toBe(true);
    expect(formsOf(doc, 0)).toEqual(['ab', 'cd', 'e', 'f']);
    expect(precedenceUpdates(client)).toEqual(
      expect.arrayContaining([
        ['m-b', 5],
        ['m-c', 6],
      ]),
    );
    expect(createdPrecedences(client)).toEqual([7]);
  });

  it('applyAnalysisToWords numbers the first morpheme before the slots it makes', async () => {
    const client = makeFakeClient();
    const doc = docFor(
      kat([{ id: 'm-2', text: 'text-1', begin: 4, end: 7, precedence: null, metadata: {} }]),
      client,
    );
    expect(await doc.applyAnalysisToWords(['w-2'], kaT)).toBe(1);
    expect(formsOf(doc, 1)).toEqual(['ka', 't']);
    expect(precedenceUpdates(client)).toEqual([['m-2', 1]]);
    expect(createdPrecedences(client)).toEqual([2]);
  });

  // REV-R4R R2: a lone first morpheme storing 3 would read after the slot
  // made at 2.
  it.each([2, 3])(
    'applyAnalysisToWords numbers a first morpheme storing %i before the slots',
    async (p) => {
      const client = makeFakeClient();
      const doc = docFor(
        kat([{ id: 'm-2', text: 'text-1', begin: 4, end: 7, precedence: p, metadata: {} }]),
        client,
      );
      expect(await doc.applyAnalysisToWords(['w-2'], kaT)).toBe(1);
      expect(formsOf(doc, 1)).toEqual(['ka', 't']);
      expect(precedenceUpdates(client)).toEqual([['m-2', 1]]);
      expect(createdPrecedences(client)).toEqual([2]);
    },
  );

  it('a copy onto a first morpheme that stores one sends no renumber', async () => {
    const client = makeFakeClient();
    const doc = docFor(
      kat([{ id: 'm-2', text: 'text-1', begin: 4, end: 7, precedence: 1, metadata: {} }]),
      client,
    );
    expect(await doc.applyAnalysisToWords(['w-2'], kaT)).toBe(1);
    expect(precedenceUpdates(client)).toEqual([]);
  });

  it('a re-analyze strip renumbers the survivor from what it stores', async () => {
    const client = makeFakeClient();
    const doc = docFor(
      kat([
        {
          id: 'm-2',
          text: 'text-1',
          begin: 4,
          end: 7,
          precedence: null,
          metadata: { form: 'kat' },
        },
      ]),
      client,
    );
    expect(await doc.bulkReplaceAnalyses([{ wordTokenId: 'w-2', analysis: kaT }])).toBe(1);
    expect(formsOf(doc, 1)).toEqual(['ka', 't']);
    // Once: the strip numbers it, and the copy after it sees it numbered.
    expect(precedenceUpdates(client)).toEqual([['m-2', 1]]);
  });

  it('Discard analysis renumbers a survivor from what it stores', async () => {
    const client = makeFakeClient();
    const machine = { prov: 'inferred', provSource: 'service:test' };
    const raw = kat([
      { id: 'm-2', text: 'text-1', begin: 4, end: 7, precedence: 1, metadata: { form: 'ka' } },
      { id: 'm-3', text: 'text-1', begin: 4, end: 7, precedence: null, metadata: { form: 't' } },
      {
        id: 'm-4',
        text: 'text-1',
        begin: 4,
        end: 7,
        precedence: 2,
        metadata: { form: 'x', ...machine },
      },
    ]);
    const doc = docFor(raw, client);
    // Shown ka x t: x is the machine's and goes, t stays and takes slot 2.
    expect(formsOf(doc, 1)).toEqual(['ka', 'x', 't']);
    expect(await doc.discardWordAnalysis('w-2')).toBe(true);
    expect(formsOf(doc, 1)).toEqual(['ka', 't']);
    expect(precedenceUpdates(client)).toEqual([['m-3', 2]]);
  });

  it('Discard analysis numbers a lone survivor storing none', async () => {
    const client = makeFakeClient();
    const raw = kat([
      { id: 'm-2', text: 'text-1', begin: 4, end: 7, precedence: null, metadata: { form: 'ka' } },
      {
        id: 'm-3',
        text: 'text-1',
        begin: 4,
        end: 7,
        precedence: 2,
        metadata: { form: 't', prov: 'inferred', provSource: 'service:test' },
      },
    ]);
    const doc = docFor(raw, client);
    // Shown t ka: m-3 stores 2, m-2 none, so m-2 reads last and m-3 is first.
    expect(formsOf(doc, 1)).toEqual(['t', 'ka']);
    expect(await doc.discardWordAnalysis('w-2')).toBe(true);
    expect(precedenceUpdates(client)).toEqual(
      expect.arrayContaining([
        ['m-3', 1],
        ['m-2', 2],
      ]),
    );
  });

  it('Discard analysis stores the slot of a survivor that reads in place', async () => {
    const client = makeFakeClient();
    const raw = kat([
      { id: 'm-2', text: 'text-1', begin: 4, end: 7, precedence: 1, metadata: { form: 'ka' } },
      { id: 'm-3', text: 'text-1', begin: 4, end: 7, precedence: null, metadata: { form: 't' } },
    ]);
    raw.textLayers[0].tokenLayers[1].spanLayers[0].spans = [
      {
        id: 'p-2',
        tokens: ['w-2'],
        value: 'N',
        metadata: { prov: 'inferred', provSource: 'service:test' },
      },
    ];
    const doc = docFor(raw, client);
    expect(await doc.discardWordAnalysis('w-2')).toBe(true);
    expect(formsOf(doc, 1)).toEqual(['ka', 't']);
    expect(precedenceUpdates(client)).toEqual([['m-3', 2]]);
  });
});

// REV-FL F3: a merge shifts only the siblings storing a precedence past the
// target's, and numbers each sibling storing none from one past the highest
// stored, in the order it reads. An append lands past every sibling.
describe('a merge or append beside a morpheme storing no precedence', () => {
  const m = (id, precedence, form) => ({
    id,
    text: 'text-1',
    begin: 0,
    end: 6,
    precedence,
    metadata: { form },
  });
  const abcdef = (morphemes) =>
    buildRawDoc({ body: 'abcdef', words: [{ id: 'w-1', begin: 0, end: 6 }], morphemes });

  it('mergeMorphemes numbers a later sibling storing none past the stored ones', async () => {
    const client = makeFakeClient();
    const doc = docFor(
      abcdef([m('m-a', 1, 'ab'), m('m-b', 2, 'cd'), m('m-c', null, 'ef')]),
      client,
    );
    expect(await doc.mergeMorphemes('m-b')).toBe(true);
    expect(formsOf(doc, 0)).toEqual(['abcd', 'ef']);
    expect(precedenceUpdates(client)).toEqual([['m-c', 2]]);
  });

  it('mergeMorphemes of a target storing none shifts no stored sibling', async () => {
    const client = makeFakeClient();
    const doc = docFor(
      abcdef([m('m-a', 1, 'ab'), m('m-b', null, 'cd'), m('m-c', null, 'ef')]),
      client,
    );
    expect(await doc.mergeMorphemes('m-b')).toBe(true);
    expect(formsOf(doc, 0)).toEqual(['abcd', 'ef']);
    expect(precedenceUpdates(client)).toEqual([['m-c', 2]]);
  });

  it('mergeMorphemes still closes a gapped stored chain', async () => {
    const client = makeFakeClient();
    const doc = docFor(abcdef([m('m-a', 1, 'ab'), m('m-b', 3, 'cd'), m('m-c', 5, 'ef')]), client);
    expect(await doc.mergeMorphemes('m-b')).toBe(true);
    expect(formsOf(doc, 0)).toEqual(['abcd', 'ef']);
    expect(precedenceUpdates(client)).toEqual([['m-c', 4]]);
  });
});
