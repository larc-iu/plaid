// A word made by hand over text that holds a punctuation token ud made takes
// that token's place, as it would over untokenized punctuation (ruling 29):
// the word layer allows no overlap, so the token goes in the same batch.
import { describe, it, expect, beforeEach } from 'vitest';
import { buildRawDoc, resetIds, makeIgtDoc, settle } from '../test-helpers.js';
import { absorbedTokens } from './tokens.js';

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
