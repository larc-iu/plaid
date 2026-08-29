import { describe, it, expect, beforeEach } from 'vitest';
import { IgtDocument } from '../IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '../test-helpers.js';

// A document where "kat" (w-2) is analyzed as ka-t / cat-PL with a link on
// the first morpheme, and "the" (w-1) is an untouched default word.
const analyzedRaw = () => {
  const raw = buildRawDoc({
    body: 'the kat',
    morphemes: [
      { id: 'm-1', text: 'text-1', begin: 0, end: 3, precedence: 1, metadata: {} },
      { id: 'm-2', text: 'text-1', begin: 4, end: 7, precedence: 1, metadata: { form: 'ka' } },
      { id: 'm-3', text: 'text-1', begin: 4, end: 7, precedence: 2, metadata: { form: 't' } },
    ],
    morphVocabs: [
      {
        id: 'v1',
        name: 'Lex',
        vocabLinks: [{ id: 'l-1', tokens: ['m-2'], vocabItem: { id: 'i-ka', form: 'ka' } }],
      },
    ],
  });
  raw.textLayers[0].tokenLayers[2].spanLayers[0].spans = [
    { id: 'g-2', tokens: ['m-2'], value: 'cat' },
    { id: 'g-3', tokens: ['m-3'], value: 'PL' },
  ];
  raw.textLayers[0].tokenLayers[1].spanLayers[0].spans = [
    { id: 'p-2', tokens: ['w-2'], value: 'N' },
  ];
  return raw;
};

// The same document after the strip phase: one bare morpheme, nothing attached.
const strippedRaw = () =>
  buildRawDoc({
    body: 'the kat',
    morphemes: [
      { id: 'm-1', text: 'text-1', begin: 0, end: 3, precedence: 1, metadata: {} },
      { id: 'm-2', text: 'text-1', begin: 4, end: 7, precedence: 1, metadata: {} },
    ],
  });

// Fresh tables per call: IgtDocument folds document links INTO the vocab table
// it is handed (mergeRawVocabLinks), so a shared fixture would leak links
// between tests. The client mirrors the real one, whose vocabLayers.get
// returns a new object per request (with items, without links).
const project = { id: 'proj-1', vocabs: [{ id: 'v1' }] };
const vocabsOf = () => ({ v1: { id: 'v1', name: 'Lex', items: [{ id: 'i-kat', form: 'kat' }] } });
const clientFor = (opts) => {
  const client = makeFakeClient({ ...opts, project });
  client.vocabLayers.get = async (id) => vocabsOf()[id];
  return client;
};
const docFor = (raw, client) =>
  new IgtDocument({ raw, client, project, projectId: project.id, vocabularies: vocabsOf() });

const targetAnalysis = {
  word: { vocabItemId: null, fields: { POS: 'N' } },
  morphemes: [{ form: 'kat', morphType: null, vocabItemId: 'i-kat', fields: { Gloss: 'cat' } }],
};

describe('bulkReplaceAnalyses', () => {
  beforeEach(() => resetIds());

  it('strips the current analysis, resyncs, then applies the target as human work', async () => {
    const client = clientFor({ reloadDoc: strippedRaw() });
    const doc = docFor(analyzedRaw(), client);

    const n = await doc.bulkReplaceAnalyses([{ wordTokenId: 'w-2', analysis: targetAnalysis }]);
    expect(n).toBe(1);

    const kinds = client.calls.map((c) => c.kind);
    // One labeled operation for the whole thing.
    expect(client.calls[0]).toEqual({ kind: 'beginOperation', args: ['Re-analyze words'] });
    expect(kinds.filter((k) => k === 'beginOperation')).toHaveLength(1);

    // Strip phase: the word's span, the first morpheme's link + span, the
    // second morpheme deleted outright (its span cascades), first reset.
    const strip = client.calls.slice(0, kinds.indexOf('submitBatch'));
    expect(strip.map((c) => c.kind)).toEqual([
      'beginOperation',
      'spans.delete', // p-2 on the word
      'vocabLinks.delete', // l-1 on m-2
      'spans.delete', // g-2 on m-2
      'tokens.patchMetadata', // reset m-2
      'tokens.delete', // m-3
    ]);
    expect(strip[1].args).toEqual(['p-2']);
    expect(strip[2].args).toEqual(['l-1']);
    expect(strip[3].args).toEqual(['g-2']);
    expect(strip[4].args[0]).toBe('m-2');
    expect(strip[4].args[1]).toMatchObject({ form: null, morphType: null, prov: null });
    expect(strip[5].args).toEqual(['m-3']);
    // g-3 (on the deleted morpheme) is NOT queued: a double delete fails the batch.
    expect(strip.some((c) => c.kind === 'spans.delete' && c.args[0] === 'g-3')).toBe(false);

    // Apply phase (after the reload): the link, the gloss and the POS, with
    // NO provenance stamp.
    const apply = client.calls.slice(kinds.indexOf('submitBatch') + 1);
    const applyKinds = apply.map((c) => c.kind).filter((k) => k !== 'submitBatch');
    expect(applyKinds).toEqual(['vocabLinks.create', 'spans.create', 'spans.create']);
    expect(apply.find((c) => c.kind === 'vocabLinks.create').args).toEqual(['i-kat', ['m-2'], {}]);
    const gloss = apply.find((c) => c.kind === 'spans.create' && c.args[0] === 'msl-0');
    expect(gloss.args).toEqual(['msl-0', ['m-2'], 'cat', {}]);
    const pos = apply.find((c) => c.kind === 'spans.create' && c.args[0] === 'wsl-0');
    expect(pos.args).toEqual(['wsl-0', ['w-2'], 'N', {}]);
    // The first morpheme's form equals the word surface, so no metadata patch.
    expect(apply.some((c) => c.kind === 'tokens.patchMetadata')).toBe(false);
  });

  it('skips words that already carry exactly the target analysis', async () => {
    const client = clientFor();
    const doc = docFor(analyzedRaw(), client);
    const current = {
      word: { vocabItemId: null, fields: { POS: 'N' } },
      morphemes: [
        { form: 'ka', morphType: null, vocabItemId: 'i-ka', fields: { Gloss: 'cat' } },
        { form: 't', morphType: null, vocabItemId: null, fields: { Gloss: 'PL' } },
      ],
    };
    const n = await doc.bulkReplaceAnalyses([{ wordTokenId: 'w-2', analysis: current }]);
    expect(n).toBe(0);
    expect(client.calls).toEqual([]);
  });

  it('bulkApplyAnalyses still stamps copies as inferred', async () => {
    const client = clientFor({ reloadDoc: strippedRaw() });
    const doc = docFor(strippedRaw(), client);
    const n = await doc.bulkApplyAnalyses(
      [{ wordTokenId: 'w-2', analysis: targetAnalysis }],
      'rule:test',
    );
    expect(n).toBe(1);
    const link = client.calls.find((c) => c.kind === 'vocabLinks.create');
    expect(link.args[2]).toMatchObject({ prov: 'inferred', provSource: 'rule:test' });
    expect(client.calls[0]).toEqual({
      kind: 'beginOperation',
      args: ['Copy previous analyses'],
    });
  });
});
