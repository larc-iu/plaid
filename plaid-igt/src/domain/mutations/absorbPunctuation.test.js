// A word made by hand over text that holds a punctuation token ud made takes
// that token's place, as it would over untokenized punctuation (ruling 29):
// the word layer allows no overlap, so the token goes in the same batch.
import { describe, it, expect, beforeEach } from 'vitest';
import { buildRawDoc, resetIds, makeIgtDoc, settle } from '../test-helpers.js';
import { absorbedTokens, mergeAbsorbs } from './tokens.js';
import { countSubWordAnnotationLoss } from '../annotationLoss.js';

beforeEach(() => resetIds());

const build = (punct) => {
  const raw = buildRawDoc({
    body: "ab k'a cd",
    words: [
      { id: 'w-1', begin: 0, end: 2 },
      ...(punct ? [{ id: 'p-1', begin: 4, end: 5 }] : []),
      { id: 'w-3', begin: 7, end: 9 },
    ],
    morphemes: [],
  });
  const layer = raw.textLayers[0].tokenLayers.find((l) => l.id === 'wordL');
  layer.config.igt.ignoredTokens = { type: 'unicodePunctuation', whitelist: [] };
  return makeIgtDoc({ raw });
};

const words = (doc) =>
  doc.layerInfo.primaryTokenLayer.tokens.map((t) => [t.begin, t.end]).sort((a, b) => a[0] - b[0]);

describe("a word made over ud's punctuation token", () => {
  it('finds the ignored tokens it overlaps, and no word', () => {
    const doc = build(true);
    expect(absorbedTokens(doc.layerInfo, doc.body, 3, 6).map((t) => t.id)).toEqual(['p-1']);
    expect(absorbedTokens(doc.layerInfo, doc.body, 0, 9).map((t) => t.id)).toEqual(['p-1']);
    expect(absorbedTokens(doc.layerInfo, doc.body, 0, 2)).toEqual([]);
  });

  it('ends with the same words as over untokenized text, in one batch', async () => {
    const plain = build(false);
    const punct = build(true);
    expect(await plain.createToken(3, 6)).toBe(true);
    expect(await punct.createToken(3, 6)).toBe(true);
    await settle();
    expect(words(punct)).toEqual(words(plain));
    const kinds = punct.client.calls.map((c) => c.kind).filter((k) => /^tokens\./.test(k));
    expect(kinds).toEqual(['tokens.bulkDelete', 'tokens.create']);
    expect(punct.client.calls.find((c) => c.kind === 'tokens.bulkDelete').args[0]).toEqual(['p-1']);
  });
});

// A merge across a punctuation token ud made works as across untokenized
// punctuation (REV7-IGT-3): the token goes in the merge's own batch.
const buildMerge = (punct) => {
  const raw = buildRawDoc({
    body: 'ab, cd',
    words: [
      { id: 'w-1', begin: 0, end: 2 },
      ...(punct ? [{ id: 'p-1', begin: 2, end: 3 }] : []),
      { id: 'w-3', begin: 4, end: 6 },
    ],
    morphemes: [],
  });
  const layer = raw.textLayers[0].tokenLayers.find((l) => l.id === 'wordL');
  layer.config.igt.ignoredTokens = { type: 'unicodePunctuation', whitelist: [] };
  if (punct) {
    // ud's lemma on the comma, which igt does not show.
    layer.spanLayers.push({
      id: 'ud-lemma',
      name: 'Lemma',
      config: {},
      spans: [{ id: 'sp-ud', tokens: ['p-1'], value: ',' }],
      relationLayers: [],
    });
  }
  return makeIgtDoc({ raw });
};

describe("a merge across ud's punctuation token", () => {
  it('ends with the same words as across untokenized text, in one batch', async () => {
    const plain = buildMerge(false);
    const punct = buildMerge(true);
    expect(
      mergeAbsorbs(
        punct.layerInfo,
        punct.body,
        punct.layerInfo.primaryTokenLayer.tokens.filter((t) => t.id !== 'p-1'),
      ).map((t) => t.id),
    ).toEqual(['p-1']);
    expect(await plain.mergeTokens(['w-1', 'w-3'])).not.toBe(false);
    expect(await punct.mergeTokens(['w-1', 'w-3'])).not.toBe(false);
    await settle();
    expect(words(punct)).toEqual(words(plain));
    expect(words(punct)).toEqual([[0, 6]]);
    const kinds = punct.client.calls.map((c) => c.kind).filter((k) => /^tokens\./.test(k));
    expect(kinds).toEqual(['tokens.bulkDelete', 'tokens.merge']);
    expect(punct.client.calls.find((c) => c.kind === 'tokens.bulkDelete').args[0]).toEqual(['p-1']);
  });

  it('counts the annotations on the token it takes in, and none on plain text', () => {
    const plain = buildMerge(false);
    const punct = buildMerge(true);
    const merged = (doc) => doc.layerInfo.primaryTokenLayer.tokens.filter((t) => t.id !== 'p-1');
    const lossOf = (doc) =>
      countSubWordAnnotationLoss(
        doc.layerInfo,
        doc.vocabularies,
        merged(doc),
        mergeAbsorbs(doc.layerInfo, doc.body, merged(doc)),
      );
    expect(lossOf(plain).annotations).toBe(0);
    expect(lossOf(punct).annotations).toBe(1);
  });
});

// Clear tokens deletes the words igt counts in its question, and leaves a
// punctuation token another app made, which igt reads as text (REV7-IGT-5).
describe("Clear tokens beside ud's punctuation token", () => {
  it('deletes the words it shows, and igt reads the document as without the token', async () => {
    const plain = buildMerge(false);
    const punct = buildMerge(true);
    expect(await plain.clearTokens()).not.toBe(false);
    expect(await punct.clearTokens()).not.toBe(false);
    await settle();
    const deleted = punct.client.calls.find((c) => c.kind === 'tokens.bulkDelete').args[0];
    expect(deleted).toEqual(['w-1', 'w-3']);
    expect(words(punct)).toEqual([[2, 3]]);
    const shown = (doc) => doc.sentences.flatMap((s) => s.tokens || []).length;
    expect(shown(punct)).toBe(shown(plain));
    expect(shown(punct)).toBe(0);
  });
});
