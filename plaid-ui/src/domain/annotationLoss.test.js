import { describe, it, expect } from 'vitest';
import {
  countDeleteLoss,
  countPartitionLoss,
  countSplitLoss,
  lossPhrase,
} from './annotationLoss.js';

// One text as a document read holds it: sentences, words under them, and two
// layers under the words (morphemes with glosses and a vocabulary link, and
// syntactic words with a lemma and relations on the lemmas), plus a
// translation on the sentence.
const make = () => {
  const sentences = {
    id: 'tl-sent',
    tokens: [
      { id: 'S1', begin: 0, end: 9, metadata: { note: 'x' } },
      { id: 'S2', begin: 10, end: 14 },
    ],
    spanLayers: [{ id: 'sl-tr', spans: [{ id: 'tr1', tokens: ['S1'], value: 'a translation' }] }],
  };
  const words = {
    id: 'tl-word',
    parentTokenLayer: 'tl-sent',
    tokens: [
      { id: 'w1', begin: 0, end: 5 },
      { id: 'w2', begin: 6, end: 9 },
      { id: 'w3', begin: 10, end: 14 },
    ],
    spanLayers: [{ id: 'sl-wg', spans: [{ id: 'wg1', tokens: ['w1'], value: 'G' }] }],
    vocabs: [{ id: 'v1', vocabLinks: [{ id: 'mwe', tokens: ['w1', 'w2'] }] }],
  };
  const morphs = {
    id: 'tl-morph',
    parentTokenLayer: 'tl-word',
    tokens: [
      { id: 'm1', begin: 0, end: 2 },
      { id: 'm2', begin: 2, end: 5 },
    ],
    spanLayers: [
      {
        id: 'sl-mg',
        spans: [
          { id: 'mg1', tokens: ['m1'], value: 'a' },
          { id: 'mg2', tokens: ['m2'], value: 'b' },
        ],
      },
    ],
    vocabs: [{ id: 'v2', vocabLinks: [{ id: 'k1', tokens: ['m1'] }] }],
  };
  const synWords = {
    id: 'tl-syn',
    parentTokenLayer: 'tl-word',
    tokens: [
      { id: 'sw1', begin: 0, end: 5 },
      { id: 'sw2', begin: 6, end: 9 },
      { id: 'sw3', begin: 10, end: 14 },
    ],
    spanLayers: [
      {
        id: 'sl-lemma',
        spans: [
          { id: 'L1', tokens: ['sw1'], value: 'l1' },
          { id: 'L2', tokens: ['sw2'], value: 'l2' },
          { id: 'L3', tokens: ['sw3'], value: 'l3' },
        ],
        relationLayers: [
          {
            id: 'rl-dep',
            constraints: { someapp: [{ type: 'same-ancestor', tokenLayer: 'tl-sent' }] },
            relations: [
              { id: 'r1', source: 'L2', target: 'L1', value: 'nsubj' },
              { id: 'r2', source: 'L2', target: 'L2', value: 'root' },
            ],
          },
          {
            id: 'rl-free',
            relations: [{ id: 'r3', source: 'L1', target: 'L2', value: 'coref' }],
          },
        ],
      },
    ],
  };
  return [sentences, words, morphs, synWords];
};

describe('countDeleteLoss', () => {
  it('counts everything nested under a word, on every layer', () => {
    const loss = countDeleteLoss(make(), ['w1']);
    // spans wg1, mg1, mg2, L1 / relations r1, r3 (on L1) / links mwe (cut), k1
    expect(loss).toMatchObject({ spans: 4, relations: 2, links: 2, annotations: 6 });
    expect(loss.byLayer.get('tl-word')).toBe(1);
    expect(loss.byLayer.get('tl-morph')).toBe(2);
    expect(loss.byLayer.get('tl-syn')).toBe(1);
    expect(loss.byLayer.get('rl-dep')).toBe(1);
    expect(loss.byLayer.get('v1')).toBe(1);
  });

  it('leaves out the layers the caller counts itself, cascade and all', () => {
    const loss = countDeleteLoss(make(), ['w1'], { skip: ['tl-syn'] });
    expect(loss).toMatchObject({ spans: 3, relations: 0, links: 2 });
    const noLemma = countDeleteLoss(make(), ['w1'], { skip: ['sl-lemma'] });
    expect(noLemma).toMatchObject({ spans: 3, relations: 0 });
    const noDep = countDeleteLoss(make(), ['w1'], { skip: ['rl-dep'] });
    expect(noDep).toMatchObject({ spans: 4, relations: 1 });
  });

  it('is zero for a word with nothing on it', () => {
    const loss = countDeleteLoss(make(), ['w3'], { skip: ['tl-syn'] });
    expect(loss).toMatchObject({ annotations: 0, links: 0 });
  });

  it('takes a sentence with all under it, its own content counted when asked', () => {
    const plain = countDeleteLoss(make(), ['S1']);
    expect(plain).toMatchObject({ spans: 6, relations: 3, links: 2, content: 0 });
    expect(plain.byLayer.get('tl-sent')).toBe(1);
    expect(plain.byLayer.get('tl-word')).toBe(2);
    const withContent = countDeleteLoss(make(), ['S1', 'S2'], { content: true });
    expect(withContent.content).toBe(1);
    expect(withContent.annotations).toBe(withContent.spans + withContent.relations + 1);
  });

  it('with `under`, keeps the given tokens and counts only what lies under them', () => {
    const loss = countDeleteLoss(make(), ['w1'], { under: true });
    // mg1, mg2, L1, r1, r3, k1. The word gloss and the word link stay.
    expect(loss).toMatchObject({ spans: 3, relations: 2, links: 1 });
    expect(loss.byLayer.has('tl-word')).toBe(false);
  });

  it('reads a fresher link list when given one', () => {
    const loss = countDeleteLoss(make(), ['w3'], { vocabLinks: [{ id: 'n', tokens: ['w3'] }] });
    expect(loss.links).toBe(1);
  });

  it('handles missing input', () => {
    expect(countDeleteLoss(null, ['x']).annotations).toBe(0);
    expect(countDeleteLoss(make(), []).annotations).toBe(0);
    expect(countDeleteLoss(make(), ['nope']).annotations).toBe(0);
  });
});

