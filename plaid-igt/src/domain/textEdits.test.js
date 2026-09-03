import { describe, it, expect } from 'vitest';
import {
  applyInsertToTokens,
  applyDeleteToTokens,
  compensatePartition,
  applyTextEditsLocally,
} from './textEdits.js';

// These cases are the server's own (plaid.algos.text/apply-text-edit and
// compensate-partition-layers!), transcribed. If the server changes, they
// should fail here first.

const tok = (id, begin, end) => ({ id, begin, end });

describe('applyInsertToTokens', () => {
  const tokens = [tok('a', 0, 3), tok('b', 4, 7), tok('z', 4, 4), tok('c', 8, 12)];

  it('leaves tokens that close before the insert, grows one it lands inside, shifts the rest', () => {
    // "the cat rest" -> insert "XY" at 5 (inside "cat"). The zero-width token
    // at 4 closes before the insert point, so it stays where it is.
    expect(applyInsertToTokens(tokens, 5, 2)).toEqual([
      tok('a', 0, 3),
      tok('b', 4, 9),
      tok('z', 4, 4),
      tok('c', 10, 14),
    ]);
  });

  it('an insert at a token boundary goes before the token that starts there', () => {
    expect(applyInsertToTokens([tok('a', 0, 3), tok('b', 3, 6)], 3, 2)).toEqual([
      tok('a', 0, 3),
      tok('b', 5, 8),
    ]);
  });

  it('a zero-width token at the insert point stays pinned', () => {
    expect(applyInsertToTokens([tok('z', 3, 3)], 3, 2)).toEqual([tok('z', 3, 3)]);
  });
});

describe('applyDeleteToTokens', () => {
  it('deletes tokens inside the range, clips the ones that straddle an edge, shifts the ones after', () => {
    // body "aaa bbb ccc ddd", delete [2, 10): "aa" + "c ddd"
    const tokens = [tok('a', 0, 3), tok('b', 4, 7), tok('c', 8, 11), tok('d', 12, 15)];
    expect(applyDeleteToTokens(tokens, 2, 8)).toEqual({
      tokens: [tok('a', 0, 2), tok('c', 2, 3), tok('d', 4, 7)],
      deletedIds: ['b'],
    });
  });

  it('a range inside one token just shrinks it', () => {
    expect(applyDeleteToTokens([tok('a', 0, 10)], 3, 4)).toEqual({
      tokens: [tok('a', 0, 6)],
      deletedIds: [],
    });
  });

  it('a token covering exactly the range is deleted, one ending at its start is untouched', () => {
    expect(applyDeleteToTokens([tok('a', 0, 3), tok('b', 3, 6)], 3, 3)).toEqual({
      tokens: [tok('a', 0, 3)],
      deletedIds: ['b'],
    });
  });

  it('zero-width tokens: deleted only strictly inside the range, pinned at its edges', () => {
    const zs = [tok('p', 2, 2), tok('q', 4, 4), tok('r', 6, 6)];
    expect(applyDeleteToTokens(zs, 2, 4)).toEqual({
      tokens: [tok('p', 2, 2), tok('r', 2, 2)],
      deletedIds: ['q'],
    });
  });
});

describe('compensatePartition', () => {
  it('closes gaps, pins the first to 0 and the last to the end', () => {
    expect(compensatePartition([tok('s2', 6, 9), tok('s1', 1, 3)], 12)).toEqual([
      tok('s1', 0, 6),
      tok('s2', 6, 12),
    ]);
  });

  it('leaves an empty layer empty', () => {
    expect(compensatePartition([], 5)).toEqual([]);
  });
});

