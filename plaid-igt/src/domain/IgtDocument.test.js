import { describe, it, expect, beforeEach } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from './test-helpers.js';

// Build a doc wired to a fake client. `raw`/`project`/`vocabularies` overridable.
function makeDoc({ raw, project, vocabularies, client } = {}) {
  raw = raw ?? buildRawDoc();
  client = client ?? makeFakeClient();
  return new IgtDocument({
    raw,
    project: project ?? { id: 'proj-1', vocabs: [], config: { plaid: {} } },
    vocabularies: vocabularies ?? {},
    client,
    projectId: 'proj-1',
  });
}

// Pull the call kinds in order (to assert batch ordering).
const kinds = (client) => client.calls.map((c) => c.kind);

beforeEach(() => resetIds());

describe('layerInfo + derive', () => {
  it('resolves the IGT layer hierarchy from config flags', () => {
    const doc = makeDoc();
    const info = doc.layerInfo;
    expect(info.primaryTextLayer?.id).toBe('tl-1');
    expect(info.primaryTokenLayer?.id).toBe('wordL');
    expect(info.sentenceTokenLayer?.id).toBe('sentL');
    expect(info.morphemeTokenLayer?.id).toBe('morphL');
    expect(info.alignmentTokenLayer?.id).toBe('alignL');
    expect(info.spanLayers.word.map((l) => l.name)).toEqual(['POS']);
    expect(info.spanLayers.morpheme.map((l) => l.name)).toEqual(['Gloss']);
    expect(info.spanLayers.sentence.map((l) => l.name)).toEqual(['Translation']);
  });

  it('derives sentences > tokens > morphemes with content + annotations scaffold', () => {
    const doc = makeDoc();
    expect(doc.sentences).toHaveLength(1);
    const s = doc.sentences[0];
    expect(s.tokens.map((t) => t.content)).toEqual(['the', 'cat']);
    expect(s.annotations).toHaveProperty('Translation', null);
    const t0 = s.tokens[0];
    expect(t0.annotations).toHaveProperty('POS', null);
    expect(t0.orthographies).toHaveProperty('IPA', '');
    expect(t0.morphemes).toHaveLength(1);
    expect(t0.morphemes[0].annotations).toHaveProperty('Gloss', null);
  });

  it('groups morphemes under their parent word by shared extent, ordered by precedence', () => {
    const raw = buildRawDoc({
      words: [{ id: 'w-1', begin: 0, end: 3 }],
      morphemes: [
        { id: 'm-2', begin: 0, end: 3, precedence: 2, metadata: { form: 'b' } },
        { id: 'm-1', begin: 0, end: 3, precedence: 1, metadata: { form: 'a' } },
      ],
      body: 'abc',
    });
    const doc = makeDoc({ raw });
    const ms = doc.sentences[0].tokens[0].morphemes;
    expect(ms.map((m) => m.id)).toEqual(['m-1', 'm-2']);
    expect(ms.map((m) => m.metadata.form)).toEqual(['a', 'b']);
  });
});

describe('span (annotation) mutations', () => {
  it('updateTokenSpan creates a span when none exists, reflected in doc.sentences', async () => {
    const doc = makeDoc();
    const ok = await doc.updateTokenSpan('w-1', 'POS', 'DET');
    expect(ok).toBe(true);
    expect(kinds(doc.client)).toContain('spans.create');
    expect(doc.sentences[0].tokens[0].annotations.POS?.value).toBe('DET');
  });

  it('span updaters pass provenance metadata through to create', async () => {
    const doc = makeDoc();
    const prov = { prov: 'inferred', provSource: 'gloss:doc-frequency', provConfirmed: true };
    const ok = await doc.updateTokenSpan('w-1', 'POS', 'DET', prov);
    expect(ok).toBe(true);
    const create = doc.client.calls.find((c) => c.kind === 'spans.create');
    expect(create.args[3]).toEqual(prov);
    // Human edits (no metadata) keep the 4-arg slot empty.
    await doc.updateTokenSpan('w-2', 'POS', 'NOUN');
    const create2 = doc.client.calls.filter((c) => c.kind === 'spans.create')[1];
    expect(create2.args[3]).toBeUndefined();
  });

  it('updateTokenSpan updates an existing span instead of creating', async () => {
    const raw = buildRawDoc();
    raw.textLayers[0].tokenLayers[1].spanLayers[0].spans = [
      { id: 'sp-1', tokens: ['w-1'], value: 'DET' },
    ];
    const doc = makeDoc({ raw });
    const ok = await doc.updateTokenSpan('w-1', 'POS', 'NOUN');
    expect(ok).toBe(true);
    expect(kinds(doc.client)).toContain('spans.update');
    expect(kinds(doc.client)).not.toContain('spans.create');
    expect(doc.sentences[0].tokens[0].annotations.POS.value).toBe('NOUN');
  });

  it('a human edit of a machine-made span verifies it (provConfirmed merged)', async () => {
    const raw = buildRawDoc();
    raw.textLayers[0].tokenLayers[1].spanLayers[0].spans = [
      {
        id: 'sp-1',
        tokens: ['w-1'],
        value: 'DET',
        metadata: { prov: 'inferred', provSource: 'service:stanza-parser' },
      },
    ];
    const doc = makeDoc({ raw });
    const ok = await doc.updateTokenSpan('w-1', 'POS', 'NOUN'); // no metadata = human
    expect(ok).toBe(true);
    const setMeta = doc.client.calls.find((c) => c.kind === 'spans.setMetadata');
    expect(setMeta).toBeTruthy();
    expect(setMeta.args[1]).toEqual({
      prov: 'inferred',
      provSource: 'service:stanza-parser',
      provConfirmed: true,
    });
    // The optimistic patch carries the verified metadata too.
    expect(doc.sentences[0].tokens[0].annotations.POS.metadata.provConfirmed).toBe(true);
  });

  it('a human edit of a human span stays a plain update (no metadata write)', async () => {
    const raw = buildRawDoc();
    raw.textLayers[0].tokenLayers[1].spanLayers[0].spans = [
      { id: 'sp-1', tokens: ['w-1'], value: 'DET' },
    ];
    const doc = makeDoc({ raw });
    await doc.updateTokenSpan('w-1', 'POS', 'NOUN');
    expect(kinds(doc.client)).not.toContain('spans.setMetadata');
  });

  it('re-committing the same value on a machine span writes nothing (retyping never confirms)', async () => {
    const raw = buildRawDoc();
    raw.textLayers[0].tokenLayers[1].spanLayers[0].spans = [
      {
        id: 'sp-1',
        tokens: ['w-1'],
        value: 'DET',
        metadata: { prov: 'inferred', provSource: 'service:stanza-parser' },
      },
    ];
    const doc = makeDoc({ raw });
    const ok = await doc.updateTokenSpan('w-1', 'POS', 'DET');
    expect(ok).toBe(true);
    expect(kinds(doc.client).filter((k) => k.startsWith('spans.'))).toEqual([]);
    expect(doc.sentences[0].tokens[0].annotations.POS.metadata.provConfirmed).toBeUndefined();
  });

  it('a human edit of an already-verified span stays a plain update', async () => {
    const raw = buildRawDoc();
    raw.textLayers[0].tokenLayers[1].spanLayers[0].spans = [
      {
        id: 'sp-1',
        tokens: ['w-1'],
        value: 'DET',
        metadata: { prov: 'inferred', provSource: 'x', provConfirmed: true },
      },
    ];
    const doc = makeDoc({ raw });
    await doc.updateTokenSpan('w-1', 'POS', 'NOUN');
    expect(kinds(doc.client)).not.toContain('spans.setMetadata');
  });

  it('updateMorphemeSpan upserts on the morpheme', async () => {
    const doc = makeDoc();
    await doc.updateMorphemeSpan('m-1', 'Gloss', 'the');
    expect(doc.sentences[0].tokens[0].morphemes[0].annotations.Gloss?.value).toBe('the');
  });

  it('updateSentenceSpan upserts on the sentence', async () => {
    const doc = makeDoc();
    await doc.updateSentenceSpan('s-1', 'Translation', 'the cat');
    expect(doc.sentences[0].annotations.Translation?.value).toBe('the cat');
  });

  it('updateTokenSpan surfaces a guard error for an unknown field', async () => {
    const doc = makeDoc();
    const ok = await doc.updateTokenSpan('w-1', 'Nonexistent', 'x');
    expect(ok).toBe(false);
    expect(doc.error).toMatch(/not found/i);
  });
});

