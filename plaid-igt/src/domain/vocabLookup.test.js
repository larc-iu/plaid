import { describe, it, expect } from 'vitest';
import { entryMorphTypesOf, itemsById, lexiconViewOf, shareVocabularies } from './vocabLookup.js';
import { deriveSentences } from './derive.js';
import { getIgtLayerInfo } from './layerInfo.js';
import { rebaseVocabLinks } from './IgtDocument.js';
import { buildRawDoc } from './test-helpers.js';

const lexicon = () => ({
  v1: {
    id: 'v1',
    name: 'Lexicon',
    items: [
      { id: 'root', form: 'ka', metadata: { morphType: 'root' } },
      // A sense made by hand carries no type of its own, and goes by its
      // headword's.
      { id: 'sense', form: 'ka', metadata: { parent: 'root', senseOrder: 1 } },
    ],
  },
});

describe('shared entry lists', () => {
  it('build each index once over a shared list, and afresh over any other', () => {
    const { v1 } = shareVocabularies(lexicon());
    expect(itemsById(v1)).toBe(itemsById(v1));
    expect(lexiconViewOf(v1.items)).toBe(lexiconViewOf(v1.items));
    expect(entryMorphTypesOf(v1.items)).toBe(entryMorphTypesOf(v1.items));
    const own = lexicon().v1;
    expect(itemsById(own)).not.toBe(itemsById(own));
    expect(lexiconViewOf(own.items)).not.toBe(lexiconViewOf(own.items));
  });

  it('cannot be edited in place once shared', () => {
    const { v1 } = shareVocabularies(lexicon());
    expect(() => v1.items.push({ id: 'x', form: 'x' })).toThrow();
  });

  it('give every document what its own copy gave it', () => {
    const raw = () =>
      buildRawDoc({
        morphVocabs: [
          {
            id: 'v1',
            name: 'Lexicon',
            vocabLinks: [{ id: 'l1', tokens: ['m-1'], vocabItem: { id: 'sense', form: 'ka' } }],
          },
        ],
      });
    const derived = (vocabularies) => {
      const r = raw();
      // What the IgtDocument constructor does with the links.
      const vocabs = rebaseVocabLinks(vocabularies);
      vocabs.v1.vocabLinks = r.textLayers[0].tokenLayers[2].vocabs[0].vocabLinks;
      return deriveSentences(r, getIgtLayerInfo(r), vocabs).sortedSentences;
    };
    const shared = shareVocabularies(lexicon());
    const first = derived(shared);
    expect(derived(shared)).toEqual(first);
    expect(derived(lexicon())).toEqual(first);
    expect(first[0].tokens[0].morphemes[0].morphType).toBe('root');
  });
});