describe('countSplitLoss', () => {
  it('counts the relations of a same-ancestor layer the split leaves crossing', () => {
    const loss = countSplitLoss(make(), 'S1', 6);
    // r1 (L2 -> L1) crosses. r3 is on a layer with no such rule.
    expect(loss).toMatchObject({ relations: 1, annotations: 1 });
    expect(loss.byLayer.get('rl-dep')).toBe(1);
  });

  it('places an end where its span begins, as core does', () => {
    const layers = make();
    const syn = layers[3];
    // A span over all of S1 begins on the left: its relation to a word on the
    // right crosses, its relation to a word on the left does not.
    syn.spanLayers[0].spans.push({ id: 'Lall', tokens: ['sw1', 'sw2'], value: 'all' });
    syn.spanLayers[0].relationLayers[0].relations.push(
      { id: 'r4', source: 'Lall', target: 'L2', value: 'x' },
      { id: 'r5', source: 'L1', target: 'Lall', value: 'y' },
    );
    expect(countSplitLoss(layers, 'S1', 6).relations).toBe(2); // r1 and r4
  });

  it('is zero when no relation crosses, or the position is not inside', () => {
    expect(countSplitLoss(make(), 'S2', 12).annotations).toBe(0);
    expect(countSplitLoss(make(), 'S1', 0).annotations).toBe(0);
    expect(countSplitLoss(make(), 'S1', 6, { skip: ['rl-dep'] }).annotations).toBe(0);
  });
});

// Tokenize makes sentences anew: over a text whose sentences were cleared, or
// one sentence a service resplits.
describe('countPartitionLoss', () => {
  const cleared = () => {
    const layers = make();
    layers[0].tokens = [];
    return layers;
  };

  it('counts the relations the planned sentences put in two of them', () => {
    // r1 runs from "w2" (6) to "w1" (0), r3 the other way on a layer with no
    // rule. A break at 6 cuts r1, one at 10 cuts nothing.
    expect(
      countPartitionLoss(cleared(), 'tl-sent', [
        [0, 6],
        [6, 14],
      ]).relations,
    ).toBe(1);
    expect(
      countPartitionLoss(cleared(), 'tl-sent', [
        [0, 10],
        [10, 14],
      ]).relations,
    ).toBe(0);
    // An end in no planned sentence crosses nothing.
    expect(countPartitionLoss(cleared(), 'tl-sent', [[0, 5]]).relations).toBe(0);
  });

  it('leaves out what crosses already, and the layers the caller counts', () => {
    // Today's S1 holds r1. A partition that keeps it whole takes nothing.
    expect(
      countPartitionLoss(make(), 'tl-sent', [
        [0, 9],
        [9, 14],
      ]).relations,
    ).toBe(0);
    expect(
      countPartitionLoss(
        cleared(),
        'tl-sent',
        [
          [0, 6],
          [6, 14],
        ],
        { skip: ['tl-syn'] },
      ).relations,
    ).toBe(0);
  });

  it("with 'any', counts every relation whose ends lie apart", () => {
    // r1 only: r2 is a loop, r3 has no rule.
    expect(countPartitionLoss(cleared(), 'tl-sent', 'any').relations).toBe(1);
    expect(countPartitionLoss(make(), 'tl-sent', 'any').relations).toBe(1);
  });

  it('leaves out a relation the same run deletes with its tokens', () => {
    expect(countPartitionLoss(make(), 'tl-sent', 'any', { deleting: ['S1'] }).relations).toBe(0);
  });
});

describe('lossPhrase', () => {
  it('names the counts', () => {
    expect(lossPhrase({ annotations: 1, links: 0 })).toBe('1 annotation');
    expect(lossPhrase({ annotations: 3, links: 2 })).toBe('3 annotations and 2 vocabulary links');
    expect(lossPhrase({ annotations: 0, links: 1 })).toBe('1 vocabulary link');
    expect(lossPhrase({})).toBe('');
  });
});
