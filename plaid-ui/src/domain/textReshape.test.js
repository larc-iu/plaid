import { describe, expect, it } from 'vitest';
import { applyReshape } from './textReshape.js';

// A document read as plaid-client returns it: one text layer with its text,
// a word and a morpheme token layer, a span layer with a relation layer under
// the words, and a vocabulary linked to them.
const read = () => ({
  id: 'doc',
  name: 'Doc',
  textLayers: [
    {
      id: 'tl',
      name: 'Text',
      text: { id: 'text', document: 'doc', body: 'the big dog ran', digest: 'd0' },
      tokenLayers: [
        {
          id: 'words',
          tokens: [
            { id: 'w1', begin: 0, end: 3, precedence: null },
            { id: 'w2', begin: 4, end: 7, precedence: null },
            { id: 'w3', begin: 8, end: 11, precedence: null },
            { id: 'w4', begin: 12, end: 15, precedence: null },
          ],
          spanLayers: [
            {
              id: 'pos',
              spans: [
                { id: 's1', value: 'DET', tokens: ['w1'] },
                { id: 's2', value: 'ADJ', tokens: ['w2'] },
                { id: 's3', value: 'NP', tokens: ['w2', 'w3'] },
              ],
              relationLayers: [
                {
                  id: 'deps',
                  relations: [
                    { id: 'r1', source: 's2', target: 's3', value: 'amod' },
                    { id: 'r2', source: 's1', target: 's3', value: 'det' },
                  ],
                },
              ],
            },
          ],
          vocabs: [
            {
              id: 'lex',
              name: 'Lexicon',
              vocabLinks: [
                { id: 'l1', vocabItem: { id: 'i1', form: 'big' }, tokens: ['w2', 'w3'] },
                { id: 'l2', vocabItem: { id: 'i2', form: 'ran' }, tokens: ['w4'] },
              ],
            },
          ],
        },
        {
          id: 'morphs',
          tokens: [{ id: 'm1', begin: 12, end: 15, precedence: 1 }],
          spanLayers: [],
          vocabs: [],
        },
      ],
    },
    {
      id: 'tl2',
      name: 'Other',
      text: { id: 'text2', document: 'doc', body: 'other', digest: 'x' },
      tokenLayers: [],
    },
  ],
});

// `big ` deleted: w2 goes with its span, that span's relation and nothing
// else, s3 and l1 keep w3 only, and w3 and w4 move back four.
const answer = {
  id: 'text',
  body: 'the dog ran',
  document: 'doc',
  layer: 'tl',
  metadata: {},
  digest: 'd1',
  reshape: {
    tokens: [
      { id: 'w3', begin: 4, end: 7 },
      { id: 'w4', begin: 8, end: 11 },
      { id: 'm1', begin: 8, end: 11 },
    ],
    spans: [{ id: 's3', tokens: ['w3'] }],
    vocabLinks: [{ id: 'l1', tokens: ['w3'] }],
    deleted: { tokens: ['w2'], spans: ['s2'], relations: ['r1'], vocabLinks: [] },
  },
};

