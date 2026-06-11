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
      morphemes: [{ id: 'm-1', begin: 0, end: 3, precedence: 1, metadata: { form: 'ab', morphType: 'stem' } }],
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
  const typedDoc = () => makeDoc({
    raw: buildRawDoc({
      words: [{ id: 'w-1', begin: 0, end: 3 }],
      morphemes: [{ id: 'm-1', begin: 0, end: 3, precedence: 1, metadata: { form: 'ab', morphType: 'stem' } }],
      body: 'abc',
    }),
  });

  it('setMorphemeType patches metadata.morphType from the FLEx inventory', async () => {
    const doc = typedDoc();
    const ok = await doc.setMorphemeType('m-1', 'enclitic');
    expect(ok).toBe(true);
    const call = doc.client.calls.find((c) => c.kind === 'tokens.patchMetadata');
    expect(call.args[1]).toEqual({ morphType: 'enclitic' });
    expect(doc.sentences[0].tokens[0].morphemes[0].metadata).toEqual({ form: 'ab', morphType: 'enclitic' });
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
    expect(k.filter(x => x === 'tokens.create')).toHaveLength(2);
    expect(k.indexOf('tokens.update')).toBeGreaterThan(k.indexOf('tokens.patchMetadata'));
    expect(k.indexOf('tokens.create')).toBeGreaterThan(k.indexOf('tokens.update'));
    const ms = doc.sentences[0].tokens[0].morphemes;
    expect(ms.map((m) => m.metadata.form)).toEqual(['a', 'bc', 'd', 'ef']);
    expect(ms.map((m) => m.precedence)).toEqual([1, 2, 3, 4]);
    // m-1 survives as the first segment (annotations/links stay attached to it).
    expect(ms[0].id).toBe('m-1');
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
    const raw = buildRawDoc({ words: [{ id: 'w-1', begin: 0, end: 7 }], morphemes: [], body: 'the cat' });
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
      words: [{ id: 'w-1', begin: 0, end: 3 }, { id: 'w-2', begin: 4, end: 7 }],
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
      words: [{ id: 'w-1', begin: 0, end: 3 }, { id: 'w-2', begin: 4, end: 7 }],
      morphemes: [],
      body: 'the cat',
      // Annotation + vocab link live on the SECOND (merged-away) word.
      wordVocabs: [{
        id: 'v1', name: 'Lexicon',
        vocabLinks: [{ id: 'lk-1', tokens: ['w-2'], vocabItem: { id: 'vi-1', form: 'CAT', metadata: {} } }],
      }],
    });
    raw.textLayers[0].tokenLayers[1].spanLayers[0].spans = [{ id: 'sp-1', tokens: ['w-2'], value: 'N' }];
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

  it('deleteToken cascades to coincident morphemes and their spans', async () => {
    const raw = buildRawDoc({
      words: [{ id: 'w-1', begin: 0, end: 3 }, { id: 'w-2', begin: 4, end: 7 }],
      morphemes: [{ id: 'm-1', begin: 0, end: 3, precedence: 1, metadata: {} }],
      body: 'the cat',
    });
    raw.textLayers[0].tokenLayers[1].spanLayers[0].spans = [{ id: 'sp-1', tokens: ['w-1'], value: 'DET' }];
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
      sentences: [{ id: 's-1', begin: 0, end: 4 }, { id: 's-2', begin: 4, end: 7 }],
    });
    raw.textLayers[0].tokenLayers[0].spanLayers[0].spans = [{ id: 'tr-2', tokens: ['s-2'], value: 'the cat (gloss)' }];
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
    vocabs.v1.vocabLinks = [{ id: 'lk-1', tokens: ['w-2'], vocabItem: { id: 'vi-1', form: 'CAT', metadata: {} } }];
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
      morphVocabs: [{
        id: 'v1', name: 'Lexicon',
        vocabLinks: [{ id: 'lk-1', tokens: ['m-2'], vocabItem: { id: 'vi-1', form: 'DOG', metadata: {} } }],
      }],
      wordVocabs: [{
        id: 'v1', name: 'Lexicon',
        vocabLinks: [{ id: 'lk-2', tokens: ['w-1'], vocabItem: { id: 'vi-2', form: 'THE', metadata: {} } }],
      }],
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

describe('document-level + alignment mutations (tabs now depend on these)', () => {
  const metaProject = {
    id: 'proj-1', vocabs: [],
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

  it('snapshotWordToken + restoreWordToken round-trip the word, morphemes, spans, and links', async () => {
    const raw = buildRawDoc({
      body: 'cat',
      words: [{ id: 'w-1', begin: 0, end: 3 }],
      morphemes: [{ id: 'm-1', text: 'text-1', begin: 0, end: 3, precedence: 1, metadata: { form: 'cat' } }],
      wordVocabs: [{
        id: 'v1', name: 'Lexicon',
        vocabLinks: [{ id: 'lk-1', tokens: ['w-1'], vocabItem: { id: 'vi-1', form: 'CAT', metadata: {} } }],
      }],
    });
    raw.textLayers[0].tokenLayers[1].spanLayers[0].spans = [{ id: 'sp-1', tokens: ['w-1'], value: 'N' }];
    raw.textLayers[0].tokenLayers[2].spanLayers[0].spans = [{ id: 'sp-2', tokens: ['m-1'], value: 'cat.G' }];
    const doc = makeDoc({
      raw,
      project: { id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {} } },
      vocabularies: { v1: { id: 'v1', name: 'Lexicon', items: [], vocabLinks: [] } },
    });

    const snap = doc.snapshotWordToken('w-1');
    expect(snap.word).toMatchObject({ id: 'w-1', begin: 0, end: 3 });
    expect(snap.morphemes).toHaveLength(1);
    expect(snap.spans).toHaveLength(2); // POS on the word + Gloss on the morpheme
    expect(snap.vocabLinks).toEqual([{ vocabItemId: 'vi-1', tokens: ['w-1'] }]);

    expect(await doc.deleteToken('w-1')).toBe(true);
    expect(await doc.restoreWordToken(snap)).toBe(true);

    const calls = doc.client.calls;
    const tokenCreates = calls.filter(c => c.kind === 'tokens.create');
    expect(tokenCreates).toHaveLength(2); // word + morpheme
    const spanCreates = calls.filter(c => c.kind === 'spans.create');
    expect(spanCreates).toHaveLength(2);
    expect(calls.filter(c => c.kind === 'vocabLinks.create')).toHaveLength(1);
    // Every recreated span/link must reference the NEW ids, never the dead ones.
    const deadIds = new Set(['w-1', 'm-1']);
    for (const c of [...spanCreates, ...calls.filter(x => x.kind === 'vocabLinks.create')]) {
      expect(c.args[1].some(t => deadIds.has(t))).toBe(false);
    }
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
    expect(kinds(doc.client)).toContain('tokens.setMetadata');
    expect(doc.alignmentTokens[0].metadata.timeBegin).toBe(5);
    expect(doc.alignmentTokens[0].metadata.timeEnd).toBe(6);
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
});
