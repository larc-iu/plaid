// Astral-text (>= U+10000) coverage for code-point offsets. 😀 = U+1F600 is
// ONE code point but TWO UTF-16 units, so in "😀 cat dog" the word "cat" is
// code-point [2,5] (it would be UTF-16 [3,6]). Token offsets are code points.
import { describe, it, expect } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, makeFakeClient } from './test-helpers.js';
import {
  findUntokenizedRanges, tokenizeText, tokenizeSentences, validateTokenization,
} from '../utils/tokenizationUtils.js';

const makeDoc = (raw) => new IgtDocument({
  raw,
  project: { id: 'proj-1', config: { plaid: {} } },
  vocabularies: {},
  client: makeFakeClient(),
  projectId: 'proj-1',
});

describe('code-point offsets (astral text)', () => {
  it('derive slices token content by code points', () => {
    const doc = makeDoc(buildRawDoc({
      body: '😀 cat dog',
      words: [{ id: 'w-1', begin: 2, end: 5 }, { id: 'w-2', begin: 6, end: 9 }],
    }));
    expect(doc.sentences[0].tokens.map(t => t.content)).toEqual(['cat', 'dog']);
  });

  it('tokenizeText emits code-point offsets with correct surfaces', () => {
    const text = '😀 cat dog';
    const tokens = tokenizeText(text, null, findUntokenizedRanges(text, []));
    expect(tokens).toEqual([
      { text: '😀', begin: 0, end: 1 },
      { text: 'cat', begin: 2, end: 5 },
      { text: 'dog', begin: 6, end: 9 },
    ]);
    expect(validateTokenization(tokens, text).isValid).toBe(true);
  });

  it('tokenizeSentences splits on newlines in code-point offsets', () => {
    const text = '😀a\nb'; // code points: 😀(0) a(1) \n(2) b(3)
    const sents = tokenizeSentences(text, []);
    expect(sents.map(s => s.text)).toEqual(['😀a', 'b']);
    expect(sents.map(s => [s.begin, s.end])).toEqual([[0, 2], [3, 4]]);
  });
});