describe('applyTextEditsLocally', () => {
  const rawDoc = () => ({
    textLayers: [
      {
        text: { id: 't', body: 'the cat sat' },
        tokenLayers: [
          {
            id: 'sent',
            overlapMode: 'partitioning',
            tokens: [tok('s1', 0, 8), tok('s2', 8, 11)],
            spanLayers: [{ id: 'tr', spans: [{ id: 'tr1', tokens: ['s1'], value: 'le chat' }] }],
          },
          {
            id: 'word',
            overlapMode: 'non-overlapping',
            tokens: [tok('w1', 0, 3), tok('w2', 4, 7), tok('w3', 8, 11)],
            spanLayers: [{ id: 'pos', spans: [{ id: 'p2', tokens: ['w2'], value: 'N' }] }],
          },
          { id: 'align', overlapMode: 'non-overlapping', tokens: [tok('a1', 4, 7)] },
        ],
      },
    ],
  });

  it('an insert at the end stretches the last sentence over the new text and shifts nothing else', () => {
    const raw = rawDoc();
    const deleted = applyTextEditsLocally(raw, 't', [{ type: 'insert', index: 11, value: ' now' }]);
    expect(deleted).toEqual([]);
    const [sent, word] = raw.textLayers[0].tokenLayers;
    expect(raw.textLayers[0].text.body).toBe('the cat sat now');
    expect(sent.tokens).toEqual([tok('s1', 0, 8), tok('s2', 8, 15)]);
    expect(word.tokens).toEqual([tok('w1', 0, 3), tok('w2', 4, 7), tok('w3', 8, 11)]);
  });

  it('replacing a stretch deletes the tokens inside it, their spans and links, and shifts the rest', () => {
    const raw = rawDoc();
    const vocabs = {
      v: {
        vocabLinks: [
          { id: 'l2', tokens: ['w2'] },
          { id: 'l3', tokens: ['w3'] },
        ],
      },
    };
    // Replace "cat" [4,7) with "dogs": delete then insert, as editAlignment sends it.
    const deleted = applyTextEditsLocally(
      raw,
      't',
      [
        { type: 'delete', index: 4, value: 3 },
        { type: 'insert', index: 4, value: 'dogs' },
      ],
      vocabs,
    );
    expect(deleted.sort()).toEqual(['a1', 'w2']);
    const [sent, word, align] = raw.textLayers[0].tokenLayers;
    expect(raw.textLayers[0].text.body).toBe('the dogs sat');
    expect(sent.tokens).toEqual([tok('s1', 0, 9), tok('s2', 9, 12)]);
    expect(word.tokens).toEqual([tok('w1', 0, 3), tok('w3', 9, 12)]);
    expect(align.tokens).toEqual([]);
    expect(word.spanLayers[0].spans).toEqual([]);
    expect(sent.spanLayers[0].spans).toHaveLength(1);
    expect(vocabs.v.vocabLinks.map((l) => l.id)).toEqual(['l3']);
  });

  it('deleting a whole sentence leaves the partition to the survivors', () => {
    const raw = rawDoc();
    applyTextEditsLocally(raw, 't', [{ type: 'delete', index: 7, value: 4 }]); // " sat"
    const [sent, word] = raw.textLayers[0].tokenLayers;
    expect(raw.textLayers[0].text.body).toBe('the cat');
    expect(sent.tokens).toEqual([tok('s1', 0, 7)]);
    expect(word.tokens).toEqual([tok('w1', 0, 3), tok('w2', 4, 7)]);
  });

  it('counts in code points, so astral characters move tokens by one', () => {
    const raw = {
      textLayers: [
        {
          text: { id: 't', body: 'a b' },
          tokenLayers: [
            { id: 'w', overlapMode: 'any', tokens: [tok('w1', 0, 1), tok('w2', 2, 3)] },
          ],
        },
      ],
    };
    applyTextEditsLocally(raw, 't', [{ type: 'insert', index: 1, value: '😀' }]);
    expect(raw.textLayers[0].text.body).toBe('a😀 b');
    expect(raw.textLayers[0].tokenLayers[0].tokens).toEqual([tok('w1', 0, 1), tok('w2', 3, 4)]);
  });
});
