// Shared fixtures for the export serializer tests. A minimal igtDoc-shaped
// object is enough: the serializers only touch .document, .body, and
// .sortedSentences (see plainTextDoc.js / flextext.js).

const span = (v) => ({ value: v });

export const makeSentence = ({ begin, end, tokens, annotations = {}, pieces = null }) => ({
  id: `s-${begin}`,
  begin,
  end,
  annotations,
  tokens,
  pieces: pieces ?? tokens.map((t) => ({ type: 'token', ...t })),
});

// "perros corren." with a Translit orthography, POS word field, Gloss morph
// field, Translation/Note sentence fields, an enclitic, a linked vocab item,
// and a trailing punctuation gap. Options: `alignmentTokens` (time-alignment
// layer tokens) and `mediaUrl` for the timing/media tests.
export function makeFixtureDoc({ alignmentTokens = [], mediaUrl = null } = {}) {
  const tokens = [
    {
      id: 'w1',
      begin: 0,
      end: 6,
      content: 'perros',
      metadata: {},
      orthographies: { Translit: 'perros-translit' },
      annotations: { POS: span('NOUN') },
      vocabItem: null,
      morphemes: [
        {
          id: 'm1',
          begin: 0,
          end: 5,
          content: 'perro',
          metadata: { form: 'perro', morphType: 'stem' },
          annotations: { Gloss: span('dog') },
          vocabItem: { id: 'v1', form: 'perro', metadata: {} },
        },
        {
          id: 'm2',
          begin: 5,
          end: 6,
          content: 's',
          metadata: { form: 's', morphType: 'enclitic' },
          annotations: { Gloss: span('PL') },
          vocabItem: null,
        },
      ],
    },
    {
      id: 'w2',
      begin: 7,
      end: 13,
      content: 'corren',
      metadata: {},
      orthographies: { Translit: '' },
      annotations: { POS: span('VERB') },
      vocabItem: null,
      morphemes: [],
    },
  ];
  const sentence = makeSentence({
    begin: 0,
    end: 14,
    tokens,
    annotations: { Translation: span('The dogs run.'), Note: span('') },
    pieces: [
      { type: 'token', ...tokens[0] },
      { type: 'gap', content: ' ', isToken: false },
      { type: 'token', ...tokens[1] },
      { type: 'gap', content: '.', isToken: false },
    ],
  });
  return {
    document: {
      id: 'd1',
      name: 'Test & Doc',
      mediaUrl,
      metadata: { Source: 'Field notes', Genre: 'narrative' },
    },
    body: 'perros corren.',
    sortedSentences: [sentence],
    alignmentTokens,
  };
}

/** A time-alignment token: char extent + {timeBegin, timeEnd} (seconds),
 * plus the optional diarization speaker the .eaf export splits tiers on. */
export const makeAlignmentToken = (id, begin, end, timeBegin, timeEnd, speaker = null) => ({
  id,
  begin,
  end,
  metadata: speaker ? { timeBegin, timeEnd, speaker } : { timeBegin, timeEnd },
});

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

const nativeRole = (r) => ({ plaid: { role: r } });

// A raw document exercising every loss trap. Morphemes are full-width (same
// extent as their word, ordered by precedence) per the IGT data model; the
// segment text lives in metadata.form. Body: "perros corren. extra" with the
// sentence covering [0,14) and 'extra' [15,20) outside it.
export function makeNativeRaw() {
  return {
    id: 'doc1',
    name: 'Doc One',
    version: 7,
    metadata: { Source: 'notes', importDone: true, custom: { k: 1 } }, // trap (a)
    textLayers: [
      {
        id: 'tl1',
        config: nativeRole('baseline'),
        text: { id: 'text1', body: 'perros corren. extra', metadata: { lang: 'es' } },
        tokenLayers: [
          {
            id: 'wl',
            config: { ...nativeRole('word'), igt: { orthographies: [{ name: 'Translit' }] } },
            tokens: [
              {
                id: 'w1',
                begin: 0,
                end: 6,
                metadata: { 'orthog:Translit': 'pt', 'orthog:Other': 'u', custom: 'x' },
              },
              { id: 'w2', begin: 7, end: 13, metadata: {} },
              { id: 'w3', begin: 15, end: 20, metadata: { stray: true } }, // outside the sentence — trap (f)
            ],
            spanLayers: [
              {
                id: 'slPOS',
                name: 'POS',
                config: { igt: { scope: 'Word' } },
                spans: [
                  {
                    id: 'sp1',
                    tokens: ['w1'],
                    value: 'NOUN',
                    metadata: { prov: 'inferred', provConfirmed: true },
                  },
                ],
              },
              {
                id: 'slPhrase',
                name: 'Phrase',
                config: { igt: { scope: 'Word' } },
                spans: [{ id: 'sp2', tokens: ['w1', 'w2'], value: 'NP' }], // one span, two tokens — trap (h)
              },
              {
                id: 'slMystery',
                name: 'Mystery',
                config: {}, // no scope: invisible to the derived view
                spans: [{ id: 'sp3', tokens: ['w1'], value: '?' }],
              },
            ],
            vocabs: [
              {
                id: 'vocab1',
                name: 'Lex',
                vocabLinks: [
                  {
                    id: 'l1',
                    tokens: ['m1'],
                    vocabItem: { id: 'item1', form: 'perro' },
                    metadata: { prov: 'inferred', provSource: 'flex-import' },
                  },
                  { id: 'l2', tokens: ['m1'], vocabItem: { id: 'item2' } }, // second link on m1 — trap (b)
                  {
                    id: 'l3',
                    tokens: ['w1', 'w2'],
                    vocabItem: { id: 'item3' },
                    metadata: { note: 'multi' },
                  }, // trap (b)
                ],
              },
            ],
          },
          {
            id: 'sl',
            config: nativeRole('sentence'),
            tokens: [{ id: 's1', begin: 0, end: 14, metadata: { speaker: 'A' } }],
            spanLayers: [
              {
                id: 'slTr',
                name: 'Translation',
                config: { igt: { scope: 'Sentence' } },
                spans: [
                  { id: 'sp4', tokens: ['s1'], value: 'The dogs run.' },
                  { id: 'sp5', tokens: ['s1'], value: 'dup' }, // duplicate per layer+token — trap (g)
                ],
              },
            ],
          },
          {
            id: 'ml',
            config: nativeRole('morpheme'),
            tokens: [
              {
                id: 'm1',
                begin: 0,
                end: 6,
                precedence: 1,
                metadata: { form: 'perro', morphType: 'stem' },
              },
              { id: 'm2', begin: 0, end: 6, precedence: 2, metadata: { form: '' } }, // '' is meaningful
              { id: 'm3', begin: 7, end: 13, precedence: 1, metadata: {} }, // no form key at all
              { id: 'mOrphan', begin: 15, end: 18, precedence: 1, metadata: { form: 'or' } }, // matches no word extent
            ],
            spanLayers: [
              {
                id: 'slGloss',
                name: 'Gloss',
                config: { igt: { scope: 'Morpheme' } },
                spans: [{ id: 'sp6', tokens: ['m1'], value: 'dog' }],
              },
            ],
          },
          {
            id: 'al',
            config: nativeRole('time-alignment'),
            tokens: [
              {
                id: 'a1',
                begin: 0,
                end: 14,
                metadata: { timeBegin: 1.25, timeEnd: 3.5, note: 'x' },
              },
            ],
          },
        ],
      },
    ],
  };
}