describe('orthography + morpheme form', () => {
  it('updateOrthography writes orthog:<name> metadata, reflected in token.orthographies', async () => {
    const doc = makeDoc();
    await doc.updateOrthography('w-1', 'IPA', 'ðə');
    const meta = doc.client.calls.find((c) => c.kind === 'tokens.setMetadata').args[1];
    expect(meta['orthog:IPA']).toBe('ðə');
    expect(doc.sentences[0].tokens[0].orthographies.IPA).toBe('ðə');
  });

  it('updateMorphemeForm sets metadata.form', async () => {
    const doc = makeDoc();
    await doc.updateMorphemeForm('m-1', 'THE');
    expect(doc.sentences[0].tokens[0].morphemes[0].metadata.form).toBe('THE');
  });

  it('updateMorphemeForm PATCHES metadata — other keys (morphType) survive', async () => {
    const raw = buildRawDoc({
      words: [{ id: 'w-1', begin: 0, end: 3 }],
      morphemes: [
        { id: 'm-1', begin: 0, end: 3, precedence: 1, metadata: { form: 'ab', morphType: 'stem' } },
      ],
      body: 'abc',
    });
    const doc = makeDoc({ raw });
    await doc.updateMorphemeForm('m-1', 'cd');
    expect(kinds(doc.client)).toContain('tokens.patchMetadata');
    expect(kinds(doc.client)).not.toContain('tokens.setMetadata');
    const m = doc.sentences[0].tokens[0].morphemes[0];
    expect(m.metadata).toEqual({ form: 'cd', morphType: 'stem' });
  });
});

describe('morpheme type', () => {
  const typedDoc = () =>
    makeDoc({
      raw: buildRawDoc({
        words: [{ id: 'w-1', begin: 0, end: 3 }],
        morphemes: [
          {
            id: 'm-1',
            begin: 0,
            end: 3,
            precedence: 1,
            metadata: { form: 'ab', morphType: 'stem' },
          },
        ],
        body: 'abc',
      }),
    });

  it('setMorphemeType patches metadata.morphType from the FLEx inventory', async () => {
    const doc = typedDoc();
    const ok = await doc.setMorphemeType('m-1', 'enclitic');
    expect(ok).toBe(true);
    const call = doc.client.calls.find((c) => c.kind === 'tokens.patchMetadata');
    expect(call.args[1]).toEqual({ morphType: 'enclitic' });
    expect(doc.sentences[0].tokens[0].morphemes[0].metadata).toEqual({
      form: 'ab',
      morphType: 'enclitic',
    });
  });

  it('setMorphemeType(null) clears the type (patch null deletes the key)', async () => {
    const doc = typedDoc();
    await doc.setMorphemeType('m-1', null);
    const call = doc.client.calls.find((c) => c.kind === 'tokens.patchMetadata');
    expect(call.args[1]).toEqual({ morphType: null });
    expect(doc.sentences[0].tokens[0].morphemes[0].metadata).toEqual({ form: 'ab' });
  });

  it('rejects a type outside the FLEx inventory without a server call', async () => {
    const doc = typedDoc();
    const ok = await doc.setMorphemeType('m-1', 'sufix');
    expect(ok).toBe(false);
    expect(doc.error).toMatch(/unknown morpheme type/i);
    expect(doc.client.calls).toHaveLength(0);
  });
});

describe('morph type from the linked lexicon entry', () => {
  const linkedDoc = (itemType, tokenType = 'suffix') =>
    makeDoc({
      raw: buildRawDoc({
        words: [{ id: 'w-1', begin: 0, end: 3 }],
        morphemes: [
          { id: 'm-1', begin: 0, end: 3, precedence: 1, metadata: { form: 'ab' } },
          {
            id: 'm-2',
            begin: 0,
            end: 3,
            precedence: 2,
            metadata: { form: 'c', morphType: tokenType },
          },
        ],
        body: 'abc',
      }),
      vocabularies: {
        v1: {
          id: 'v1',
          name: 'Lexicon',
          items: [{ id: 'i1', form: 'c', metadata: itemType ? { morphType: itemType } : {} }],
          vocabLinks: [
            {
              id: 'lk-1',
              tokens: ['m-2'],
              vocabItem: { id: 'i1', form: 'c', metadata: itemType ? { morphType: itemType } : {} },
            },
          ],
        },
      },
    });

  it('the entry type overrides the token cache in the derived view', () => {
    const doc = linkedDoc('enclitic');
    const ms = doc.sentences[0].tokens[0].morphemes;
    expect(ms[1].morphType).toBe('enclitic');
    expect(ms[1].metadata.morphType).toBe('suffix'); // the cache is untouched by derive
    expect(ms[0].morphType).toBeNull();
  });

  it('an entry without a type does not override', () => {
    const doc = linkedDoc(null);
    expect(doc.sentences[0].tokens[0].morphemes[1].morphType).toBe('suffix');
  });

  it('reconcileOnOpen re-syncs a drifted cache from the entry', async () => {
    const doc = linkedDoc('enclitic');
    const res = await doc.reconcileOnOpen();
    expect(res.syncedMorphTypes).toBe(1);
    const call = doc.client.calls.find((c) => c.kind === 'tokens.patchMetadata');
    expect(call.args).toEqual(['m-2', { morphType: 'enclitic' }]);
    expect(doc.sentences[0].tokens[0].morphemes[1].metadata.morphType).toBe('enclitic');
    // idempotent
    doc.client.calls.length = 0;
    const again = await doc.reconcileOnOpen();
    expect(again.syncedMorphTypes).toBe(0);
    expect(doc.client.calls.filter((c) => c.kind === 'tokens.patchMetadata')).toHaveLength(0);
  });

  it('setVocabItemMorphType patches the entry AND the linked morphemes in one batch', async () => {
    const doc = linkedDoc('enclitic');
    const ok = await doc.setVocabItemMorphType('v1', 'i1', 'proclitic');
    expect(ok).toBe(true);
    const k = kinds(doc.client);
    expect(k).toContain('vocabItems.patchMetadata');
    const tokPatch = doc.client.calls.find((c) => c.kind === 'tokens.patchMetadata');
    expect(tokPatch.args).toEqual(['m-2', { morphType: 'proclitic' }]);
    expect(k.indexOf('submitBatch')).toBeGreaterThan(k.indexOf('vocabItems.patchMetadata'));
    const m = doc.sentences[0].tokens[0].morphemes[1];
    expect(m.morphType).toBe('proclitic');
    expect(m.vocabItem.metadata.morphType).toBe('proclitic');
    expect(doc.vocabularies.v1.items[0].metadata.morphType).toBe('proclitic');
  });

  it('clearing the entry type stops overriding and leaves the cache alone', async () => {
    const doc = linkedDoc('enclitic');
    await doc.setVocabItemMorphType('v1', 'i1', null);
    expect(doc.client.calls.filter((c) => c.kind === 'tokens.patchMetadata')).toHaveLength(0);
    const m = doc.sentences[0].tokens[0].morphemes[1];
    expect(m.vocabItem.metadata.morphType).toBeUndefined();
    expect(m.morphType).toBe('suffix');
  });
});

