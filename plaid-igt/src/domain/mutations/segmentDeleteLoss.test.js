import { describe, it, expect } from 'vitest';
import { alignmentMutations } from './alignment.js';

// REV-N5-APPS R1: a segment's trash with its text is a TEXT delete. It takes
// every token within the stretch it removes, on every layer, nested or not,
// and the whitespace it swallows can complete a sentence, which goes too.
//
//   aa\nbb cc\ndd    sentences [0,3) [3,9) [9,11), the segment over "bb cc"
//
// The delete removes [3,9): "bb cc" and the newline after it.
const fake = ({ nodes = true, translation = true } = {}) => {
  const sentences = {
    id: 'tl-sent',
    tokens: [
      { id: 'S1', begin: 0, end: 3 },
      { id: 'S2', begin: 3, end: 9 },
      { id: 'S3', begin: 9, end: 11 },
    ],
    spanLayers: [
      {
        id: 'sl-tr',
        spans: translation ? [{ id: 'tr2', tokens: ['S2'], value: 'a translation' }] : [],
      },
    ],
  };
  const words = {
    id: 'tl-word',
    parentTokenLayer: 'tl-sent',
    tokens: [
      { id: 'w1', begin: 3, end: 5 },
      { id: 'w2', begin: 6, end: 8 },
    ],
    spanLayers: [],
  };
  const segments = {
    id: 'tl-time',
    tokens: [{ id: 'seg', begin: 3, end: 8, metadata: { timeBegin: 0, timeEnd: 1 } }],
    spanLayers: [],
  };
  // A layer of its own, nested under nothing: nodes over the words, with a
  // span each and a relation between them.
  const graph = {
    id: 'tl-node',
    tokens: nodes
      ? [
          { id: 'n1', begin: 3, end: 5 },
          { id: 'n2', begin: 6, end: 8 },
        ]
      : [],
    spanLayers: [
      {
        id: 'sl-c',
        spans: nodes
          ? [
              { id: 'c1', tokens: ['n1'], value: 'bb' },
              { id: 'c2', tokens: ['n2'], value: 'cc' },
            ]
          : [],
        relationLayers: [
          { id: 'rl-e', relations: nodes ? [{ id: 'e1', source: 'c1', target: 'c2' }] : [] },
        ],
      },
    ],
  };
  return {
    body: 'aa\nbb cc\ndd',
    vocabularies: {},
    layerInfo: {
      primaryTextLayer: { tokenLayers: [sentences, words, segments, graph] },
      alignmentTokenLayer: segments,
    },
  };
};

const loss = (doc) => alignmentMutations.segmentDeleteLoss.call(doc, 'seg');

describe("a segment's trash with its text", () => {
  it('counts the sentence the swallowed newline completes, and another layer under nothing', () => {
    // The translation, two node spans and the relation. The segment itself is
    // what was asked to go.
    expect(loss(fake())).toMatchObject({ annotations: 4, links: 0 });
  });

  it('asks when only the other layer has work there', () => {
    expect(loss(fake({ translation: false }))).toMatchObject({ annotations: 3 });
  });

  it('is zero over bare words', () => {
    expect(loss(fake({ nodes: false, translation: false }))).toMatchObject({
      annotations: 0,
      links: 0,
    });
  });
});
