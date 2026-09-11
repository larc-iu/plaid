import { describe, it, expect, beforeEach } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from './test-helpers.js';
import {
  isVirtualMorphemeId,
  virtualMorphemeId,
  virtualMorphemeWordId,
} from './virtualMorpheme.js';

// A word nobody has analyzed shows a morpheme that is not stored anywhere, and
// the first write to it makes it real. These cover both halves: what derive
// hands the editor, and what each mutation does when handed a virtual id.

const makeDoc = (raw, client) =>
  new IgtDocument({
    raw,
    project: { id: 'proj-1', vocabs: [], config: {} },
    vocabularies: {},
    client,
    projectId: 'proj-1',
  });

const morphOf = (doc, wordIdx = 0) => doc.sentences[0].tokens[wordIdx].morphemes[0];
const callsOf = (client, kind) => client.calls.filter((c) => c.kind === kind);

beforeEach(() => resetIds());

describe('virtual morpheme ids', () => {
  it('name the word they belong to and are not mistaken for a token id', () => {
    expect(virtualMorphemeId('w-1')).toBe('virtual:w-1');
    expect(virtualMorphemeWordId('virtual:w-1')).toBe('w-1');
    expect(isVirtualMorphemeId('virtual:w-1')).toBe(true);
    expect(isVirtualMorphemeId('01a04e40-3618-78b8-8000-034ad9c26894')).toBe(false);
    expect(virtualMorphemeWordId('m-1')).toBeNull();
  });
});

describe('derive', () => {
  it('gives an unanalyzed word a morpheme that reads as the word', () => {
    const doc = makeDoc(buildRawDoc({ morphemes: [] }), makeFakeClient());
    const m = morphOf(doc);
    expect(m).toMatchObject({ id: 'virtual:w-1', virtual: true, content: 'the', precedence: 1 });
    expect(m.begin).toBe(0);
    expect(m.end).toBe(3);
    expect(m.metadata).toEqual({});
    expect(m.vocabItem).toBeNull();
  });

  it('leaves a word that has a stored morpheme alone', () => {
    const doc = makeDoc(buildRawDoc(), makeFakeClient());
    expect(morphOf(doc).virtual).toBeUndefined();
    expect(morphOf(doc).id).toBe('m-1');
  });

  it('gives an ignored token none, the way reconcile never healed one onto it', () => {
    // A punctuation token carries no annotation and renders as a gap, so a
    // morpheme there would be invisible.
    const raw = buildRawDoc({
      body: 'the , cat',
      words: [
        { id: 'w-1', begin: 0, end: 3 },
        { id: 'w-2', begin: 4, end: 5 },
        { id: 'w-3', begin: 6, end: 9 },
      ],
      morphemes: [],
    });
    const wordLayer = raw.textLayers[0].tokenLayers.find((l) => l.id === 'wordL');
    wordLayer.config.igt.ignoredTokens = { type: 'unicodePunctuation', whitelist: [] };
    const doc = makeDoc(raw, makeFakeClient());
    const [a, comma, b] = doc.sentences[0].tokens;
    expect(a.morphemes).toHaveLength(1);
    expect(comma.morphemes).toHaveLength(0);
    expect(b.morphemes).toHaveLength(1);
  });

  it('gives none at all when the project has no morpheme layer', () => {
    const raw = buildRawDoc({ morphemes: [] });
    raw.textLayers[0].tokenLayers = raw.textLayers[0].tokenLayers.filter((l) => l.id !== 'morphL');
    const doc = makeDoc(raw, makeFakeClient());
    expect(doc.sentences[0].tokens[0].morphemes).toEqual([]);
  });
});