describe('morpheme structural ops', () => {
  it('createMorpheme appends with precedence = count + 1', async () => {
    const doc = makeDoc();
    await doc.createMorpheme('w-1', 'ka');
    const ms = doc.sentences[0].tokens[0].morphemes;
    expect(ms).toHaveLength(2);
    expect(ms[1].precedence).toBe(2);
    expect(ms[1].metadata.form).toBe('ka');
  });

  it('splitMorpheme batches setMetadata then shifts then create (create last)', async () => {
    const raw = buildRawDoc({
      words: [{ id: 'w-1', begin: 0, end: 3 }],
      morphemes: [
        { id: 'm-1', begin: 0, end: 3, precedence: 1, metadata: { form: 'ab' } },
        { id: 'm-2', begin: 0, end: 3, precedence: 2, metadata: { form: 'c' } },
      ],
      body: 'abc',
    });
    const doc = makeDoc({ raw });
    await doc.splitMorpheme('m-1', 'a', 'b');
    // ordering: patchMetadata (m-1), update (shift m-2), create (new), submitBatch
    const k = kinds(doc.client);
    const iMeta = k.indexOf('tokens.patchMetadata');
    const iShift = k.indexOf('tokens.update');
    const iCreate = k.indexOf('tokens.create');
    expect(iMeta).toBeGreaterThanOrEqual(0);
    expect(iShift).toBeGreaterThan(iMeta);
    expect(iCreate).toBeGreaterThan(iShift);
    const ms = doc.sentences[0].tokens[0].morphemes;
    expect(ms.map((m) => m.metadata.form)).toEqual(['a', 'b', 'c']);
    expect(ms.map((m) => m.precedence)).toEqual([1, 2, 3]);
  });

  it('splitMorphemeMulti replaces one morpheme with an N-segment chain (paste-split)', async () => {
    const raw = buildRawDoc({
      words: [{ id: 'w-1', begin: 0, end: 6 }],
      morphemes: [
        { id: 'm-1', begin: 0, end: 6, precedence: 1, metadata: { form: 'abcd' } },
        { id: 'm-2', begin: 0, end: 6, precedence: 2, metadata: { form: 'ef' } },
      ],
      body: 'abcdef',
    });
    const doc = makeDoc({ raw });
    await doc.splitMorphemeMulti('m-1', ['a', 'bc', 'd']);
    const k = kinds(doc.client);
    // patchMetadata, shift (+2 for m-2), then BOTH creates after the shift.
    expect(k.filter((x) => x === 'tokens.create')).toHaveLength(2);
    expect(k.indexOf('tokens.update')).toBeGreaterThan(k.indexOf('tokens.patchMetadata'));
    expect(k.indexOf('tokens.create')).toBeGreaterThan(k.indexOf('tokens.update'));
    const ms = doc.sentences[0].tokens[0].morphemes;
    expect(ms.map((m) => m.metadata.form)).toEqual(['a', 'bc', 'd', 'ef']);
    expect(ms.map((m) => m.precedence)).toEqual([1, 2, 3, 4]);
    // m-1 survives as the first segment (annotations/links stay attached to it).
    expect(ms[0].id).toBe('m-1');
  });

  it('splitMorpheme with "=" types the clitic side (right edge → enclitic on the new piece)', async () => {
    const raw = buildRawDoc({
      words: [{ id: 'w-1', begin: 0, end: 3 }],
      morphemes: [{ id: 'm-1', begin: 0, end: 3, precedence: 1, metadata: { form: 'abc' } }],
      body: 'abc',
    });
    const doc = makeDoc({ raw });
    await doc.splitMorpheme('m-1', 'ab', 'c', '=');
    const ms = doc.sentences[0].tokens[0].morphemes;
    expect(ms.map((m) => m.metadata.form)).toEqual(['ab', 'c']);
    expect(ms.map((m) => m.metadata.morphType ?? null)).toEqual([null, 'enclitic']);
  });

  it('splitMorphemeMulti joiners: left-edge "=" makes the surviving piece a proclitic', async () => {
    const raw = buildRawDoc({
      words: [{ id: 'w-1', begin: 0, end: 4 }],
      morphemes: [{ id: 'm-1', begin: 0, end: 4, precedence: 1, metadata: { form: 'abcd' } }],
      body: 'abcd',
    });
    const doc = makeDoc({ raw });
    await doc.splitMorphemeMulti('m-1', ['a', 'bc', 'd'], { joiners: ['=', '-'] });
    const ms = doc.sentences[0].tokens[0].morphemes;
    expect(ms.map((m) => m.metadata.form)).toEqual(['a', 'bc', 'd']);
    expect(ms.map((m) => m.metadata.morphType ?? null)).toEqual(['proclitic', null, null]);
    // the stamp rode on the same patch as the form (one op for m-1)
    expect(kinds(doc.client).filter((x) => x === 'tokens.patchMetadata')).toHaveLength(1);
  });

  it('splitMorphemeMulti never overwrites an existing morphType', async () => {
    const raw = buildRawDoc({
      words: [{ id: 'w-1', begin: 0, end: 2 }],
      morphemes: [
        { id: 'm-1', begin: 0, end: 2, precedence: 1, metadata: { form: 'ab', morphType: 'stem' } },
      ],
      body: 'ab',
    });
    const doc = makeDoc({ raw });
    // two-morpheme word → enclitic on the right piece; the stem stays a stem
    await doc.splitMorpheme('m-1', 'a', 'b', '=');
    const ms = doc.sentences[0].tokens[0].morphemes;
    expect(ms.map((m) => m.metadata.morphType ?? null)).toEqual(['stem', 'enclitic']);
  });

  it('mergeMorphemes concatenates forms into predecessor and renumbers', async () => {
    const raw = buildRawDoc({
      words: [{ id: 'w-1', begin: 0, end: 3 }],
      morphemes: [
        { id: 'm-1', begin: 0, end: 3, precedence: 1, metadata: { form: 'a' } },
        { id: 'm-2', begin: 0, end: 3, precedence: 2, metadata: { form: 'b' } },
        { id: 'm-3', begin: 0, end: 3, precedence: 3, metadata: { form: 'c' } },
      ],
      body: 'abc',
    });
    const doc = makeDoc({ raw });
    await doc.mergeMorphemes('m-2');
    const ms = doc.sentences[0].tokens[0].morphemes;
    expect(ms.map((m) => m.metadata.form)).toEqual(['ab', 'c']);
    expect(ms.map((m) => m.precedence)).toEqual([1, 2]);
  });

  it('mergeMorphemes is a silent no-op on the first morpheme', async () => {
    const doc = makeDoc();
    const ok = await doc.mergeMorphemes('m-1');
    expect(ok).toBe(false);
    expect(doc.error).toBe('');
  });

  it('deleteMorpheme refuses to delete the last morpheme of a word', async () => {
    const doc = makeDoc();
    const ok = await doc.deleteMorpheme('m-1');
    expect(ok).toBe(false);
    expect(doc.error).toMatch(/last morpheme/i);
  });

  it('deleteMorpheme removes a non-last morpheme and renumbers', async () => {
    const raw = buildRawDoc({
      words: [{ id: 'w-1', begin: 0, end: 3 }],
      morphemes: [
        { id: 'm-1', begin: 0, end: 3, precedence: 1, metadata: { form: 'a' } },
        { id: 'm-2', begin: 0, end: 3, precedence: 2, metadata: { form: 'b' } },
      ],
      body: 'abc',
    });
    const doc = makeDoc({ raw });
    await doc.deleteMorpheme('m-1');
    const ms = doc.sentences[0].tokens[0].morphemes;
    expect(ms.map((m) => m.id)).toEqual(['m-2']);
    expect(ms[0].precedence).toBe(1);
  });
});

describe('word-token structural ops', () => {
  it('splitToken adjusts the left end and inserts a right token', async () => {
    const raw = buildRawDoc({
      words: [{ id: 'w-1', begin: 0, end: 7 }],
      morphemes: [],
      body: 'the cat',
    });
    const doc = makeDoc({ raw });
    await doc.splitToken('w-1', 2); // split after index 2 -> leftEnd = 0+2+1 = 3
    const toks = doc.sentences[0].tokens;
    expect(toks).toHaveLength(2);
    expect(toks[0].end).toBe(3);
    expect(toks[1].begin).toBe(3);
    expect(toks[1].end).toBe(7);
  });

  it('splitToken deletes a coincident morpheme in the same batch', async () => {
    const raw = buildRawDoc({
      words: [{ id: 'w-1', begin: 0, end: 7 }],
      morphemes: [{ id: 'm-1', begin: 0, end: 7, precedence: 1, metadata: {} }],
      body: 'the cat',
    });
    const doc = makeDoc({ raw });
    await doc.splitToken('w-1', 2);
    expect(kinds(doc.client)).toContain('tokens.bulkDelete');
    expect(doc.sentences[0].tokens[0].morphemes).toHaveLength(0);
  });

  it('mergeTokens grows the first token and drops the rest', async () => {
    const raw = buildRawDoc({
      words: [
        { id: 'w-1', begin: 0, end: 3 },
        { id: 'w-2', begin: 4, end: 7 },
      ],
      morphemes: [],
      body: 'the cat',
    });
    const doc = makeDoc({ raw });
    await doc.mergeTokens(['w-1', 'w-2']);
    const toks = doc.sentences[0].tokens;
    expect(toks).toHaveLength(1);
    expect(toks[0].id).toBe('w-1');
    expect(toks[0].end).toBe(7);
  });

  it('mergeTokens reparents word-scope spans + vocab links onto the survivor', async () => {
    // Mirrors the server cascade (token.clj merge-tokens reparents spans/links
    // off the merged-away token); the optimistic patch must too, or they'd
    // vanish from the UI until a reload.
    const raw = buildRawDoc({
      words: [
        { id: 'w-1', begin: 0, end: 3 },
        { id: 'w-2', begin: 4, end: 7 },
      ],
      morphemes: [],
      body: 'the cat',
      // Annotation + vocab link live on the SECOND (merged-away) word.
      wordVocabs: [
        {
          id: 'v1',
          name: 'Lexicon',
          vocabLinks: [
            { id: 'lk-1', tokens: ['w-2'], vocabItem: { id: 'vi-1', form: 'CAT', metadata: {} } },
          ],
        },
      ],
    });
    raw.textLayers[0].tokenLayers[1].spanLayers[0].spans = [
      { id: 'sp-1', tokens: ['w-2'], value: 'N' },
    ];
    const doc = makeDoc({
      raw,
      project: { id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {} } },
      vocabularies: { v1: { id: 'v1', name: 'Lexicon', items: [], vocabLinks: [] } },
    });
    await doc.mergeTokens(['w-1', 'w-2']);
    const toks = doc.sentences[0].tokens;
    expect(toks).toHaveLength(1);
    expect(toks[0].id).toBe('w-1');
    // The POS annotation and vocab link followed onto the surviving token.
    expect(toks[0].annotations.POS?.value).toBe('N');
    expect(toks[0].vocabItem?.form).toBe('CAT');
  });

  it("mergeTokens keeps the survivor's own vocab link and deletes the reparented one", async () => {
    // Both words are linked (word-level). The server reparents w-2's link onto
    // w-1, which would leave two links on one token — invisible and un-unlinkable
    // in the editor — so the merge dedups: the survivor's own link wins.
    const raw = buildRawDoc({
      words: [
        { id: 'w-1', begin: 0, end: 3 },
        { id: 'w-2', begin: 4, end: 7 },
      ],
      morphemes: [],
      body: 'the cat',
      wordVocabs: [
        {
          id: 'v1',
          name: 'Lexicon',
          vocabLinks: [
            { id: 'lk-2', tokens: ['w-2'], vocabItem: { id: 'vi-2', form: 'CAT', metadata: {} } },
            { id: 'lk-1', tokens: ['w-1'], vocabItem: { id: 'vi-1', form: 'THE', metadata: {} } },
          ],
        },
      ],
    });
    const doc = makeDoc({
      raw,
      project: { id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {} } },
      vocabularies: { v1: { id: 'v1', name: 'Lexicon', items: [], vocabLinks: [] } },
    });
    await doc.mergeTokens(['w-1', 'w-2']);
    const toks = doc.sentences[0].tokens;
    expect(toks).toHaveLength(1);
    expect(toks[0].vocabItem?.form).toBe('THE');
    const dels = doc.client.calls.filter((c) => c.kind === 'vocabLinks.delete');
    expect(dels.map((c) => c.args[0])).toEqual(['lk-2']);
    expect(doc.vocabularies.v1.vocabLinks.map((l) => l.id)).toEqual(['lk-1']);
  });

  it('deleteToken cascades to coincident morphemes and their spans', async () => {
    const raw = buildRawDoc({
      words: [
        { id: 'w-1', begin: 0, end: 3 },
        { id: 'w-2', begin: 4, end: 7 },
      ],
      morphemes: [{ id: 'm-1', begin: 0, end: 3, precedence: 1, metadata: {} }],
      body: 'the cat',
    });
    raw.textLayers[0].tokenLayers[1].spanLayers[0].spans = [
      { id: 'sp-1', tokens: ['w-1'], value: 'DET' },
    ];
    const doc = makeDoc({ raw });
    await doc.deleteToken('w-1');
    const toks = doc.sentences[0].tokens;
    expect(toks.map((t) => t.id)).toEqual(['w-2']);
  });
});

