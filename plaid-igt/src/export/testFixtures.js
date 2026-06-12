// Shared fixtures for the export serializer tests. A minimal igtDoc-shaped
// object is enough: the serializers only touch .document, .body, and
// .sortedSentences (see plainTextDoc.js / flextext.js).

const span = (v) => ({ value: v });

export const makeSentence = ({
  begin, end, tokens, annotations = {}, pieces = null,
}) => ({
  id: `s-${begin}`, begin, end, annotations, tokens,
  pieces: pieces ?? tokens.map((t) => ({ type: 'token', ...t })),
});

// "perros corren." with a Translit orthography, POS word field, Gloss morph
// field, Translation/Note sentence fields, an enclitic, a linked vocab item,
// and a trailing punctuation gap.
export function makeFixtureDoc() {
  const tokens = [
    {
      id: 'w1', begin: 0, end: 6, content: 'perros',
      metadata: {},
      orthographies: { Translit: 'perros-translit' },
      annotations: { POS: span('NOUN') },
      vocabItem: null,
      morphemes: [
        {
          id: 'm1', begin: 0, end: 5, content: 'perro',
          metadata: { form: 'perro', morphType: 'stem' },
          annotations: { Gloss: span('dog') },
          vocabItem: { id: 'v1', form: 'perro', metadata: {} },
        },
        {
          id: 'm2', begin: 5, end: 6, content: 's',
          metadata: { form: 's', morphType: 'enclitic' },
          annotations: { Gloss: span('PL') },
          vocabItem: null,
        },
      ],
    },
    {
      id: 'w2', begin: 7, end: 13, content: 'corren',
      metadata: {},
      orthographies: { Translit: '' },
      annotations: { POS: span('VERB') },
      vocabItem: null,
      morphemes: [],
    },
  ];
  const sentence = makeSentence({
    begin: 0, end: 14, tokens,
    annotations: { Translation: span('The dogs run.'), Note: span('') },
    pieces: [
      { type: 'token', ...tokens[0] },
      { type: 'gap', content: ' ', isToken: false },
      { type: 'token', ...tokens[1] },
      { type: 'gap', content: '.', isToken: false },
    ],
  });
  return {
    document: { id: 'd1', name: 'Test & Doc', metadata: { Source: 'Field notes', Genre: 'narrative' } },
    body: 'perros corren.',
    sortedSentences: [sentence],
  };
}

export const FULL_SELECTION = {
  orthographies: ['Translit'],
  wordFields: ['POS'],
  morphFields: ['Gloss'],
  sentFields: ['Translation', 'Note'],
  segmentMorphemes: true,
  numberSentences: true,
  includeHeader: true,
};

export const FLEXTEXT_OPTIONS = {
  langs: {
    baseline: 'spa',
    analysis: 'en',
    orthographies: { Translit: 'spa-x-translit' },
    fieldOverrides: {},
  },
  fieldMap: {
    sentence: { Translation: 'gls', Note: 'note' },
    word: { POS: 'pos' },
    morpheme: { Gloss: 'gls' },
  },
  citationForms: true,
};