describe('writing to a virtual morpheme', () => {
  it('updateMorphemeForm creates the token carrying the form, in one write', async () => {
    const client = makeFakeClient();
    const doc = makeDoc(buildRawDoc({ morphemes: [] }), client);

    expect(await doc.updateMorphemeForm(morphOf(doc).id, 'ngo')).toBe(true);

    const creates = callsOf(client, 'tokens.create');
    expect(creates).toHaveLength(1);
    // layerId, textId, begin, end, precedence, metadata
    expect(creates[0].args.slice(2, 5)).toEqual([0, 3, 1]);
    expect(creates[0].args[5]).toMatchObject({ form: 'ngo' });
    expect(callsOf(client, 'tokens.patchMetadata')).toHaveLength(0);
    // And it is a real morpheme now.
    const m = morphOf(doc);
    expect(m.virtual).toBeUndefined();
    expect(m.metadata.form).toBe('ngo');
  });

  it('updateMorphemeSpan writes the morpheme before the gloss that hangs off it', async () => {
    const client = makeFakeClient();
    const doc = makeDoc(buildRawDoc({ morphemes: [] }), client);

    expect(await doc.updateMorphemeSpan(morphOf(doc).id, 'Gloss', 'DOG')).toBe(true);

    const created = callsOf(client, 'tokens.create');
    expect(created).toHaveLength(1);
    const spans = callsOf(client, 'spans.create');
    expect(spans).toHaveLength(1);
    // The span points at the token that was just written, never at the virtual id.
    expect(spans[0].args[1]).toEqual([created[0].result?.id ?? 'tok-1']);
    expect(morphOf(doc).annotations.Gloss?.value).toBe('DOG');
  });

  it('setMorphemeType creates it carrying the type', async () => {
    const client = makeFakeClient();
    const doc = makeDoc(buildRawDoc({ morphemes: [] }), client);

    expect(await doc.setMorphemeType(morphOf(doc).id, 'suffix')).toBe(true);
    expect(callsOf(client, 'tokens.create')[0].args[5]).toMatchObject({ morphType: 'suffix' });
  });

  it('setMorphemeType writes nothing when it is only clearing a type there is none of', async () => {
    const client = makeFakeClient();
    const doc = makeDoc(buildRawDoc({ morphemes: [] }), client);

    expect(await doc.setMorphemeType(morphOf(doc).id, null)).toBe(true);
    expect(callsOf(client, 'tokens.create')).toHaveLength(0);
    expect(morphOf(doc).virtual).toBe(true);
  });

  it('splitMorpheme writes it, then splits it', async () => {
    const client = makeFakeClient();
    const doc = makeDoc(buildRawDoc({ morphemes: [] }), client);

    expect(await doc.splitMorpheme(morphOf(doc).id, 'th', 'e')).toBe(true);

    const forms = doc.sentences[0].tokens[0].morphemes.map((m) => m.metadata.form);
    expect(forms).toEqual(['th', 'e']);
    expect(doc.sentences[0].tokens[0].morphemes.every((m) => !m.virtual)).toBe(true);
  });
});

describe('a gesture with nothing to act on', () => {
  it('deleteMorpheme refuses, the way it refuses a word’s last morpheme', async () => {
    const client = makeFakeClient();
    const doc = makeDoc(buildRawDoc({ morphemes: [] }), client);

    expect(await doc.deleteMorpheme(morphOf(doc).id)).toBe(false);
    expect(doc.error).toMatch(/last morpheme/);
    expect(callsOf(client, 'tokens.delete')).toHaveLength(0);
  });

  it('mergeMorphemes does nothing, since there is nothing before it', async () => {
    const client = makeFakeClient();
    const doc = makeDoc(buildRawDoc({ morphemes: [] }), client);

    expect(await doc.mergeMorphemes(morphOf(doc).id)).toBe(false);
    expect(callsOf(client, 'tokens.delete')).toHaveLength(0);
  });
});

describe('materializeMorphemeIds', () => {
  it('writes every virtual id in one bulk create and answers positionally', async () => {
    const client = makeFakeClient();
    const doc = makeDoc(buildRawDoc({ morphemes: [] }), client);

    const out = await doc.materializeMorphemeIds(['virtual:w-1', 'w-real', 'virtual:w-2']);

    const bulk = callsOf(client, 'tokens.bulkCreate');
    expect(bulk).toHaveLength(1);
    expect(bulk[0].args[0]).toMatchObject([
      { begin: 0, end: 3, precedence: 1 },
      { begin: 4, end: 7, precedence: 1 },
    ]);
    expect(out[1]).toBe('w-real');
    expect(out[0]).not.toBe('virtual:w-1');
    expect(out[2]).not.toBe('virtual:w-2');
    expect(doc.sentences[0].tokens[0].morphemes[0].virtual).toBeUndefined();
  });

  it('writes one morpheme for a word named twice, not two', async () => {
    const client = makeFakeClient();
    const doc = makeDoc(buildRawDoc({ morphemes: [] }), client);

    const out = await doc.materializeMorphemeIds(['virtual:w-1', 'virtual:w-1']);

    const bulk = callsOf(client, 'tokens.bulkCreate');
    expect(bulk).toHaveLength(1);
    expect(bulk[0].args[0]).toHaveLength(1);
    expect(out[0]).toBe(out[1]);
    expect(doc.layerInfo.morphemeTokenLayer.tokens).toHaveLength(1);
  });

  it('writes nothing when no id is virtual', async () => {
    const client = makeFakeClient();
    const doc = makeDoc(buildRawDoc(), client);

    expect(await doc.materializeMorphemeIds(['m-1', 'm-2'])).toEqual(['m-1', 'm-2']);
    expect(callsOf(client, 'tokens.bulkCreate')).toHaveLength(0);
  });

  it('drops an id whose word is gone rather than writing against it', async () => {
    const client = makeFakeClient();
    const doc = makeDoc(buildRawDoc({ morphemes: [] }), client);

    const out = await doc.materializeMorphemeIds(['virtual:w-gone']);
    expect(out).toEqual([null]);
    expect(callsOf(client, 'tokens.bulkCreate')).toHaveLength(0);
  });
});