describe('sentence boundary ops', () => {
  it('splitSentence refuses to split at the first character', async () => {
    const doc = makeDoc();
    const ok = await doc.splitSentence(0);
    expect(ok).toBe(false);
    expect(doc.error).toMatch(/first character/i);
  });

  it('splitSentence partitions into two contiguous sentences', async () => {
    const doc = makeDoc({ raw: buildRawDoc({ body: 'the cat' }) });
    await doc.splitSentence(4);
    const ss = doc.sentences;
    expect(ss).toHaveLength(2);
    expect(ss[0].begin).toBe(0);
    expect(ss[0].end).toBe(4);
    expect(ss[1].begin).toBe(4);
  });

  it('mergeSentence reparents the merged-away sentence spans onto prev', async () => {
    // Two sentences; a Translation annotation lives on the SECOND one. After
    // merging it into the first, the server reparents that span onto the
    // survivor — the optimistic patch must mirror it.
    const raw = buildRawDoc({
      body: 'the cat',
      sentences: [
        { id: 's-1', begin: 0, end: 4 },
        { id: 's-2', begin: 4, end: 7 },
      ],
    });
    raw.textLayers[0].tokenLayers[0].spanLayers[0].spans = [
      { id: 'tr-2', tokens: ['s-2'], value: 'the cat (gloss)' },
    ];
    const doc = makeDoc({ raw });
    expect(doc.sentences).toHaveLength(2);
    await doc.mergeSentence('s-2');
    const ss = doc.sentences;
    expect(ss).toHaveLength(1);
    expect(ss[0].id).toBe('s-1');
    expect(ss[0].end).toBe(7);
    // The translation followed onto the surviving sentence.
    expect(ss[0].annotations.Translation?.value).toBe('the cat (gloss)');
  });
});

describe('vocab links (read path must reflect optimistic write)', () => {
  const vocabularies = () => ({
    v1: {
      id: 'v1',
      name: 'Lexicon',
      items: [{ id: 'vi-1', form: 'CAT', metadata: {} }],
      vocabLinks: [],
    },
  });

  it('linkVocab attaches the vocab item to the token in doc.sentences', async () => {
    const doc = makeDoc({
      project: { id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {} } },
      vocabularies: vocabularies(),
    });
    const ok = await doc.linkVocab('w-2', 'vi-1');
    expect(ok).toBe(true);
    // This is the read/write consistency check: derive must read links from
    // _vocabularies (the loaded project vocab table), not layer.vocabs.
    expect(doc.sentences[0].tokens[1].vocabItem?.form).toBe('CAT');
  });

  it('unlinkVocab removes the vocab item from the token', async () => {
    const vocabs = vocabularies();
    vocabs.v1.vocabLinks = [
      { id: 'lk-1', tokens: ['w-2'], vocabItem: { id: 'vi-1', form: 'CAT', metadata: {} } },
    ];
    const doc = makeDoc({
      project: { id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {} } },
      vocabularies: vocabs,
    });
    expect(doc.sentences[0].tokens[1].vocabItem?.form).toBe('CAT');
    await doc.unlinkVocab('w-2');
    expect(doc.sentences[0].tokens[1].vocabItem).toBeNull();
  });

  // Regression: `vocabLayers.get` (the source of `_vocabularies`) does NOT
  // return vocab-links — they're embedded in the document GET under each token
  // layer's `.vocabs[].vocabLinks`. If those aren't folded into `_vocabularies`,
  // links only ever exist as in-session optimistic patches and vanish on the
  // next load (looking deleted even though they're still on the server).
  it('surfaces vocab-links embedded in raw even when _vocabularies has none', () => {
    const raw = buildRawDoc({
      morphVocabs: [
        {
          id: 'v1',
          name: 'Lexicon',
          vocabLinks: [
            { id: 'lk-1', tokens: ['m-2'], vocabItem: { id: 'vi-1', form: 'DOG', metadata: {} } },
          ],
        },
      ],
      wordVocabs: [
        {
          id: 'v1',
          name: 'Lexicon',
          vocabLinks: [
            { id: 'lk-2', tokens: ['w-1'], vocabItem: { id: 'vi-2', form: 'THE', metadata: {} } },
          ],
        },
      ],
    });
    // _vocabularies has the layer + items but NO links (mirrors vocabLayers.get).
    const doc = makeDoc({
      raw,
      project: { id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {} } },
      vocabularies: { v1: { id: 'v1', name: 'Lexicon', items: [], vocabLinks: [] } },
    });
    // Word link (w-1) and morpheme link (m-2, second word's morpheme) both show.
    expect(doc.sentences[0].tokens[0].vocabItem?.form).toBe('THE');
    expect(doc.sentences[0].tokens[1].morphemes[0].vocabItem?.form).toBe('DOG');
  });
});

describe('atAsOf (time-travel)', () => {
  const project = { id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {} } };
  const linkOn = (tokenId, linkId, form) => ({
    id: 'v1',
    name: 'Lexicon',
    vocabLinks: [
      { id: linkId, tokens: [tokenId], vocabItem: { id: 'vi-' + linkId, form, metadata: {} } },
    ],
  });

  // Time-travel used to re-run the whole four-request load. atAsOf re-reads only
  // the document, so the vocabulary ITEMS must be carried over from the live doc
  // while the LINKS must come from the snapshot being loaded.
  it('reads only the document and reuses project, vocab items and item levels', async () => {
    const liveRaw = buildRawDoc({ wordVocabs: [linkOn('w-1', 'lk-live', 'NOW')] });
    const snapRaw = buildRawDoc({ wordVocabs: [linkOn('w-1', 'lk-old', 'THEN')] });

    const client = makeFakeClient();
    const asked = [];
    client.documents = {
      ...client.documents,
      get: async (id, includeBody, at) => {
        asked.push({ id, includeBody, at });
        return snapRaw;
      },
    };
    const doc = new IgtDocument({
      raw: liveRaw,
      project,
      vocabularies: {
        v1: { id: 'v1', name: 'Lexicon', items: [{ id: 'vi-1', form: 'NOW' }], vocabLinks: [] },
      },
      client,
      projectId: 'proj-1',
    });

    const at = '2026-08-28T13:46:43Z';
    const next = await doc.atAsOf(at);

    // Exactly one request, and it carries the as-of.
    expect(asked).toEqual([{ id: liveRaw.id, includeBody: true, at }]);
    expect(next.asOf).toBe(at);
    // Snapshot-independent state is carried over, not refetched.
    expect(next.project).toBe(project);
    expect(next.vocabularies.v1.items).toEqual([{ id: 'vi-1', form: 'NOW' }]);
    // The ORIGINAL doc is untouched, so the caller can keep rendering it.
    expect(doc.asOf).toBeNull();
    expect(doc.sentences[0].tokens[0].vocabItem?.form).toBe('NOW');
  });

  it("shows the snapshot's vocab links, not the live document's", async () => {
    const liveRaw = buildRawDoc({ wordVocabs: [linkOn('w-1', 'lk-live', 'NOW')] });
    const snapRaw = buildRawDoc({ wordVocabs: [linkOn('w-1', 'lk-old', 'THEN')] });
    const client = makeFakeClient();
    client.documents = { ...client.documents, get: async () => snapRaw };
    const doc = new IgtDocument({
      raw: liveRaw,
      project,
      vocabularies: { v1: { id: 'v1', name: 'Lexicon', items: [], vocabLinks: [] } },
      client,
      projectId: 'proj-1',
    });
    expect(doc.sentences[0].tokens[0].vocabItem?.form).toBe('NOW');

    const next = await doc.atAsOf('2026-08-28T13:46:43Z');
    // The snapshot's link is present...
    expect(next.sentences[0].tokens[0].vocabItem?.form).toBe('THEN');
    // ...and the live doc's link did NOT leak across (the reason atAsOf strips
    // the folded links before handing the vocab table to the constructor).
    expect(next.vocabularies.v1.vocabLinks.map((l) => l.id)).toEqual(['lk-old']);
  });
});

