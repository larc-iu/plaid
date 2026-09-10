import { describe, it, expect } from 'vitest';
import { sameFormUnlinked } from './linkEverywhere.js';

const word = (id, content, extra = {}) => ({ id, content, morphemes: [], ...extra });
const morph = (id, form, extra = {}) => ({ id, metadata: { form }, ...extra });

const sentences = [
  {
    id: 's1',
    tokens: [
      word('w1', 'roa', { morphemes: [morph('m1', 'roa')] }),
      word('w2', 'aroa', {
        morphemes: [morph('m2', 'a', { vocabItem: { id: 'e-a' } }), morph('m3', 'roa')],
      }),
    ],
  },
  {
    id: 's2',
    tokens: [
      word('w3', 'roa', { vocabItem: { id: 'e-roa' } }),
      word('w4', 'Roa'),
      word('w5', 'roa', { morphemes: [morph('m4', 'roa', { vocabItem: { id: 'e-roa' } })] }),
    ],
  },
];

describe('sameFormUnlinked', () => {
  it('finds the other unlinked morphemes showing the same form, in order', () => {
    expect(sameFormUnlinked(sentences, 'morpheme', 'roa', 'm1')).toEqual(['m3']);
  });

  it('finds the other unlinked words with the same content, exactly', () => {
    // w3 is linked, w4 differs in case, w1 is the one asking.
    expect(sameFormUnlinked(sentences, 'word', 'roa', 'w1')).toEqual(['w5']);
  });

  it('takes an edited morpheme form over the baseline content', () => {
    const edited = [{ id: 's', tokens: [word('w', 'x', { morphemes: [morph('m', 'roa')] })] }];
    expect(sameFormUnlinked(edited, 'morpheme', 'roa', 'other')).toEqual(['m']);
  });
});
