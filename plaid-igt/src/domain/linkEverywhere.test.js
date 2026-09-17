import { describe, it, expect } from 'vitest';
import { sameFormUnlinked, sameFormUnanalyzed } from './linkEverywhere.js';

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

describe('sameFormUnanalyzed', () => {
  const person = { id: 'e', prov: 'human' };
  const bare = (id, content) =>
    word(id, content, { morphemes: [{ id: `v-${id}`, content, metadata: {} }] });
  const again = word('a1', 'again', {
    morphemes: [
      morph('a1m1', 'a', { vocabItem: { ...person, id: 'e-a' } }),
      morph('a1m2', 'gain', { vocabItem: { ...person, id: 'e-gain' } }),
    ],
  });
  const text = [
    {
      id: 's1',
      tokens: [
        again,
        bare('a2', 'again'),
        bare('a3', 'Again'),
        // Somebody's decision already: a link of its own.
        word('a4', 'again', { morphemes: [morph('a4m', 'again', { vocabItem: person })] }),
        bare('a5', 'again'),
      ],
    },
  ];

  it('finds the untouched words spelled the same, from the word or a morpheme of it', () => {
    expect(sameFormUnanalyzed(text, 'a1').ids).toEqual(['a2', 'a5']);
    const fromMorph = sameFormUnanalyzed(text, 'a1m2');
    expect(fromMorph.word.id).toBe('a1');
    expect(fromMorph.ids).toEqual(['a2', 'a5']);
    expect(fromMorph.analysis.morphemes.map((m) => [m.form, m.vocabItemId])).toEqual([
      ['a', 'e-a'],
      ['gain', 'e-gain'],
    ]);
  });

  it('offers nothing from a word with nothing to copy, or with no twin', () => {
    expect(sameFormUnanalyzed(text, 'a2')).toBeNull();
    expect(sameFormUnanalyzed([{ id: 's', tokens: [again] }], 'a1')).toBeNull();
  });

  it('offers nothing from machine output nobody confirmed', () => {
    const machine = { id: 'e', prov: 'machine' };
    const guessed = word('g1', 'again', {
      morphemes: [morph('g1m', 'again', { vocabItem: machine })],
    });
    expect(sameFormUnanalyzed([{ id: 's', tokens: [guessed, bare('g2', 'again')] }], 'g1')).toBe(
      null,
    );
  });
});
