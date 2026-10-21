import { describe, it, expect, beforeEach } from 'vitest';
import { buildRawDoc, makeFakeClient, resetIds, makeIgtDoc } from './test-helpers.js';
import {
  isVirtualMorphemeId,
  virtualMorphemeId,
  virtualMorphemeWordId,
} from './virtualMorpheme.js';

// A word nobody has analyzed shows a morpheme that is not stored anywhere, and
// the first write to it makes it real. These cover both halves: what derive
// hands the editor, and what each mutation does when handed a virtual id.

const makeDoc = (raw, client) =>
  makeIgtDoc({
    raw,
    project: { id: 'proj-1', vocabs: [], config: {} },
    client,
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

  it('gives an ignored token none: it is no word, its text lies between words', () => {
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
    const [a, b] = doc.sentences[0].tokens;
    expect(doc.sentences[0].tokens).toHaveLength(2);
    expect(a.morphemes).toHaveLength(1);
    expect(b.morphemes).toHaveLength(1);
    expect(doc.sentences[0].pieces.map((p) => p.content)).toEqual(['the', ' , ', 'cat']);
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

  it('updateMorphemeSpan writes the morpheme and the gloss that hangs off it in one batch', async () => {
    const client = makeFakeClient();
    const doc = makeDoc(buildRawDoc({ morphemes: [] }), client);

    expect(await doc.updateMorphemeSpan(morphOf(doc).id, 'Gloss', 'DOG')).toBe(true);

    expect(callsOf(client, 'tokens.create')).toHaveLength(1);
    const spans = callsOf(client, 'spans.create');
    expect(spans).toHaveLength(1);
    expect(callsOf(client, 'batch.submit')).toHaveLength(1);
    // The span points at the token written before it in the batch, never at
    // the virtual id.
    expect(spans[0].args[1]).toEqual([{ $ref: 0 }]);
    expect(morphOf(doc).annotations.Gloss?.value).toBe('DOG');
    expect(morphOf(doc).id.startsWith('tok')).toBe(true);
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

  it('splitMorpheme makes both pieces in one batch, so a refusal leaves neither', async () => {
    const client = makeFakeClient();
    const doc = makeDoc(buildRawDoc({ morphemes: [] }), client);

    expect(await doc.splitMorpheme(morphOf(doc).id, 'th', 'e')).toBe(true);
    // Every create went into the one batch, the morpheme being split first.
    const creates = callsOf(client, 'tokens.create');
    expect(creates.map((c) => c.args[5]?.form)).toEqual(['th', 'e']);
    expect(callsOf(client, 'batch.submit')).toHaveLength(1);
    const order = client.calls.map((c) => c.kind);
    expect(order.lastIndexOf('tokens.create')).toBeLessThan(order.indexOf('batch.submit'));
    // Both pieces carry the server's ids, so a later write names them.
    const ids = doc.sentences[0].tokens[0].morphemes.map((m) => m.id);
    expect(ids.every((id) => id.startsWith('tok'))).toBe(true);

    // Refused: nothing was made on its own ahead of the batch.
    const refusing = makeFakeClient();
    refusing.batched = async () => {
      throw Object.assign(new Error('HTTP 403 refused'), { status: 403 });
    };
    const doc2 = makeDoc(buildRawDoc({ morphemes: [] }), refusing);
    expect(await doc2.splitMorpheme(morphOf(doc2).id, 'th', 'e')).toBe(false);
    expect(callsOf(refusing, 'tokens.create')).toHaveLength(0);
    expect(callsOf(refusing, 'tokens.bulkCreate')).toHaveLength(0);
  });
});

describe('accepting a guess on a word nobody has analyzed', () => {
  it('makes the morpheme and its gloss in one batch', async () => {
    const client = makeFakeClient();
    const doc = makeDoc(buildRawDoc({ morphemes: [] }), client);

    expect(
      await doc.confirmWordAnalysis('w-1', [
        { targetId: morphOf(doc).id, field: 'Gloss', value: 'DEF' },
      ]),
    ).toBe(true);

    expect(callsOf(client, 'batch.submit')).toHaveLength(1);
    expect(callsOf(client, 'tokens.create')).toHaveLength(1);
    const [span] = callsOf(client, 'spans.create');
    expect(span.args[1]).toEqual([{ $ref: 0 }]);
    expect(morphOf(doc).annotations.Gloss?.value).toBe('DEF');
    expect(morphOf(doc).id.startsWith('tok')).toBe(true);
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

// Auto-link can name an unanalyzed word's morpheme. That morpheme is made in
// the same batch as the link to it, so a refused link leaves no bare morpheme
// behind (REV-F-IGT O3).
describe('bulkLinkVocab over unanalyzed words', () => {
  const vocabularies = () => ({
    v1: { id: 'v1', items: [{ id: 'i-1', form: 'the' }], vocabLinks: [] },
  });
  const linkDoc = (client) =>
    makeIgtDoc({
      raw: buildRawDoc({ morphemes: [] }),
      project: { id: 'proj-1', vocabs: [], config: {} },
      vocabularies: vocabularies(),
      client,
    });
  const kindsOf = (client) =>
    client.calls.map((c) => c.kind).filter((k) => !/Operation|operationGroups/.test(k));

  it('makes the morphemes and their links in one batch, the links naming them by ref', async () => {
    const client = makeFakeClient();
    const doc = linkDoc(client);
    const n = await doc.bulkLinkVocab(
      [
        { tokenId: 'virtual:w-1', vocabItemId: 'i-1' },
        { tokenId: 'virtual:w-2', vocabItemId: 'i-1' },
      ],
      'rule:test',
    );
    expect(n).toBe(2);
    expect(kindsOf(client).slice(0, 3)).toEqual([
      'tokens.bulkCreate',
      'vocabLinks.bulkCreate',
      'batch.submit',
    ]);
    const bulk = callsOf(client, 'tokens.bulkCreate')[0].args[0];
    expect(bulk).toMatchObject([
      { begin: 0, end: 3, precedence: 1 },
      { begin: 4, end: 7, precedence: 1 },
    ]);
    const links = callsOf(client, 'vocabLinks.bulkCreate')[0].args[0];
    expect(links.map((l) => l.tokens[0])).toEqual([
      { $ref: 0, index: 0 },
      { $ref: 0, index: 1 },
    ]);
  });

  it('makes one morpheme for a word named twice, not two', async () => {
    const client = makeFakeClient();
    const doc = linkDoc(client);
    await doc.bulkLinkVocab(
      [
        { tokenId: 'virtual:w-1', vocabItemId: 'i-1' },
        { tokenId: 'virtual:w-1', vocabItemId: 'i-1' },
      ],
      'rule:test',
    );
    expect(callsOf(client, 'tokens.bulkCreate')).toHaveLength(0);
    expect(callsOf(client, 'tokens.create')).toHaveLength(1);
    const links = callsOf(client, 'vocabLinks.bulkCreate')[0].args[0];
    expect(links[0].tokens[0]).toEqual(links[1].tokens[0]);
  });

  it('drops a proposal whose word is gone rather than writing against it', async () => {
    const client = makeFakeClient();
    const doc = linkDoc(client);
    expect(
      await doc.bulkLinkVocab([{ tokenId: 'virtual:w-gone', vocabItemId: 'i-1' }], 'rule:test'),
    ).toBe(0);
    expect(callsOf(client, 'tokens.bulkCreate')).toHaveLength(0);
    expect(callsOf(client, 'tokens.create')).toHaveLength(0);
    expect(callsOf(client, 'vocabLinks.bulkCreate')).toHaveLength(0);
  });

  it('makes no morpheme on its own when the links are refused', async () => {
    const client = makeFakeClient();
    const made = [];
    const create = client.tokens.create;
    client.tokens.create = (...args) => (made.push(args), create(...args));
    client.tokens.bulkCreate = (...args) => (made.push(args), { ids: [] });
    client.batched = async () => {
      throw Object.assign(new Error('Conflict'), { status: 409 });
    };
    client.documents.get = async () => buildRawDoc({ morphemes: [] });
    const doc = linkDoc(client);
    expect(
      await doc.bulkLinkVocab([{ tokenId: 'virtual:w-1', vocabItemId: 'i-1' }], 'rule:test'),
    ).toBe(false);
    expect(made).toEqual([]);
  });
});

// A pick from the pair picker sets a morpheme's link and gloss together: one
// patch, one batch, so a refusal leaves neither half (setMorphemePair).
describe('setMorphemePair', () => {
  const MACHINE = { prov: 'inferred', provSource: 'service:m' };
  const vocabularies = (links = []) => ({
    v1: {
      id: 'v1',
      name: 'Lexicon',
      items: [
        { id: 'i-sell', form: 'the', metadata: { gloss: 'sell', morphType: 'stem' } },
        { id: 'i-sold', form: 'the', metadata: { gloss: 'sold' } },
      ],
      vocabLinks: links,
    },
  });
  // The first word analyzed (m-1) or not, with a gloss span and a link.
  const pairDoc = (client, { morphemes, gloss = null, link = null, fields } = {}) => {
    const raw = buildRawDoc({ morphemes, morphFields: fields });
    if (gloss) {
      raw.textLayers[0].tokenLayers[2].spanLayers[0].spans.push({
        id: 'sp-1',
        tokens: ['m-1'],
        value: gloss.value,
        metadata: gloss.metadata ?? {},
      });
    }
    const links = link
      ? [
          {
            id: 'l-1',
            tokens: ['m-1'],
            vocabItem: { id: link.item, layer: 'v1', form: 'the' },
            metadata: link.metadata ?? {},
          },
        ]
      : [];
    return makeIgtDoc({
      raw,
      project: { id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {} } },
      vocabularies: vocabularies(links),
      client,
    });
  };
  const kindsOf = (client) =>
    client.calls.map((c) => c.kind).filter((k) => !/Operation|operationGroups/.test(k));

  it('makes an unanalyzed word’s morpheme, its gloss and its link in one batch', async () => {
    const client = makeFakeClient();
    const doc = pairDoc(client, { morphemes: [] });
    const write = doc.setMorphemePair(morphOf(doc).id, {
      field: 'Gloss',
      value: 'sold',
      itemId: 'i-sold',
      metadata: { prov: 'inferred', provConfirmed: true, provSource: 'service:m' },
      linkStamp: { prov: 'inferred', provConfirmed: true, provSource: 'service:m' },
      adopted: true,
    });
    // Both halves show before the server answers.
    expect(morphOf(doc).annotations.Gloss?.value).toBe('sold');
    expect(morphOf(doc).vocabItem?.id).toBe('i-sold');
    expect(await write).toBe(true);
    expect(kindsOf(client)).toEqual([
      'tokens.create',
      'spans.create',
      'vocabLinks.create',
      'batch.submit',
    ]);
    // Span and link name the morpheme by the batch's ref, never the virtual id.
    expect(callsOf(client, 'spans.create')[0].args[1]).toEqual([{ $ref: 0 }]);
    expect(callsOf(client, 'vocabLinks.create')[0].args[1]).toEqual([{ $ref: 0 }]);
    expect(callsOf(client, 'vocabLinks.create')[0].args[2]).toMatchObject({
      provSource: 'service:m',
    });
    expect(client.calls.find((c) => c.kind === 'beginOperation').args[1]).toEqual({
      kind: 'guess-adoption',
    });
    expect(morphOf(doc).id.startsWith('tok')).toBe(true);
  });

  it('leaves neither half when the batch is refused', async () => {
    const client = makeFakeClient();
    client.batched = async () => {
      throw Object.assign(new Error('HTTP 422 refused'), { status: 422 });
    };
    client.documents.get = async () => buildRawDoc({ morphemes: [] });
    const doc = pairDoc(client, { morphemes: [] });
    expect(
      await doc.setMorphemePair(morphOf(doc).id, {
        field: 'Gloss',
        value: 'sold',
        itemId: 'i-sold',
      }),
    ).toBe(false);
    expect(morphOf(doc).virtual).toBe(true);
    expect(morphOf(doc).annotations.Gloss ?? null).toBeNull();
    expect(morphOf(doc).vocabItem ?? null).toBeNull();
    expect(doc.vocabularies.v1?.vocabLinks ?? []).toEqual([]);
    expect(callsOf(client, 'tokens.create')).toHaveLength(0);
  });

  it('relinks and confirms a machine value it leaves as it is', async () => {
    const client = makeFakeClient();
    const doc = pairDoc(client, {
      gloss: { value: 'sell', metadata: MACHINE },
      link: { item: 'i-sell', metadata: MACHINE },
    });
    expect(
      await doc.setMorphemePair('m-1', { field: 'Gloss', value: 'sell', itemId: 'i-sold' }),
    ).toBe(true);
    expect(kindsOf(client)).toEqual([
      'spans.patchMetadata',
      'vocabLinks.delete',
      'vocabLinks.create',
      'batch.submit',
    ]);
    expect(morphOf(doc).annotations.Gloss.metadata.provConfirmed).toBe(true);
    expect(morphOf(doc).vocabItem.id).toBe('i-sold');
  });

  it('writes the value and confirms a machine link it leaves as it is', async () => {
    const client = makeFakeClient();
    const doc = pairDoc(client, {
      gloss: { value: 'sell', metadata: MACHINE },
      link: { item: 'i-sell', metadata: MACHINE },
    });
    expect(
      await doc.setMorphemePair('m-1', { field: 'Gloss', value: 'sold', itemId: 'i-sell' }),
    ).toBe(true);
    expect(kindsOf(client)).toEqual([
      'spans.update',
      'spans.patchMetadata',
      'vocabLinks.patchMetadata',
      'batch.submit',
    ]);
    expect(morphOf(doc).annotations.Gloss.value).toBe('sold');
    // An ordinary edit: it verifies the span and keeps the producer's record.
    expect(morphOf(doc).annotations.Gloss.metadata).toMatchObject({
      provSource: 'service:m',
      provConfirmed: true,
    });
    expect(morphOf(doc).vocabItem.prov).toBe('verified');
  });

  it('only confirms when both halves stay, and writes nothing when there is nothing to confirm', async () => {
    const client = makeFakeClient();
    const doc = pairDoc(client, {
      gloss: { value: 'sell', metadata: MACHINE },
      link: { item: 'i-sell', metadata: MACHINE },
    });
    expect(
      await doc.setMorphemePair('m-1', { field: 'Gloss', value: 'sell', itemId: 'i-sell' }),
    ).toBe(true);
    expect(kindsOf(client)).toEqual([
      'spans.patchMetadata',
      'vocabLinks.patchMetadata',
      'batch.submit',
    ]);

    const quiet = makeFakeClient();
    const own = pairDoc(quiet, { gloss: { value: 'sell' }, link: { item: 'i-sell' } });
    expect(
      await own.setMorphemePair('m-1', { field: 'Gloss', value: 'sell', itemId: 'i-sell' }),
    ).toBe(true);
    expect(kindsOf(quiet)).toEqual([]);
  });

  it('keeps the link of a value-only pick, and fills the other fields it is given', async () => {
    const client = makeFakeClient();
    const doc = pairDoc(client, {
      fields: ['Gloss', 'Gloss (es)'],
      link: { item: 'i-sell' },
    });
    expect(
      await doc.setMorphemePair('m-1', {
        field: 'Gloss',
        value: 'trade',
        fill: [{ field: 'Gloss (es)', value: 'vender' }],
      }),
    ).toBe(true);
    expect(kindsOf(client)).toEqual(['spans.create', 'spans.create', 'batch.submit']);
    expect(morphOf(doc).annotations['Gloss (es)'].value).toBe('vender');
    expect(morphOf(doc).vocabItem.id).toBe('i-sell');
  });

  it('stamps a contributor’s pick as their contribution', async () => {
    const client = makeFakeClient();
    const raw = buildRawDoc();
    raw.textLayers[0].tokenLayers[2].spanLayers[0].spans.push({
      id: 'sp-1',
      tokens: ['m-1'],
      value: 'sell',
      metadata: MACHINE,
    });
    const doc = makeIgtDoc({
      raw,
      project: {
        id: 'proj-1',
        vocabs: [{ id: 'v1' }],
        config: { plaid: { review: { users: ['ann@x.com'] } } },
        writers: ['ann@x.com'],
      },
      vocabularies: vocabularies(),
      client,
      user: { id: 'ann@x.com', isAdmin: false },
    });
    await doc.setMorphemePair('m-1', { field: 'Gloss', value: 'sell', itemId: 'i-sold' });
    expect(morphOf(doc).annotations.Gloss.metadata).toMatchObject({ prov: 'contributed' });
    expect(morphOf(doc).vocabItem.prov).toBe('contributed');
  });

  it('writes the entry’s type to the morpheme it links, in the same batch', async () => {
    const client = makeFakeClient();
    const doc = pairDoc(client, {});
    await doc.setMorphemePair('m-1', { field: 'Gloss', value: 'sell', itemId: 'i-sell' });
    expect(kindsOf(client)).toEqual([
      'spans.create',
      'vocabLinks.create',
      'tokens.patchMetadata',
      'batch.submit',
    ]);
    expect(callsOf(client, 'tokens.patchMetadata')[0].args[1]).toEqual([
      { op: 'set', path: ['morphType'], value: 'stem' },
    ]);
  });
});
