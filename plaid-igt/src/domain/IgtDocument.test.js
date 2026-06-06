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
    // ordering: setMetadata (m-1), update (shift m-2), create (new), submitBatch
    const k = kinds(doc.client);
    const iMeta = k.indexOf('tokens.setMetadata');
    const iShift = k.indexOf('tokens.update');
    const iCreate = k.indexOf('tokens.create');
    expect(iMeta).toBeGreaterThanOrEqual(0);
    expect(iShift).toBeGreaterThan(iMeta);
    expect(iCreate).toBeGreaterThan(iShift);
    const ms = doc.sentences[0].tokens[0].morphemes;
    expect(ms.map((m) => m.metadata.form)).toEqual(['a', 'b', 'c']);
    expect(ms.map((m) => m.precedence)).toEqual([1, 2, 3]);
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

  it('saveBaselineText locks, wipes the partition, updates text, re-partitions in one batch', async () => {
    const doc = makeDoc();
    const ok = await doc.saveBaselineText('a whole new body');
    expect(ok).toBe(true);
    const k = kinds(doc.client);
    expect(k).toContain('documents.acquireLock');
    expect(k).toContain('tokens.bulkDelete');   // wipe sentences (+ alignments)
    expect(k).toContain('texts.update');
    expect(k).toContain('tokens.bulkCreate');    // new single-sentence partition
    expect(k).toContain('submitBatch');
    expect(k).toContain('documents.releaseLock');
    // releaseLock runs after the batch submits.
    expect(k.indexOf('documents.releaseLock')).toBeGreaterThan(k.indexOf('submitBatch'));
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
