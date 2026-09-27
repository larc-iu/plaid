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
