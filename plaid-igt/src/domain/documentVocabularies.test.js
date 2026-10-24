import { describe, it, expect } from 'vitest';
import { documentVocabularies, linkedVocabIds } from './documentVocabularies.js';
import { IgtDocument } from './IgtDocument.js';

const role = (r) => ({ plaid: { role: r } });

// "katri": the word, its morphemes kat and ri, and ri linked to an enclitic
// entry. The document GET embeds the entry with no metadata.
const raw = () => ({
  id: 'd1',
  name: 'Doc',
  project: 'p1',
  textLayers: [
    {
      config: role('baseline'),
      text: { body: 'katri' },
      tokenLayers: [
        { config: role('sentence'), tokens: [{ id: 's1', begin: 0, end: 5 }], spanLayers: [] },
        { config: role('word'), tokens: [{ id: 'w1', begin: 0, end: 5 }], spanLayers: [] },
        {
          config: role('morpheme'),
          tokens: [
            { id: 'm1', begin: 0, end: 5, precedence: 1, metadata: { form: 'kat' } },
            { id: 'm2', begin: 0, end: 5, precedence: 2, metadata: { form: 'ri' } },
          ],
          spanLayers: [],
          vocabs: [
            {
              id: 'v1',
              name: 'Lexicon',
              vocabLinks: [{ id: 'l1', tokens: ['m2'], vocabItem: { id: 'i1', form: 'ri' } }],
            },
          ],
        },
      ],
    },
  ],
});

const client = () => ({
  documents: { get: async () => raw() },
  vocabLayers: {
    get: async (id, items) =>
      items
        ? {
            id,
            name: 'Lexicon',
            items: [{ id: 'i1', form: 'ri', metadata: { morphType: 'enclitic' } }],
          }
        : { id, timeModified: null },
  },
});

describe('documentVocabularies', () => {
  it('reads the vocabularies the links name, with their entries and no links', async () => {
    expect(linkedVocabIds(raw())).toEqual(['v1']);
    const vocabs = await documentVocabularies(client(), raw());
    expect(vocabs.v1.items[0].metadata.morphType).toBe('enclitic');
    expect(vocabs.v1.vocabLinks).toEqual([]);
  });

  it("gives a linked morpheme its entry's type (HUNT-recent 1)", async () => {
    const doc = new IgtDocument({
      raw: raw(),
      vocabularies: await documentVocabularies(client(), raw()),
      client: client(),
    });
    const word = doc.sentences[0].tokens[0];
    expect(word.morphemes.map((m) => m.morphType ?? null)).toEqual([null, 'enclitic']);
  });
});