describe('document-level + alignment mutations (tabs now depend on these)', () => {
  const metaProject = {
    id: 'proj-1',
    vocabs: [],
    config: { igt: { documentMetadata: [{ name: 'Date' }, { name: 'Speakers' }] } },
  };

  it('saveNameAndMetadata updates name + merges metadata over existing', async () => {
    const doc = makeDoc({
      raw: buildRawDoc({ metadata: { Date: 'x' } }),
      project: metaProject,
    });
    const ok = await doc.saveNameAndMetadata('New Name', { Date: 'y', Speakers: 'z' });
    expect(ok).toBe(true);
    const k = kinds(doc.client);
    expect(k).toContain('documents.update');
    expect(k).toContain('documents.setMetadata');
    expect(doc.document.name).toBe('New Name');
    expect(doc.document.metadata).toMatchObject({ Date: 'y', Speakers: 'z' });
  });

  it('saveNameAndMetadata skips documents.update when name is unchanged', async () => {
    const doc = makeDoc({ raw: buildRawDoc({ metadata: {} }), project: metaProject });
    const ok = await doc.saveNameAndMetadata('Test Doc', { Date: 'q' });
    expect(ok).toBe(true);
    const k = kinds(doc.client);
    expect(k).not.toContain('documents.update');
    expect(k).toContain('documents.setMetadata');
  });

  it('saveBaselineText with surviving sentences is a plain texts.update (no lock, no wipe)', async () => {
    const doc = makeDoc();
    const ok = await doc.saveBaselineText('a whole new body');
    expect(ok).toBe(true);
    const k = kinds(doc.client);
    // The server shifts/compensates tokens itself — nothing else goes over the wire.
    expect(k).toContain('texts.update');
    expect(k).not.toContain('documents.acquireLock');
    expect(k).not.toContain('tokens.bulkDelete');
    expect(k).not.toContain('tokens.bulkCreate');
    expect(k).not.toContain('submitBatch');
  });

  it('saveBaselineText re-seeds a full-span sentence when the save leaves no partition', async () => {
    const raw = buildRawDoc({ sentences: [], words: [], morphemes: [] });
    const client = makeFakeClient({ reloadDoc: raw }); // reload also shows an empty partition
    const doc = makeDoc({ raw, client });
    const ok = await doc.saveBaselineText('a whole new body');
    expect(ok).toBe(true);
    const k = kinds(doc.client);
    expect(k).toContain('texts.update');
    expect(k).toContain('tokens.bulkCreate');
    expect(k).not.toContain('tokens.bulkDelete');
    const seed = doc.client.calls.find((c) => c.kind === 'tokens.bulkCreate');
    expect(seed.args[0]).toEqual([
      { tokenLayerId: 'sentL', text: 'text-1', begin: 0, end: [...'a whole new body'].length },
    ]);
  });

  it('clearSentences merges sentences into the first and deletes sentence spans (never bulk-deletes)', async () => {
    // The word layer nests in the sentence layer (and morphemes in words), so a
    // bulkDelete of sentence tokens would cascade-delete every word/morpheme.
    const raw = buildRawDoc({
      body: 'the cat',
      sentences: [
        { id: 's-1', begin: 0, end: 4 },
        { id: 's-2', begin: 4, end: 7 },
      ],
    });
    raw.textLayers[0].tokenLayers[0].spanLayers[0].spans = [
      { id: 'tr-1', tokens: ['s-1'], value: 'le' },
      { id: 'tr-2', tokens: ['s-2'], value: 'chat' },
    ];
    const client = makeFakeClient({ reloadDoc: raw });
    const doc = makeDoc({ raw, client });
    const ok = await doc.clearSentences();
    expect(ok).toBe(true);
    const k = kinds(doc.client);
    expect(k).not.toContain('tokens.bulkDelete');
    expect(k).not.toContain('tokens.bulkCreate');
    const merges = doc.client.calls.filter((c) => c.kind === 'tokens.merge');
    expect(merges.map((c) => c.args)).toEqual([['s-1', 's-2']]);
    const dels = doc.client.calls.filter((c) => c.kind === 'spans.delete');
    expect(dels.map((c) => c.args[0]).sort()).toEqual(['tr-1', 'tr-2']);
  });

  it('createAlignment inserts text + creates the alignment token', async () => {
    const doc = makeDoc(); // body 'the cat', no existing alignments
    const ok = await doc.createAlignment({ text: 'hi', timeBegin: 0, timeEnd: 1 });
    expect(ok).toBe(true);
    const k = kinds(doc.client);
    expect(k).toContain('texts.update'); // insert the alignment text
    expect(k).toContain('tokens.create'); // the alignment token
  });

  it('createAlignment rejects empty text without calling the server', async () => {
    const doc = makeDoc();
    const ok = await doc.createAlignment({ text: '   ', timeBegin: 0, timeEnd: 1 });
    expect(ok).toBe(false);
    expect(doc.error).toBeTruthy();
    expect(kinds(doc.client)).not.toContain('texts.update');
  });

  it('updateAlignmentBounds patches metadata optimistically (no reload)', async () => {
    const raw = buildRawDoc({
      alignmentTokens: [
        { id: 'a-1', text: 'text-1', begin: 0, end: 3, metadata: { timeBegin: 0, timeEnd: 1 } },
      ],
    });
    const doc = makeDoc({ raw });
    expect(doc.alignmentTokens[0].metadata.timeBegin).toBe(0);
    const ok = await doc.updateAlignmentBounds('a-1', { timeBegin: 5, timeEnd: 6 });
    expect(ok).toBe(true);
    // PATCH (merge), not setMetadata (replace). A human-made segment stays
    // human: no prov keys appear (verifyOnEdit only stamps machine material).
    expect(kinds(doc.client)).toContain('tokens.patchMetadata');
    expect(doc.alignmentTokens[0].metadata).toEqual({ timeBegin: 5, timeEnd: 6 });
  });

  it('updateAlignmentBounds verifies a machine-made segment (write-contract rule 3)', async () => {
    const machine = { prov: 'inferred', provSource: 'service:asr', provDetail: { model: 'x' } };
    const raw = buildRawDoc({
      alignmentTokens: [
        {
          id: 'a-1',
          text: 'text-1',
          begin: 0,
          end: 3,
          metadata: { timeBegin: 0, timeEnd: 1, ...machine },
        },
      ],
    });
    const doc = makeDoc({ raw });
    const ok = await doc.updateAlignmentBounds('a-1', { timeBegin: 5, timeEnd: 6 });
    expect(ok).toBe(true);
    // prov/provSource/provDetail survive the merge and provConfirmed is stamped.
    expect(doc.alignmentTokens[0].metadata).toEqual({
      timeBegin: 5,
      timeEnd: 6,
      ...machine,
      provConfirmed: true,
    });
  });

  it('deleteAlignment removes the alignment text range', async () => {
    const raw = buildRawDoc({
      alignmentTokens: [
        { id: 'a-1', text: 'text-1', begin: 0, end: 3, metadata: { timeBegin: 0, timeEnd: 1 } },
      ],
    });
    const doc = makeDoc({ raw });
    const ok = await doc.deleteAlignment('a-1');
    expect(ok).toBe(true);
    expect(kinds(doc.client)).toContain('texts.update'); // delete op on the body
  });

  // The three text-editing alignment mutations patch the document in place from
  // the batch's ids instead of refetching it: a full document GET grows with
  // the document and was the lag between Enter and the row appearing.
  it('createAlignment patches in place: no refetch, real id, sentence stretched over the new text', async () => {
    const doc = makeDoc(); // body 'the cat', one sentence [0,7), words the/cat
    const ok = await doc.createAlignment({ text: 'hi', timeBegin: 0, timeEnd: 1, speaker: 'Ana' });
    expect(ok).toBe(true);
    expect(kinds(doc.client)).not.toContain('documents.get');
    expect(doc.body).toBe('the cat hi');
    expect(doc.alignmentTokens).toHaveLength(1);
    const [a] = doc.alignmentTokens;
    expect(a.id).toMatch(/^tok-/); // the id the batch answered with, not a placeholder
    expect(a).toMatchObject({
      begin: 8,
      end: 10,
      metadata: { timeBegin: 0, timeEnd: 1, speaker: 'Ana' },
    });
    expect(doc.layerInfo.sentenceTokenLayer.tokens).toEqual([
      { id: 's-1', text: 'text-1', begin: 0, end: 10 },
    ]);
    // Words before the insert are untouched.
    expect(doc.layerInfo.primaryTokenLayer.tokens.map((t) => [t.begin, t.end])).toEqual([
      [0, 3],
      [4, 7],
    ]);
  });

  it('createAlignment on an empty document seeds the sentence partition with the returned id', async () => {
    const raw = buildRawDoc({ body: '', sentences: [], words: [], morphemes: [] });
    const doc = makeDoc({ raw });
    const ok = await doc.createAlignment({ text: 'hello', timeBegin: 0, timeEnd: 2 });
    expect(ok).toBe(true);
    expect(kinds(doc.client)).not.toContain('documents.get');
    expect(doc.body).toBe('hello');
    expect(doc.alignmentTokens[0]).toMatchObject({ begin: 0, end: 5 });
    const [s] = doc.layerInfo.sentenceTokenLayer.tokens;
    expect(s.id).toMatch(/^tok-/);
    expect(s).toMatchObject({ begin: 0, end: 5 });
  });

  it('editAlignment replaces the text in place, dropping the words inside it and shifting the rest', async () => {
    const raw = buildRawDoc({
      body: 'the cat sat',
      words: [
        { id: 'w-1', begin: 0, end: 3 },
        { id: 'w-2', begin: 4, end: 7 },
        { id: 'w-3', begin: 8, end: 11 },
      ],
      alignmentTokens: [
        { id: 'a-1', text: 'text-1', begin: 4, end: 7, metadata: { timeBegin: 1, timeEnd: 2 } },
      ],
    });
    const doc = makeDoc({ raw });
    const ok = await doc.editAlignment('a-1', { text: 'dogs', timeBegin: 1, timeEnd: 2 });
    expect(ok).toBe(true);
    expect(kinds(doc.client)).not.toContain('documents.get');
    expect(doc.body).toBe('the dogs sat');
    expect(doc.alignmentTokens).toHaveLength(1);
    expect(doc.alignmentTokens[0].id).not.toBe('a-1'); // the token is recreated
    expect(doc.alignmentTokens[0]).toMatchObject({ begin: 4, end: 8 });
    expect(doc.layerInfo.primaryTokenLayer.tokens.map((t) => [t.id, t.begin, t.end])).toEqual([
      ['w-1', 0, 3],
      ['w-3', 9, 12],
    ]);
    expect(doc.layerInfo.sentenceTokenLayer.tokens[0]).toMatchObject({ begin: 0, end: 12 });
  });

  it('deleteAlignment in the middle keeps one separator and shifts what follows, in place', async () => {
    const raw = buildRawDoc({
      body: 'the cat sat',
      words: [
        { id: 'w-1', begin: 0, end: 3 },
        { id: 'w-2', begin: 4, end: 7 },
        { id: 'w-3', begin: 8, end: 11 },
      ],
      alignmentTokens: [
        { id: 'a-1', text: 'text-1', begin: 4, end: 7, metadata: { timeBegin: 1, timeEnd: 2 } },
      ],
    });
    const doc = makeDoc({ raw });
    const ok = await doc.deleteAlignment('a-1');
    expect(ok).toBe(true);
    expect(kinds(doc.client)).not.toContain('documents.get');
    expect(doc.body).toBe('the sat');
    expect(doc.alignmentTokens).toEqual([]);
    expect(doc.layerInfo.primaryTokenLayer.tokens.map((t) => [t.id, t.begin, t.end])).toEqual([
      ['w-1', 0, 3],
      ['w-3', 4, 7],
    ]);
    expect(doc.layerInfo.sentenceTokenLayer.tokens[0]).toMatchObject({ begin: 0, end: 7 });
  });
});

