import { describe, it, expect } from 'vitest';
import {
  countAnnotationLossForWord,
  countReTokenizeCut,
  countReTokenizeLoss,
  countSplitWordLoss,
  countSubWordAnnotationLoss,
} from './annotationLoss.js';

// A shared IGT+UD-shaped layerInfo: the word carries an IGT gloss, its IGT
// morpheme a gloss, and UD's syntactic-word layer (nested under words too)
// carries a UPOS span, a Lemma span, and a dependency relation on that Lemma —
// all of which the word-delete cascade destroys.
const make = () => {
  const word = { id: 'w1', begin: 0, end: 5 };
  const wordLayer = {
    id: 'tl-word',
    tokens: [word, { id: 'w2', begin: 6, end: 9 }],
    spanLayers: [{ id: 'sl-wgloss', spans: [{ id: 's1', tokens: ['w1'], value: 'word-gloss' }] }],
  };
  const igtMorphLayer = {
    id: 'tl-igt-morph',
    parentTokenLayer: 'tl-word',
    tokens: [{ id: 'm1', begin: 0, end: 5 }],
    spanLayers: [{ id: 'sl-mgloss', spans: [{ id: 's2', tokens: ['m1'], value: 'morph-gloss' }] }],
  };
  const udSynLayer = {
    id: 'tl-ud-syn',
    parentTokenLayer: 'tl-word',
    tokens: [
      { id: 'sw1', begin: 0, end: 5 },
      { id: 'sw2', begin: 6, end: 9 },
    ],
    spanLayers: [
      { id: 'sl-upos', spans: [{ id: 's3', tokens: ['sw1'], value: 'NOUN' }] },
      {
        id: 'sl-lemma',
        spans: [
          { id: 's4', tokens: ['sw1'], value: 'lemma1' },
          { id: 's5', tokens: ['sw2'], value: 'lemma2' },
        ],
        relationLayers: [
          {
            id: 'rl-dep',
            relations: [
              { id: 'r1', source: 's5', target: 's4', value: 'det' }, // dies (target dies)
              { id: 'r2', source: 's5', target: 's5', value: 'root' }, // survives
            ],
          },
        ],
      },
    ],
  };
  const layerInfo = {
    primaryTextLayer: { tokenLayers: [wordLayer, igtMorphLayer, udSynLayer] },
    primaryTokenLayer: wordLayer,
  };
  const vocabularies = {
    v1: {
      id: 'v1',
      vocabLinks: [
        { id: 'l1', tokens: ['m1'] }, // dies with the IGT morpheme
        { id: 'l2', tokens: ['w2'] }, // other word — survives
      ],
    },
  };
  return { layerInfo, vocabularies, word };
};

describe('countAnnotationLossForWord', () => {
  it('counts spans, relations, and links across ALL apps layers', () => {
    const { layerInfo, vocabularies, word } = make();
    // dying: w1, m1, sw1 -> spans s1, s2, s3, s4 + relation r1; link l1
    expect(countAnnotationLossForWord(layerInfo, vocabularies, word)).toMatchObject({
      annotations: 5,
      links: 1,
    });
  });

  it('reports zero for an unannotated token (instant delete path)', () => {
    const { layerInfo, vocabularies } = make();
    const bare = { id: 'w3', begin: 10, end: 12 };
    layerInfo.primaryTokenLayer.tokens.push(bare);
    expect(countAnnotationLossForWord(layerInfo, vocabularies, bare)).toMatchObject({
      annotations: 0,
      links: 0,
    });
  });

  it('handles missing inputs gracefully', () => {
    expect(countAnnotationLossForWord(null, {}, { id: 'x', begin: 0, end: 1 })).toMatchObject({
      annotations: 0,
      links: 0,
    });
    expect(
      countAnnotationLossForWord({ primaryTokenLayer: { id: 't', tokens: [] } }, null, null),
    ).toMatchObject({ annotations: 0, links: 0 });
  });
});

