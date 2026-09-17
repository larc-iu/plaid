import { describe, it, expect } from 'vitest';
import { elanCounts, previewSentence } from './preview.js';

const DOC = {
  body: 'again fesan\nyai',
  sentences: [
    { begin: 0, end: 12, fields: { Translation: 'he takes it', Note: '' } },
    { begin: 12, end: 15, fields: {} },
  ],
  words: [
    {
      begin: 0,
      end: 5,
      sentenceIndex: 0,
      fields: { POS: 'v', 'orthog:IPA': 'aɡain' },
      morphemes: [
        { form: 'a', morphType: null, fields: { Gloss: '3' } },
        { form: 'gain', morphType: null, fields: { Gloss: 'take' } },
      ],
    },
    { begin: 6, end: 11, sentenceIndex: 0, fields: {}, morphemes: [] },
    { begin: 12, end: 15, sentenceIndex: 1, fields: {}, morphemes: [] },
  ],
};

describe('previewSentence', () => {
  it('lays a sentence out as the rows the Analyze tab will show', () => {
    expect(previewSentence(DOC, 0)).toEqual({
      words: ['again', 'fesan'],
      rows: [
        { kind: 'orthography', label: 'IPA', cells: ['aɡain', ''] },
        { kind: 'word', label: 'POS', cells: ['v', ''] },
        // The word nobody segmented reads as itself, as it will in the grid.
        { kind: 'morphemes', label: 'Morphemes', cells: ['a-gain', 'fesan'] },
        { kind: 'morpheme', label: 'Gloss', cells: ['3-take', ''] },
      ],
      unanalyzed: [false, true],
      fields: [['Translation', 'he takes it']],
    });
  });

  it('draws no morpheme rows for a sentence nobody has segmented', () => {
    expect(previewSentence(DOC, 1)).toEqual({
      words: ['yai'],
      rows: [],
      unanalyzed: [false],
      fields: [],
    });
  });

  it('joins a clitic with its own joint, and a formless sole morpheme reads as the word', () => {
    const doc = {
      body: 'perros los',
      sentences: [{ begin: 0, end: 10, fields: {} }],
      words: [
        {
          begin: 0,
          end: 6,
          sentenceIndex: 0,
          fields: {},
          morphemes: [
            { form: 'perro', morphType: null, fields: {} },
            { form: 's', morphType: 'enclitic', fields: {} },
          ],
        },
        {
          begin: 7,
          end: 10,
          sentenceIndex: 0,
          fields: {},
          morphemes: [{ form: null, morphType: null, fields: { Gloss: 'DET' } }],
        },
      ],
    };
    const rows = previewSentence(doc, 0).rows;
    expect(rows[0].cells).toEqual(['perro=s', 'los']);
    expect(rows[1].cells).toEqual(['', 'DET']);
  });

  it('is null past the last sentence', () => {
    expect(previewSentence(DOC, 2)).toBeNull();
    expect(previewSentence(null)).toBeNull();
  });
});

describe('elanCounts', () => {
  it('says the batch in one line, and leaves out what there is none of', () => {
    const stats = { sentences: 1, words: 4, morphemes: 2, alignments: 0, speakers: [] };
    expect(elanCounts({ documents: [{}], stats })).toBe(
      '1 document · 1 sentence · 4 words · 2 morphemes',
    );
    expect(
      elanCounts({ documents: [{}, {}], stats: { ...stats, alignments: 3, speakers: ['AH'] } }),
    ).toBe(
      '2 documents · 1 sentence · 4 words · 2 morphemes · 3 time-aligned segments · speakers: AH',
    );
    expect(elanCounts(null)).toBe('');
  });
});