describe('applyReshape', () => {
  it('gives the read the next read would give', () => {
    const before = read();
    const after = applyReshape(before, 'text', answer);

    const next = read();
    const text = next.textLayers[0];
    text.text.body = 'the dog ran';
    text.text.digest = 'd1';
    const words = text.tokenLayers[0];
    words.tokens = [
      { id: 'w1', begin: 0, end: 3, precedence: null },
      { id: 'w3', begin: 4, end: 7, precedence: null },
      { id: 'w4', begin: 8, end: 11, precedence: null },
    ];
    words.spanLayers[0].spans = [
      { id: 's1', value: 'DET', tokens: ['w1'] },
      { id: 's3', value: 'NP', tokens: ['w3'] },
    ];
    words.spanLayers[0].relationLayers[0].relations = [
      { id: 'r2', source: 's1', target: 's3', value: 'det' },
    ];
    words.vocabs[0].vocabLinks[0].tokens = ['w3'];
    text.tokenLayers[1].tokens[0] = { id: 'm1', begin: 8, end: 11, precedence: 1 };

    expect(after).toEqual(next);
    // the read it was given is unchanged
    expect(before).toEqual(read());
  });

  it('shares every part the answer does not touch', () => {
    const before = read();
    const after = applyReshape(before, 'text', answer);
    expect(after.textLayers[1]).toBe(before.textLayers[1]);
    expect(after.textLayers[0].tokenLayers[0].tokens[0]).toBe(
      before.textLayers[0].tokenLayers[0].tokens[0],
    );
    expect(after.textLayers[0].tokenLayers[0].vocabs[0].vocabLinks[1]).toBe(
      before.textLayers[0].tokenLayers[0].vocabs[0].vocabLinks[1],
    );
  });

  it('puts moved tokens in the core’s order: begin, precedence with none last, end, id', () => {
    const before = read();
    before.textLayers[0].tokenLayers[1].tokens = [
      { id: 'a', begin: 0, end: 2, precedence: null },
      { id: 'b', begin: 3, end: 5, precedence: 2 },
      { id: 'c', begin: 6, end: 8, precedence: 1 },
    ];
    const after = applyReshape(before, 'text', {
      body: 'x',
      digest: 'd9',
      reshape: {
        tokens: [
          { id: 'a', begin: 3, end: 5 },
          { id: 'c', begin: 3, end: 4 },
        ],
        spans: [],
        vocabLinks: [],
        deleted: { tokens: [], spans: [], relations: [], vocabLinks: [] },
      },
    });
    expect(after.textLayers[0].tokenLayers[1].tokens.map((t) => t.id)).toEqual(['c', 'b', 'a']);
  });

  it('sets the body and digest when the edit wrote no other row', () => {
    const before = read();
    const after = applyReshape(before, 'text', {
      body: 'the big dog ran!',
      digest: 'd2',
      reshape: {
        tokens: [],
        spans: [],
        vocabLinks: [],
        deleted: { tokens: [], spans: [], relations: [], vocabLinks: [] },
      },
    });
    expect(after.textLayers[0].text).toEqual({
      id: 'text',
      document: 'doc',
      body: 'the big dog ran!',
      digest: 'd2',
    });
    expect(after.textLayers[0].tokenLayers).toBe(before.textLayers[0].tokenLayers);
  });

  it('sets a span’s value when the answer gives one, as a layer rule’s remedy does', () => {
    const before = read();
    const after = applyReshape(before, 'text', {
      body: 'the big dog ran',
      digest: 'd3',
      reshape: {
        tokens: [],
        spans: [
          { id: 's2', tokens: ['w2'], value: 'NOUN' },
          { id: 's3', tokens: ['w3'], value: 'NP2' },
        ],
        vocabLinks: [],
        deleted: { tokens: [], spans: [], relations: [], vocabLinks: [] },
      },
    });
    const spans = after.textLayers[0].tokenLayers[0].spanLayers[0].spans;
    expect(spans).toEqual([
      { id: 's1', value: 'DET', tokens: ['w1'] },
      { id: 's2', value: 'NOUN', tokens: ['w2'] },
      { id: 's3', value: 'NP2', tokens: ['w3'] },
    ]);
    expect(spans[0]).toBe(before.textLayers[0].tokenLayers[0].spanLayers[0].spans[0]);
  });
});

describe('applyReshape with a span entry that holds only a value', () => {
  it('sets the value and keeps the token list', async () => {
    const { applyReshape: apply } = await import('./textReshape.js');
    const raw = {
      textLayers: [
        {
          text: { id: 't1', body: 'ab', digest: 'd0' },
          tokenLayers: [
            {
              id: 'tl',
              tokens: [{ id: 'k1', begin: 0, end: 2 }],
              spanLayers: [{ id: 'sl', spans: [{ id: 's1', tokens: ['k1'], value: 'OLD' }] }],
            },
          ],
        },
      ],
    };
    const next = apply(raw, 't1', {
      body: 'ab',
      digest: 'd0',
      reshape: { spans: [{ id: 's1', value: 'NEW' }], deleted: {} },
    });
    expect(next.textLayers[0].tokenLayers[0].spanLayers[0].spans[0]).toEqual({
      id: 's1',
      tokens: ['k1'],
      value: 'NEW',
    });
  });
});
