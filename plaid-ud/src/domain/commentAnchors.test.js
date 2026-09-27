import { describe, it, expect } from 'vitest';
import { buildAnchorIndex } from './commentAnchors.js';

// A sentence's `excerpt` is the text its `detail` quotes, so the Comments tab
// can give the sentence its own direction apart from "Sentence 2 · “".
describe('a sentence anchor', () => {
  const doc = {
    id: 'd',
    name: 'Doc',
    sentences: [
      { id: 's1', text: 'قرأ   الولد.', sentenceToken: { metadata: { sent_id: 'short' } } },
      { id: 's2', text: 'x'.repeat(80), sentenceToken: { metadata: {} } },
      { id: 's3', text: '  ', sentenceToken: { metadata: {} } },
    ],
  };
  const index = buildAnchorIndex(doc);

  it('names the quoted text as its excerpt, inside the detail', () => {
    expect(index.get('s1')).toMatchObject({
      label: 'short',
      detail: 'Sentence 1 · “قرأ الولد.”',
      excerpt: 'قرأ الولد.',
    });
  });

  it('cuts a long sentence the same way in both', () => {
    const { detail, excerpt } = index.get('s2');
    expect(excerpt).toBe(`${'x'.repeat(59)}…`);
    expect(detail).toBe(`“${excerpt}”`);
  });

  it('has no quote and no excerpt for an empty sentence', () => {
    expect(index.get('s3')).toMatchObject({ detail: '', excerpt: '' });
  });
});