describe('clearing an annotation cell', () => {
  it('deletes the existing span instead of storing an empty value', async () => {
    const raw = buildRawDoc();
    raw.textLayers[0].tokenLayers[1].spanLayers[0].spans = [
      { id: 'sp-1', tokens: ['w-1'], value: 'DET' },
    ];
    const doc = makeDoc({ raw });
    const ok = await doc.updateTokenSpan('w-1', 'POS', '');
    expect(ok).toBe(true);
    expect(kinds(doc.client)).toContain('spans.delete');
    expect(kinds(doc.client)).not.toContain('spans.update');
    expect(doc.sentences[0].tokens[0].annotations.POS).toBeNull();
  });

  it('deletes a machine-made span too (no "verified empty" residue)', async () => {
    const raw = buildRawDoc();
    raw.textLayers[0].tokenLayers[1].spanLayers[0].spans = [
      {
        id: 'sp-1',
        tokens: ['w-1'],
        value: 'DET',
        metadata: { prov: 'inferred', provSource: 'service:x' },
      },
    ];
    const doc = makeDoc({ raw });
    const ok = await doc.updateTokenSpan('w-1', 'POS', '');
    expect(ok).toBe(true);
    expect(kinds(doc.client)).toEqual(expect.arrayContaining(['spans.delete']));
    expect(kinds(doc.client)).not.toContain('spans.setMetadata');
    expect(doc.sentences[0].tokens[0].annotations.POS).toBeNull();
  });

  it('is a no-op when there is nothing to clear', async () => {
    const doc = makeDoc();
    const ok = await doc.updateTokenSpan('w-1', 'POS', '');
    expect(ok).toBe(true);
    expect(kinds(doc.client)).not.toContain('spans.delete');
    expect(kinds(doc.client)).not.toContain('spans.create');
  });
});

describe('confirmWordAnalysis', () => {
  it('confirms the machine word token itself along with its morphemes, links and spans', async () => {
    const raw = buildRawDoc();
    const machine = { prov: 'inferred', provSource: 'service:punkt' };
    raw.textLayers[0].tokenLayers[1].tokens[0].metadata = { ...machine };
    raw.textLayers[0].tokenLayers[2].tokens[0].metadata = { form: 'ng', ...machine };
    raw.textLayers[0].tokenLayers[1].spanLayers[0].spans = [
      { id: 'sp-1', tokens: ['w-1'], value: 'DET', metadata: { ...machine } },
    ];
    const doc = makeDoc({ raw });
    const ok = await doc.confirmWordAnalysis('w-1');
    expect(ok).toBe(true);
    const tokenPatches = doc.client.calls.filter((c) => c.kind === 'tokens.patchMetadata');
    expect(tokenPatches).toHaveLength(2); // word + its morpheme
    expect(kinds(doc.client)).toContain('spans.patchMetadata');
    const w = doc.sentences[0].tokens[0];
    expect(w.metadata.provConfirmed).toBe(true);
    expect(w.morphemes[0].metadata.provConfirmed).toBe(true);
    expect(w.annotations.POS.metadata.provConfirmed).toBe(true);
  });

  it('is a no-op when nothing on the word is machine-unverified and nothing is adopted', async () => {
    const doc = makeDoc();
    const ok = await doc.confirmWordAnalysis('w-1');
    expect(ok).toBe(true);
    expect(kinds(doc.client)).not.toContain('tokens.patchMetadata');
  });

  it('writes adopted guesses as spans, on the layer each target scope owns', async () => {
    const doc = makeDoc();
    const guessed = (source, value) => ({
      prov: 'inferred',
      provSource: source,
      provConfirmed: true,
      provDetail: { value },
    });
    const ok = await doc.confirmWordAnalysis('w-1', [
      { targetId: 'w-1', field: 'POS', value: 'DET', metadata: guessed('gloss:precedent', 'DET') },
      { targetId: 'm-1', field: 'Gloss', value: 'the', metadata: guessed('vocab:entry', 'the') },
    ]);
    expect(ok).toBe(true);
    const creates = doc.client.calls.filter((c) => c.kind === 'spans.create');
    expect(creates.map((c) => c.args.slice(0, 3))).toEqual([
      ['wsl-0', ['w-1'], 'DET'],
      ['msl-0', ['m-1'], 'the'],
    ]);
    // Born verified: a person pressed the key, so the value needs no review.
    expect(creates[0].args[3].provConfirmed).toBe(true);
    expect(creates[0].args[3].provSource).toBe('gloss:precedent');
  });

  it('skips an adoption whose cell has gained a value since the render', async () => {
    const raw = buildRawDoc();
    raw.textLayers[0].tokenLayers[1].spanLayers[0].spans = [
      { id: 'sp-1', tokens: ['w-1'], value: 'N', metadata: {} },
    ];
    const doc = makeDoc({ raw });
    const ok = await doc.confirmWordAnalysis('w-1', [
      { targetId: 'w-1', field: 'POS', value: 'DET', metadata: {} },
    ]);
    expect(ok).toBe(true);
    expect(kinds(doc.client)).not.toContain('spans.create');
  });

  it('ignores an adoption aimed at a token outside this word', async () => {
    const doc = makeDoc();
    const ok = await doc.confirmWordAnalysis('w-1', [
      { targetId: 'w-2', field: 'POS', value: 'N', metadata: {} },
    ]);
    expect(ok).toBe(true);
    expect(kinds(doc.client)).not.toContain('spans.create');
  });
});