export const makeNativeProject = () => ({
  id: 'p1',
  name: 'Proj',
  config: {
    igt: {
      documentMetadata: [{ name: 'Source' }],
      autoAnalysis: { enabled: false },
    },
  },
  textLayers: makeNativeRaw().textLayers,
});

// Another Plaid app's layers beside this app's, on the loss-trap document. The
// app is made up (namespace `other`), since the archive must carry any app's
// layers without knowing it:
//   - a root token layer (overlap `any`) holding a ZERO-WIDTH token, with a
//     span layer and a relation layer on that
//   - a token layer nested in this app's word layer, and one nested in THAT,
//     listed child first so the archive has to put the parent first itself
//   - a span layer on this app's word layer that no field is, with a relation
//     layer hanging on it
//   - its own settings on the baseline text layer and on the project
// Body: "perros corren. extra". w1 = perros [0,6), w2 = corren [7,13).
export function makeOtherAppRaw() {
  const raw = makeNativeRaw();
  const text = raw.textLayers[0];
  text.config = { ...text.config, other: { locale: 'es' } };
  const wordLayer = text.tokenLayers.find((tl) => tl.id === 'wl');
  wordLayer.overlapMode = 'non-overlapping';
  wordLayer.parentTokenLayer = null;
  wordLayer.spanLayers.push({
    id: 'olLemma',
    name: 'Lemma',
    config: { other: { lemma: true } },
    spans: [
      { id: 'lem1', tokens: ['w1'], value: 'perro' },
      { id: 'lem2', tokens: ['w2'], value: 'correr', metadata: { prov: 'inferred' } },
    ],
    relationLayers: [
      {
        id: 'olDeps',
        name: 'Deps',
        config: { other: { deps: true } },
        relations: [{ id: 'dep1', source: 'lem2', target: 'lem1', value: 'nsubj' }],
      },
    ],
  });
  text.tokenLayers.push(
    {
      id: 'olNodes',
      name: 'Nodes',
      overlapMode: 'any',
      parentTokenLayer: null,
      config: { other: { nodes: true } },
      tokens: [
        { id: 'n1', begin: 20, end: 20, precedence: null, metadata: { abstract: 'person' } },
        { id: 'n2', begin: 0, end: 6, precedence: 2 },
      ],
      spanLayers: [
        {
          id: 'olConcepts',
          name: 'Concepts',
          config: { other: { concepts: true } },
          spans: [
            { id: 'c1', tokens: ['n1'], value: 'person' },
            { id: 'c2', tokens: ['n2'], value: 'dog', metadata: { note: 'x' } },
          ],
          relationLayers: [
            {
              id: 'olRels',
              name: 'Relations',
              config: { other: { relations: true } },
              relations: [
                {
                  id: 'r1',
                  source: 'c1',
                  target: 'c2',
                  value: ':ARG0',
                  metadata: { prov: 'inferred' },
                },
              ],
            },
          ],
        },
      ],
    },
    // Nested in the layer after it, and listed first on purpose.
    {
      id: 'olParts',
      name: 'Parts',
      overlapMode: 'any',
      parentTokenLayer: 'olWords',
      config: { other: { parts: true } },
      tokens: [{ id: 'p1', begin: 0, end: 6, precedence: 1 }],
      spanLayers: [],
    },
    {
      id: 'olWords',
      name: 'Words',
      overlapMode: 'non-overlapping',
      parentTokenLayer: 'wl',
      config: { plaid: { role: 'other-word' }, other: { words: true } },
      tokens: [{ id: 'ow1', begin: 0, end: 6 }],
      spanLayers: [],
    },
  );
  return raw;
}

export const makeOtherAppProject = () => ({
  ...makeNativeProject(),
  config: {
    ...makeNativeProject().config,
    plaid: { review: { 'someone@example.com': true } },
    other: { setting: 'x', nested: { a: [1, 2] } },
  },
  textLayers: makeOtherAppRaw().textLayers,
});
