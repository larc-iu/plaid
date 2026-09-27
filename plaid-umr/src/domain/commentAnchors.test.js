import { describe, it, expect } from 'vitest';
import { buildAnchorIndex } from './commentAnchors.js';

// A sentence's `excerpt` is the text its `detail` quotes, so the Comments tab
// can give the sentence its own direction apart from the quote marks.
describe('a sentence anchor', () => {
  it('names the quoted text as its excerpt', () => {
    const index = buildAnchorIndex({
      id: 'd',
      sentences: [{ tokenId: 't1', index: 1, text: 'قرأ الولد.' }],
    });
    expect(index.get('t1')).toMatchObject({ detail: '“قرأ الولد.”', excerpt: 'قرأ الولد.' });
  });
});

describe('a long sentence anchor', () => {
  it('counts in code points and cuts at a character a person sees as one', () => {
    // 60 code points, 62 UTF-16 units: it fits whole.
    const fits = `${'a'.repeat(58)}😀😀`;
    // A letter and its combining mark straddle the cut.
    const long = `${'b'.repeat(58)}e\u0301${'c'.repeat(10)}`;
    const index = buildAnchorIndex({
      id: 'd',
      sentences: [
        { tokenId: 't1', index: 1, text: fits },
        { tokenId: 't2', index: 2, text: long },
      ],
    });
    expect(index.get('t1').excerpt).toBe(fits);
    expect(index.get('t2').excerpt).toBe(`${'b'.repeat(58)}…`);
  });
});