describe('countSplitWordLoss', () => {
  // A split deletes the word's morphemes, and the server splits another app's
  // token nested under the word instead of deleting it. Counting everything
  // under the word, as for a merge, asked about a UD lemma, UPOS and
  // dependency the split kept (D7-FAKES, on a real core).
  it("counts the morphemes' analysis and not another app's nested tokens", () => {
    const { layerInfo, vocabularies, word } = make();
    layerInfo.morphemeTokenLayer = layerInfo.primaryTextLayer.tokenLayers[1];
    expect(countSplitWordLoss(layerInfo, vocabularies, word)).toMatchObject({
      annotations: 1,
      links: 1,
    });
    // A merge takes the nested tokens too: s2 and l1, and sw1's s3, s4 and r1.
    expect(countSubWordAnnotationLoss(layerInfo, vocabularies, [word])).toMatchObject({
      annotations: 4,
      links: 1,
    });
  });

  it('is zero for a word with no morphemes, whatever else is under it', () => {
    const { layerInfo, vocabularies } = make();
    layerInfo.morphemeTokenLayer = layerInfo.primaryTextLayer.tokenLayers[1];
    const w2 = layerInfo.primaryTokenLayer.tokens[1];
    expect(countSplitWordLoss(layerInfo, vocabularies, w2)).toMatchObject({
      annotations: 0,
      links: 0,
    });
  });
});

// A tokenizer service resets a one-sentence document's sentence partition,
// and the server takes every token nested under the sentence with it. The
// confirm asks first whenever that loses anything.
describe('countReTokenizeLoss', () => {
  const oneSentence = ({ word = {}, morph = {}, extra = [] } = {}) => {
    const sentenceLayer = { id: 'tl-sent', tokens: [{ id: 'sent1', begin: 0, end: 9 }] };
    const wordLayer = {
      id: 'tl-word',
      parentTokenLayer: 'tl-sent',
      tokens: [
        { id: 'w1', begin: 0, end: 5, metadata: word },
        { id: 'w2', begin: 6, end: 9 },
      ],
      spanLayers: [],
    };
    const morphLayer = {
      id: 'tl-morph',
      parentTokenLayer: 'tl-word',
      tokens: [{ id: 'm1', begin: 0, end: 5, metadata: morph }],
      spanLayers: [],
    };
    return {
      primaryTextLayer: { tokenLayers: [sentenceLayer, wordLayer, morphLayer, ...extra] },
      sentenceTokenLayer: sentenceLayer,
      primaryTokenLayer: wordLayer,
      morphemeTokenLayer: morphLayer,
      spanLayers: {},
    };
  };

  it('is zero for words nobody has annotated', () => {
    expect(countReTokenizeLoss(oneSentence(), {})).toMatchObject({ annotations: 0, links: 0 });
  });

  it('counts a segmentation with no gloss on it', () => {
    const info = oneSentence({ morph: { form: 'Mimm', morphType: 'stem' } });
    expect(countReTokenizeLoss(info, {})).toMatchObject({ annotations: 1, links: 0 });
  });

  it('counts an orthography line on a word', () => {
    const info = oneSentence({ word: { 'orthog:Translit': 'Mimme' } });
    expect(countReTokenizeLoss(info, {})).toMatchObject({ annotations: 1, links: 0 });
  });

  it('does not count provenance alone', () => {
    const info = oneSentence({ word: { prov: 'inferred', provSource: 'service:x' } });
    expect(countReTokenizeLoss(info, {})).toMatchObject({ annotations: 0, links: 0 });
  });

  it("counts another app's layers nested under the words", () => {
    const ud = {
      id: 'tl-ud',
      parentTokenLayer: 'tl-word',
      tokens: [{ id: 'sw1', begin: 0, end: 5 }],
      spanLayers: [
        {
          id: 'sl-lemma',
          spans: [{ id: 'l1', tokens: ['sw1'], value: 'x' }],
          relationLayers: [{ id: 'rl', relations: [{ id: 'r1', source: 'l1', target: 'l1' }] }],
        },
      ],
    };
    const info = oneSentence({ extra: [ud] });
    const vocabularies = { v: { vocabLinks: [{ id: 'k', tokens: ['m1'] }] } };
    expect(countReTokenizeLoss(info, vocabularies)).toMatchObject({ annotations: 2, links: 1 });
  });

  // REV-SVC-2: a person's merge or split of a machine tokenizer's token leaves
  // provenance keys only, verified or contributed.
  it('counts a stamped token a person verified or contributed', () => {
    const machine = { prov: 'inferred', provSource: 'service:whisper' };
    const verified = oneSentence({ word: { ...machine, provConfirmed: true } });
    expect(countReTokenizeLoss(verified, {})).toMatchObject({ annotations: 1, links: 0 });
    const contributed = oneSentence({ word: { prov: 'contributed', provSource: 'user:b@x.com' } });
    expect(countReTokenizeLoss(contributed, {})).toMatchObject({ annotations: 1, links: 0 });
    const merged = oneSentence();
    merged.sentenceTokenLayer.tokens[0].metadata = { ...machine, provConfirmed: true };
    expect(countReTokenizeLoss(merged, {})).toMatchObject({ annotations: 1, links: 0 });
  });

  it('is zero when the document has more than one sentence', () => {
    const info = oneSentence({ morph: { form: 'Mimm' } });
    info.sentenceTokenLayer.tokens.push({ id: 'sent2', begin: 9, end: 9 });
    expect(countReTokenizeLoss(info, {})).toMatchObject({ annotations: 0, links: 0 });
  });
});