describe('discardSentenceSpan', () => {
  const machine = { prov: 'inferred', provSource: 'service:translate' };

  const withTranslation = (metadata) => {
    const raw = buildRawDoc();
    raw.textLayers[0].tokenLayers[0].spanLayers[0].spans = [
      { id: 'tr-1', tokens: ['s-1'], value: 'the cat', metadata },
    ];
    return makeDoc({ raw });
  };

  it('deletes a machine-made translation nobody has vouched for', async () => {
    const doc = withTranslation({ ...machine });
    const ok = await doc.discardSentenceSpan('s-1', 'Translation');
    expect(ok).toBe(true);
    expect(doc.client.calls.filter((c) => c.kind === 'spans.delete')).toHaveLength(1);
    expect(doc.sentences[0].annotations.Translation).toBe(null);
  });

  it('leaves a human translation alone', async () => {
    const doc = withTranslation({});
    const ok = await doc.discardSentenceSpan('s-1', 'Translation');
    expect(ok).toBe(true);
    expect(kinds(doc.client)).not.toContain('spans.delete');
    expect(doc.sentences[0].annotations.Translation.value).toBe('the cat');
  });

  it('leaves a confirmed machine translation alone', async () => {
    const doc = withTranslation({ ...machine, provConfirmed: true });
    const ok = await doc.discardSentenceSpan('s-1', 'Translation');
    expect(ok).toBe(true);
    expect(kinds(doc.client)).not.toContain('spans.delete');
  });

  it('is a no-op when the sentence has no value at all', async () => {
    const doc = makeDoc();
    const ok = await doc.discardSentenceSpan('s-1', 'Translation');
    expect(ok).toBe(true);
    expect(kinds(doc.client)).not.toContain('spans.delete');
  });
});

describe('discardWordAnalysis', () => {
  const machine = { prov: 'inferred', provSource: 'service:polygloss-analyzer' };

  it('deletes machine morphemes/spans/links and resets a machine first morpheme', async () => {
    const raw = buildRawDoc({
      words: [{ id: 'w-1', begin: 0, end: 3 }],
      morphemes: [
        { id: 'm-1', begin: 0, end: 3, precedence: 1, metadata: { form: 'ab', ...machine } },
        { id: 'm-2', begin: 0, end: 3, precedence: 2, metadata: { form: 'c', ...machine } },
      ],
      body: 'abc',
    });
    raw.textLayers[0].tokenLayers[2].spanLayers[0].spans = [
      { id: 'sp-1', tokens: ['m-1'], value: 'X', metadata: { ...machine } },
      { id: 'sp-2', tokens: ['m-2'], value: 'Y', metadata: { ...machine } },
    ];
    const doc = makeDoc({ raw });
    const ok = await doc.discardWordAnalysis('w-1');
    expect(ok).toBe(true);
    const calls = doc.client.calls;
    // m-2 is deleted as a token (its span cascades — NOT deleted separately)
    expect(calls.filter((c) => c.kind === 'tokens.delete').map((c) => c.args[0])).toEqual(['m-2']);
    expect(calls.filter((c) => c.kind === 'spans.delete').map((c) => c.args[0])).toEqual(['sp-1']);
    const reset = calls.find((c) => c.kind === 'tokens.patchMetadata');
    expect(reset.args[0]).toBe('m-1');
    expect(reset.args[1]).toMatchObject({
      form: null,
      morphType: null,
      prov: null,
      provSource: null,
    });
    expect(kinds(doc.client)).not.toContain('tokens.update');
  });

  it('keeps human pieces and renumbers survivors', async () => {
    const raw = buildRawDoc({
      words: [{ id: 'w-1', begin: 0, end: 3 }],
      morphemes: [
        { id: 'm-1', begin: 0, end: 3, precedence: 1, metadata: { form: 'a' } },
        { id: 'm-2', begin: 0, end: 3, precedence: 2, metadata: { form: 'b', ...machine } },
        { id: 'm-3', begin: 0, end: 3, precedence: 3, metadata: { form: 'c' } },
      ],
      body: 'abc',
    });
    const doc = makeDoc({ raw });
    expect(await doc.discardWordAnalysis('w-1')).toBe(true);
    const calls = doc.client.calls;
    expect(calls.filter((c) => c.kind === 'tokens.delete').map((c) => c.args[0])).toEqual(['m-2']);
    const upd = calls.filter((c) => c.kind === 'tokens.update');
    expect(upd.map((c) => [c.args[0], c.args[3]])).toEqual([['m-3', 2]]);
    expect(kinds(doc.client)).not.toContain('tokens.patchMetadata');
  });

  it('is a no-op when nothing on the word is machine-unverified', async () => {
    const doc = makeDoc();
    expect(await doc.discardWordAnalysis('w-1')).toBe(true);
    expect(doc.client.calls.filter((c) => c.kind.endsWith('.delete'))).toHaveLength(0);
  });
});

describe('an entry may be linked from words and morphemes alike', () => {
  it('links a word to an item already linked from a morpheme', async () => {
    const doc = makeDoc({
      vocabularies: {
        v1: {
          id: 'v1',
          items: [{ id: 'i-1', form: 'foo' }],
          vocabLinks: [{ id: 'l1', tokens: ['m-1'], vocabItem: { id: 'i-1', form: 'foo' } }],
        },
      },
    });
    expect(await doc.linkVocab('w-1', 'i-1')).toBe(true);
    expect(kinds(doc.client)).toContain('vocabLinks.create');
  });

  it('bulkLinkVocab writes both kinds of proposal for one item', async () => {
    const doc = makeDoc({
      vocabularies: { v1: { id: 'v1', items: [{ id: 'i-1', form: 'foo' }], vocabLinks: [] } },
    });
    const n = await doc.bulkLinkVocab(
      [
        { tokenId: 'm-1', vocabItemId: 'i-1' },
        { tokenId: 'w-1', vocabItemId: 'i-1' },
      ],
      'rule:test',
    );
    expect(n).toBe(2);
    const bulk = doc.client.calls.find((c) => c.kind === 'vocabLinks.bulkCreate');
    expect(bulk.args[0].map((l) => l.tokens[0])).toEqual(['m-1', 'w-1']);
  });
});

describe('confirmSentenceSpan', () => {
  const machine = { prov: 'inferred', provSource: 'service:llm-translator' };
  const withTranslation = (metadata) => {
    const raw = buildRawDoc();
    const sid = raw.textLayers[0].tokenLayers[0].tokens[0].id;
    raw.textLayers[0].tokenLayers[0].spanLayers[0].spans = [
      { id: 'tr-1', tokens: [sid], value: 'the cat', ...(metadata ? { metadata } : {}) },
    ];
    return { raw, sid };
  };

  it('patches provConfirmed onto a machine-made translation and keeps its value', async () => {
    const { raw, sid } = withTranslation({ ...machine });
    const doc = makeDoc({ raw });
    expect(await doc.confirmSentenceSpan(sid, 'Translation')).toBe(true);
    const patch = doc.client.calls.find((c) => c.kind === 'spans.patchMetadata');
    expect(patch.args).toEqual(['tr-1', { provConfirmed: true }]);
    const span = doc.sentences[0].annotations.Translation;
    expect(span.value).toBe('the cat');
    expect(span.metadata).toMatchObject({ ...machine, provConfirmed: true });
  });

  it('is a no-op for human, verified, or absent translations', async () => {
    for (const meta of [null, { ...machine, provConfirmed: true }]) {
      const { raw, sid } = withTranslation(meta);
      const doc = makeDoc({ raw });
      expect(await doc.confirmSentenceSpan(sid, 'Translation')).toBe(true);
      expect(kinds(doc.client)).not.toContain('spans.patchMetadata');
    }
    const doc = makeDoc();
    expect(await doc.confirmSentenceSpan(doc.sentences[0].id, 'Translation')).toBe(true);
    expect(await doc.confirmSentenceSpan(doc.sentences[0].id, 'Nope')).toBe(false);
  });
});