// REV-N5-CORE F3: a service resplitting the one sentence can cut relations a
// layer keeps inside one sentence, on a layer the reset does not take.
describe('countReTokenizeCut', () => {
  const doc = (sentences) => {
    const sentenceLayer = { id: 'tl-sent', tokens: sentences };
    const words = {
      id: 'tl-word',
      parentTokenLayer: 'tl-sent',
      tokens: [
        { id: 'w1', begin: 0, end: 4 },
        { id: 'w2', begin: 5, end: 9 },
      ],
      spanLayers: [
        {
          id: 'sl-w',
          spans: [
            { id: 'a', tokens: ['w1'] },
            { id: 'b', tokens: ['w2'] },
          ],
          relationLayers: [
            {
              id: 'rl-w',
              constraints: { x: [{ type: 'same-ancestor', tokenLayer: 'tl-sent' }] },
              relations: [{ id: 'rw', source: 'a', target: 'b' }],
            },
          ],
        },
      ],
    };
    const nodes = {
      id: 'tl-nodes',
      tokens: [
        { id: 'n1', begin: 0, end: 4 },
        { id: 'n2', begin: 5, end: 9 },
      ],
      spanLayers: [
        {
          id: 'sl-n',
          spans: [
            { id: 'c', tokens: ['n1'] },
            { id: 'd', tokens: ['n2'] },
          ],
          relationLayers: [
            {
              id: 'rl-n',
              constraints: { y: [{ type: 'same-ancestor', tokenLayer: 'tl-sent' }] },
              relations: [{ id: 'rn', source: 'c', target: 'd' }],
            },
          ],
        },
      ],
    };
    return {
      primaryTextLayer: { tokenLayers: [sentenceLayer, words, nodes] },
      sentenceTokenLayer: sentenceLayer,
      primaryTokenLayer: words,
    };
  };

  it('counts what the new breaks can cut, leaving what the reset deletes to the loss count', () => {
    // rw goes with the words the reset deletes. rn stays and can be cut.
    expect(countReTokenizeCut(doc([{ id: 'S', begin: 0, end: 9 }]))).toMatchObject({
      annotations: 1,
      links: 0,
    });
  });

  it('is zero when the run does not resplit', () => {
    const two = doc([
      { id: 'S1', begin: 0, end: 5 },
      { id: 'S2', begin: 5, end: 9 },
    ]);
    expect(countReTokenizeCut(two)).toMatchObject({ annotations: 0, links: 0 });
  });

  // REV-D7-FAKES R2: a text with no sentences, and so no words, is given
  // them by the service, and the breaks can cut the edge between two nodes.
  it('counts what the breaks can cut when the text has no sentences', () => {
    const none = doc([]);
    none.primaryTokenLayer.tokens = [];
    expect(countReTokenizeCut(none)).toMatchObject({ annotations: 1, links: 0 });
  });
});