describe('multi-word expressions', () => {
  // Four words: "the cat sat down".
  const raw = () =>
    buildRawDoc({
      body: 'the cat sat down',
      words: [
        { id: 'w-1', begin: 0, end: 3 },
        { id: 'w-2', begin: 4, end: 7 },
        { id: 'w-3', begin: 8, end: 11 },
        { id: 'w-4', begin: 12, end: 16 },
      ],
    });
  const vocabs = (links = []) => ({
    v1: {
      id: 'v1',
      name: 'Lexicon',
      items: [
        { id: 'i-cat', form: 'cat', metadata: { morphType: 'stem' } },
        { id: 'i-sit', form: 'sit down', metadata: { morphType: 'phrase' } },
        { id: 'i-alt', form: 'sit down', metadata: { morphType: 'phrase' } },
      ],
      vocabLinks: links,
    },
  });
  const project = { id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {} } };

  it('derives an MWE with lanes and a bracket piece per column', () => {
    const doc = makeDoc({
      raw: raw(),
      project,
      vocabularies: vocabs([
        { id: 'lk-1', tokens: ['w-3', 'w-4'], vocabItem: { id: 'i-sit', form: 'sit down' } },
        { id: 'lk-w', tokens: ['w-2'], vocabItem: { id: 'i-cat', form: 'cat' } },
      ]),
    });
    const s = doc.sentences[0];
    expect(s.mweLanes).toBe(1);
    expect(s.mwes).toHaveLength(1);
    expect(s.mwes[0]).toMatchObject({
      linkId: 'lk-1',
      lane: 0,
      first: 2,
      last: 3,
      memberTokenIds: ['w-3', 'w-4'],
      partial: false,
      prov: 'human',
    });
    expect(s.tokens.map((t) => t.mwePieces[0]?.piece ?? null)).toEqual([
      null,
      null,
      'start',
      'end',
    ]);
    // A word's own link is untouched by MWEs.
    expect(s.tokens[1].vocabItem?.form).toBe('cat');
    expect(s.tokens[1].mwePieces).toEqual([null]);
  });

  it('stacks overlapping MWEs on separate lanes and dots a skipped word', () => {
    const doc = makeDoc({
      raw: raw(),
      project,
      vocabularies: vocabs([
        { id: 'lk-1', tokens: ['w-1', 'w-2', 'w-3'], vocabItem: { id: 'i-sit', form: 'a' } },
        { id: 'lk-2', tokens: ['w-2', 'w-4'], vocabItem: { id: 'i-alt', form: 'b' } },
      ]),
    });
    const s = doc.sentences[0];
    expect(s.mweLanes).toBe(2);
    expect(s.mwes.map((e) => [e.linkId, e.lane])).toEqual([
      ['lk-1', 0],
      ['lk-2', 1],
    ]);
    expect(s.tokens.map((t) => t.mwePieces.map((p) => p?.piece ?? null))).toEqual([
      ['start', null],
      ['mid', 'start'],
      ['end', 'pass'],
      [null, 'end'],
    ]);
  });

  it('draws only the members that exist, and marks the MWE partial', () => {
    const doc = makeDoc({
      raw: raw(),
      project,
      vocabularies: vocabs([
        { id: 'lk-1', tokens: ['w-1', 'w-gone', 'w-3'], vocabItem: { id: 'i-sit', form: 'x' } },
        { id: 'lk-2', tokens: ['w-4', 'w-gone'], vocabItem: { id: 'i-alt', form: 'y' } },
      ]),
    });
    const s = doc.sentences[0];
    expect(s.mwes.map((e) => e.linkId)).toEqual(['lk-1']);
    expect(s.mwes[0].partial).toBe(true);
    expect(s.tokens.map((t) => t.mwePieces[0]?.piece ?? null)).toEqual([
      'start',
      'pass',
      'end',
      null,
    ]);
  });

  it('linkMwe links the words in text order and leaves their own links alone', async () => {
    const client = makeFakeClient();
    const doc = makeDoc({
      raw: raw(),
      project,
      client,
      vocabularies: vocabs([
        { id: 'lk-w', tokens: ['w-3'], vocabItem: { id: 'i-cat', form: 'cat' } },
      ]),
    });
    expect(await doc.linkMwe(['w-4', 'w-3'], 'i-sit')).toBe(true);
    const create = client.calls.find((c) => c.kind === 'vocabLinks.create');
    expect(create.args[0]).toBe('i-sit');
    expect(create.args[1]).toEqual(['w-3', 'w-4']);
    const s = doc.sentences[0];
    expect(s.mwes[0].item.form).toBe('sit down');
    expect(s.tokens[2].vocabItem?.form).toBe('cat');
  });

  it('refuses fewer than two distinct words', async () => {
    const doc = makeDoc({ raw: raw(), project, vocabularies: vocabs() });
    expect(await doc.linkMwe(['w-1', 'w-1'], 'i-sit')).toBe(false);
    expect(doc.error).toMatch(/two or more words/);
    expect(await doc.linkMwe(['w-1', 'm-1'], 'i-sit')).toBe(false);
  });

  it('createAndLinkMwe makes the entry with its type, then links it', async () => {
    const client = makeFakeClient();
    const doc = makeDoc({ raw: raw(), project, client, vocabularies: vocabs() });
    const ok = await doc.createAndLinkMwe(['w-2', 'w-4'], 'v1', 'cat down', {
      morphType: 'phrase',
    });
    expect(ok).toBe(true);
    expect(kinds(client)).toEqual(
      expect.arrayContaining(['vocabItems.create', 'vocabLinks.create']),
    );
    const itemCall = client.calls.find((c) => c.kind === 'vocabItems.create');
    expect(itemCall.args).toEqual(['v1', 'cat down', { morphType: 'phrase' }]);
    const s = doc.sentences[0];
    expect(s.mwes[0].item.form).toBe('cat down');
    expect(s.mwes[0].item.metadata.morphType).toBe('phrase');
    expect(s.tokens.map((t) => t.mwePieces[0]?.piece ?? null)).toEqual([
      null,
      'start',
      'pass',
      'end',
    ]);
    expect(doc.vocabularies.v1.items.map((i) => i.form)).toContain('cat down');
  });

  it('relinkMwe swaps the entry in one batch and keeps the words', async () => {
    const client = makeFakeClient();
    const doc = makeDoc({
      raw: raw(),
      project,
      client,
      vocabularies: vocabs([
        { id: 'lk-1', tokens: ['w-3', 'w-4'], vocabItem: { id: 'i-sit', form: 'sit down' } },
      ]),
    });
    expect(await doc.relinkMwe('lk-1', 'i-alt')).toBe(true);
    const k = kinds(client);
    expect(k.indexOf('vocabLinks.delete')).toBeLessThan(k.indexOf('vocabLinks.create'));
    expect(k.indexOf('vocabLinks.create')).toBeLessThan(k.indexOf('submitBatch'));
    const e = doc.sentences[0].mwes[0];
    expect(e.item.id).toBe('i-alt');
    expect(e.memberTokenIds).toEqual(['w-3', 'w-4']);
    expect(doc.vocabularies.v1.vocabLinks).toHaveLength(1);
  });

  it('setMweMembers re-covers the words, keeping entry and provenance', async () => {
    const client = makeFakeClient();
    const doc = makeDoc({
      raw: raw(),
      project,
      client,
      vocabularies: vocabs([
        {
          id: 'lk-1',
          tokens: ['w-3', 'w-4'],
          vocabItem: { id: 'i-sit', form: 'sit down' },
          metadata: { prov: 'inferred', provSource: 'rule' },
        },
      ]),
    });
    expect(await doc.setMweMembers('lk-1', ['w-4', 'w-2', 'w-3'])).toBe(true);
    const create = client.calls.find((c) => c.kind === 'vocabLinks.create');
    expect(create.args[1]).toEqual(['w-2', 'w-3', 'w-4']);
    expect(create.args[2]).toEqual({ prov: 'inferred', provSource: 'rule' });
    const e = doc.sentences[0].mwes[0];
    expect(e.memberTokenIds).toEqual(['w-2', 'w-3', 'w-4']);
    expect(e.prov).toBe('machine');
    // Down to one word: the MWE is simply removed.
    expect(await doc.setMweMembers(e.linkId, ['w-2'])).toBe(true);
    expect(doc.sentences[0].mwes).toEqual([]);
  });

  it('unlinkMwe removes the link and the bracket', async () => {
    const doc = makeDoc({
      raw: raw(),
      project,
      vocabularies: vocabs([
        { id: 'lk-1', tokens: ['w-3', 'w-4'], vocabItem: { id: 'i-sit', form: 'sit down' } },
      ]),
    });
    expect(await doc.unlinkMwe('lk-1')).toBe(true);
    expect(doc.sentences[0].mwes).toEqual([]);
    expect(doc.sentences[0].mweLanes).toBe(0);
    expect(doc.sentences[0].tokens[2].mwePieces).toEqual([]);
  });

  it('bulkLinkMwes writes only new, well-formed proposals in one bulk create, stamped inferred', async () => {
    const client = makeFakeClient();
    client.documents.get = async () => raw();
    const doc = makeDoc({
      raw: raw(),
      project,
      client,
      vocabularies: vocabs([
        { id: 'lk-1', tokens: ['w-3', 'w-4'], vocabItem: { id: 'i-sit', form: 'sit down' } },
      ]),
    });
    const n = await doc.bulkLinkMwes(
      [
        { tokenIds: ['w-3', 'w-4'], vocabItemId: 'i-alt' }, // already covered
        { tokenIds: ['w-1', 'w-2'], vocabItemId: 'i-sit' },
        { tokenIds: ['w-1'], vocabItemId: 'i-sit' }, // one word
        { tokenIds: ['w-1', 'm-1'], vocabItemId: 'i-sit' }, // not a word
        { tokenIds: ['w-2', 'w-4'], vocabItemId: 'i-nope' }, // no such entry
      ],
      'rule:test',
    );
    expect(n).toBe(1);
    const bulk = client.calls.find((c) => c.kind === 'vocabLinks.bulkCreate');
    expect(bulk.args[0]).toEqual([
      {
        vocabItem: 'i-sit',
        tokens: ['w-1', 'w-2'],
        metadata: { prov: 'inferred', provSource: 'rule:test' },
      },
    ]);
  });

  it('confirmMweLink flips a machine link to verified and ignores a human one', async () => {
    const client = makeFakeClient();
    const doc = makeDoc({
      raw: raw(),
      project,
      client,
      vocabularies: vocabs([
        {
          id: 'lk-1',
          tokens: ['w-3', 'w-4'],
          vocabItem: { id: 'i-sit', form: 'sit down' },
          metadata: { prov: 'inferred', provSource: 'rule' },
        },
        { id: 'lk-2', tokens: ['w-1', 'w-2'], vocabItem: { id: 'i-alt', form: 'the cat' } },
      ]),
    });
    expect(await doc.confirmMweLink('lk-1')).toBe(true);
    expect(doc.sentences[0].mwes.find((e) => e.linkId === 'lk-1').prov).toBe('verified');
    expect(await doc.confirmMweLink('lk-2')).toBe(false);
  });
});
