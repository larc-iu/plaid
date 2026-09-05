import { describe, it, expect } from 'vitest';
import {
  indexDocument,
  planText,
  planPartition,
  planLayer,
  planSpans,
  planLinks,
  planMetadata,
  mapPartitionIds,
  normalizeState,
  compareStates,
  summarizeRestore,
} from './restorePlan.js';

// A raw document with the four IGT layers and one span layer on each of the
// first three. Tokens are [id, begin, end, precedence?, metadata?].
const role = (r) => ({ plaid: { role: r } });
function raw({
  body = 'perros corren rapido',
  sentences = [['s1', 0, 20]],
  words = [
    ['w1', 0, 6],
    ['w2', 7, 13],
    ['w3', 14, 20],
  ],
  morphemes = [],
  alignment = [],
  spans = [], // [id, layer name, tokens, value, metadata?]
  links = [], // [id, itemId, tokens, metadata?]
  metadata,
  textMetadata,
  text = true,
} = {}) {
  const tok = (role) => (rows) =>
    rows.map(([id, begin, end, precedence = null, metadata]) => ({
      id,
      begin,
      end,
      precedence,
      ...(metadata ? { metadata } : {}),
      role,
    }));
  const spanLayer = (id, name) => ({
    id,
    name,
    config: {},
    spans: spans
      .filter((s) => s[1] === name)
      .map(([sid, , tokens, value, meta]) => ({
        id: sid,
        tokens,
        value,
        ...(meta ? { metadata: meta } : {}),
      })),
  });
  return {
    id: 'doc1',
    name: 'Doc',
    version: 1,
    ...(metadata ? { metadata } : {}),
    textLayers: [
      {
        id: 'tl',
        config: role('baseline'),
        text: text
          ? { id: 'text1', body, ...(textMetadata ? { metadata: textMetadata } : {}) }
          : null,
        tokenLayers: [
          {
            id: 'L-s',
            config: role('sentence'),
            overlapMode: 'partitioning',
            parentTokenLayer: null,
            tokens: tok('sentence')(sentences),
            spanLayers: [spanLayer('SL-tr', 'Translation')],
          },
          {
            id: 'L-w',
            config: role('word'),
            overlapMode: 'non-overlapping',
            parentTokenLayer: 'L-s',
            tokens: tok('word')(words),
            spanLayers: [spanLayer('SL-pos', 'POS')],
            vocabs: [
              {
                id: 'v1',
                name: 'Lex',
                vocabLinks: links.map(([id, itemId, tokens, meta]) => ({
                  id,
                  vocabItem: { id: itemId, layer: 'v1', form: itemId },
                  tokens,
                  ...(meta ? { metadata: meta } : {}),
                })),
              },
            ],
          },
          {
            id: 'L-m',
            config: role('morpheme'),
            overlapMode: 'any',
            parentTokenLayer: 'L-w',
            tokens: tok('morpheme')(morphemes),
            spanLayers: [spanLayer('SL-gl', 'Gloss')],
          },
          {
            id: 'L-a',
            config: role('time-alignment'),
            overlapMode: 'non-overlapping',
            parentTokenLayer: null,
            tokens: tok('alignment')(alignment),
            spanLayers: [],
          },
        ],
      },
    ],
  };
}
const idx = (over) => indexDocument(raw(over));

describe('indexDocument', () => {
  it('keys the IGT layers, tokens, spans and links by id', () => {
    const d = idx({
      spans: [['sp1', 'POS', ['w1'], 'NOUN', { prov: 'inferred' }]],
      links: [['l1', 'item1', ['w1']]],
      metadata: { a: 1 },
    });
    expect(d.text).toEqual({ id: 'text1', body: 'perros corren rapido', metadata: {} });
    expect(d.layers.sentence.overlapMode).toBe('partitioning');
    expect(d.layers.word.parentTokenLayer).toBe('L-s');
    expect(d.tokens.get('w2')).toMatchObject({ role: 'word', begin: 7, end: 13, precedence: null });
    expect(d.spans.get('sp1')).toMatchObject({
      layerId: 'SL-pos',
      layerName: 'POS',
      tokens: ['w1'],
      value: 'NOUN',
      metadata: { prov: 'inferred' },
    });
    expect(d.links.get('l1')).toMatchObject({ vocabId: 'v1', itemId: 'item1', tokens: ['w1'] });
    expect(d.metadata).toEqual({ a: 1 });
  });

  it('treats a missing metadata key as empty, and a missing text as null', () => {
    const d = idx({ text: false });
    expect(d.text).toBeNull();
    expect(d.metadata).toEqual({});
    expect(d.tokens.get('w1').metadata).toEqual({});
  });
});

describe('planText', () => {
  it('is null when the bodies agree', () => {
    expect(planText(idx(), idx())).toBeNull();
  });
  it('updates a changed body through the text id that exists now', () => {
    expect(planText(idx(), idx({ body: 'perros corren' }))).toEqual({
      kind: 'update',
      textId: 'text1',
      body: 'perros corren',
    });
  });
  it('creates the text when there is none now, and deletes it when there was none then', () => {
    expect(planText(idx({ text: false }), idx({ textMetadata: { lang: 'es' } }))).toEqual({
      kind: 'create',
      textLayerId: 'tl',
      body: 'perros corren rapido',
      metadata: { lang: 'es' },
    });
    expect(planText(idx(), idx({ text: false }))).toEqual({ kind: 'delete', textId: 'text1' });
  });
});

describe('planPartition', () => {
  const part = (cur, tgt) => planPartition(idx({ sentences: cur }), idx({ sentences: tgt }));

  it('emits nothing when the tilings agree', () => {
    expect(
      part(
        [
          ['s1', 0, 10],
          ['s2', 10, 20],
        ],
        [
          ['s1', 0, 10],
          ['s2', 10, 20],
        ],
      ).ops,
    ).toEqual([]);
  });

  it('shifts a boundary that moved, so both neighbors keep their ids', () => {
    const { ops } = part(
      [
        ['s1', 0, 10],
        ['s2', 10, 20],
      ],
      [
        ['s1', 0, 12],
        ['s2', 12, 20],
      ],
    );
    expect(ops).toEqual([{ op: 'shift', id: 's1', end: 12 }]);
    const back = part(
      [
        ['s1', 0, 12],
        ['s2', 12, 20],
      ],
      [
        ['s1', 0, 10],
        ['s2', 10, 20],
      ],
    );
    expect(back.ops).toEqual([{ op: 'shift', id: 's2', begin: 10 }]);
  });

  it('merges away a boundary that is gone (the left token survives)', () => {
    const { ops } = part(
      [
        ['s1', 0, 10],
        ['s2', 10, 20],
      ],
      [['s1', 0, 20]],
    );
    expect(ops).toEqual([{ op: 'merge', left: 's1', right: 's2' }]);
  });

  it('splits in a boundary that is new, minting an id the runner resolves', () => {
    const { ops } = part(
      [['s1', 0, 20]],
      [
        ['s1', 0, 8],
        ['s2', 8, 20],
      ],
    );
    expect(ops).toEqual([{ op: 'split', id: 's1', position: 8, ref: 'split0' }]);
  });

  it('shifts, then merges, then splits, naming tokens as they stand at each step', () => {
    // cur: [0,10)[10,20)[20,30)   tgt: [0,12)[12,25)[25,30)
    // boundaries: cur {10,20}, tgt {12,25}. 10->12 is a move (adjacent);
    // 20 and 25 have nothing between them either, so that is a move too.
    const { ops } = part(
      [
        ['s1', 0, 10],
        ['s2', 10, 20],
        ['s3', 20, 30],
      ],
      [
        ['s1', 0, 12],
        ['s2', 12, 25],
        ['s3', 25, 30],
      ],
    );
    expect(ops).toEqual([
      { op: 'shift', id: 's1', end: 12 },
      { op: 'shift', id: 's2', end: 25 },
    ]);
    // cur: [0,10)[10,20)[20,30)   tgt: [0,20)[20,24)[24,30): 10 is gone,
    // 20 stays, 24 is new (inside s3).
    const two = part(
      [
        ['s1', 0, 10],
        ['s2', 10, 20],
        ['s3', 20, 30],
      ],
      [
        ['s1', 0, 20],
        ['s3', 20, 24],
        ['s4', 24, 30],
      ],
    );
    expect(two.ops).toEqual([
      { op: 'merge', left: 's1', right: 's2' },
      { op: 'split', id: 's3', position: 24, ref: 'split0' },
    ]);
  });

  it('a second split inside a freshly split piece names it by ref', () => {
    const { ops } = part(
      [['s1', 0, 30]],
      [
        ['a', 0, 10],
        ['b', 10, 20],
        ['c', 20, 30],
      ],
    );
    expect(ops).toEqual([
      { op: 'split', id: 's1', position: 10, ref: 'split0' },
      { op: 'split', id: { ref: 'split0' }, position: 20, ref: 'split1' },
    ]);
  });

  it('builds an empty layer in one bulk call, and empties one the same way', () => {
    const built = part([], [['s1', 0, 20]]);
    expect(built.bulkCreate).toEqual([
      { tid: 's1', begin: 0, end: 20, precedence: null, metadata: {} },
    ]);
    const emptied = part([['s1', 0, 20]], []);
    expect(emptied.bulkDelete).toEqual(['s1']);
  });
});

describe('planLayer', () => {
  it('deletes what was born, creates what is gone, patches what moved', () => {
    const cur = idx({
      words: [
        ['w1', 0, 6],
        ['w2', 7, 13],
        ['w9', 14, 19],
      ],
    });
    const tgt = idx({
      words: [
        ['w1', 0, 6],
        ['w2', 7, 12],
        ['w3', 14, 20, null, { 'orthog:T': 'x' }],
      ],
    });
    const p = planLayer(cur, tgt, 'word');
    expect(p.deletes).toEqual(['w9']);
    expect(p.patches).toEqual([{ id: 'w2', begin: undefined, end: 12, precedence: undefined }]);
    expect(p.creates).toEqual([
      { tid: 'w3', begin: 14, end: 20, precedence: null, metadata: { 'orthog:T': 'x' } },
    ]);
  });

  it('orders patches on a non-overlapping layer so nothing overlaps in between', () => {
    const cur = idx({
      words: [
        ['a', 0, 5],
        ['b', 6, 10],
      ],
    });
    const tgt = idx({
      words: [
        ['a', 0, 8],
        ['b', 9, 12],
      ],
    });
    expect(planLayer(cur, tgt, 'word').patches.map((p) => p.id)).toEqual(['b', 'a']);
  });

  it('breaks a swap by recreating one token rather than moving it', () => {
    const cur = idx({
      words: [
        ['a', 0, 5],
        ['b', 10, 15],
      ],
    });
    const tgt = idx({
      words: [
        ['a', 10, 15],
        ['b', 0, 5],
      ],
    });
    const p = planLayer(cur, tgt, 'word');
    expect(p.deletes).toEqual(['b']);
    expect(p.creates).toEqual([{ tid: 'b', begin: 0, end: 5, precedence: null, metadata: {} }]);
    expect(p.patches).toEqual([{ id: 'a', begin: 10, end: 15, precedence: undefined }]);
  });

  it('patches precedence and metadata on a morpheme, unordered', () => {
    const cur = idx({
      morphemes: [
        ['m1', 0, 6, 1, { form: 'perr' }],
        ['m2', 0, 6, 2, { form: 'os' }],
      ],
    });
    const tgt = idx({
      morphemes: [
        ['m1', 0, 6, 2, { form: 'perr' }],
        ['m2', 0, 6, 1, { form: 'o' }],
      ],
    });
    const p = planLayer(cur, tgt, 'morpheme');
    expect(p.patches).toEqual([
      { id: 'm1', begin: undefined, end: undefined, precedence: 2 },
      { id: 'm2', begin: undefined, end: undefined, precedence: 1 },
    ]);
    expect(p.metadata).toEqual([{ id: 'm2', metadata: { form: 'o' } }]);
  });

  it('adopts a token born at exactly the place of one gone, instead of replacing it', () => {
    const cur = idx({
      words: [
        ['w1', 0, 6],
        ['n1', 7, 13, null, { custom: 'x' }],
      ],
    });
    const tgt = idx({
      words: [
        ['w1', 0, 6],
        ['w2', 7, 13],
      ],
    });
    const idMap = new Map();
    const p = planLayer(cur, tgt, 'word', idMap);
    expect(p.deletes).toEqual([]);
    expect(p.creates).toEqual([]);
    expect(p.metadata).toEqual([{ id: 'n1', metadata: null }]);
    expect([...idMap]).toEqual([['w2', 'n1']]);
  });

  it('clears metadata the target did not have', () => {
    const cur = idx({ words: [['w1', 0, 6, null, { custom: 'x' }]] });
    const tgt = idx({ words: [['w1', 0, 6]] });
    expect(planLayer(cur, tgt, 'word').metadata).toEqual([{ id: 'w1', metadata: null }]);
  });
});

describe('planSpans', () => {
  it('creates a gone span on the tokens as they are now, and deletes a born one', () => {
    const cur = idx({ spans: [['spX', 'POS', ['w2'], 'X']] });
    const tgt = idx({ spans: [['sp1', 'POS', ['w9'], 'NOUN', { prov: 'inferred' }]] });
    const idMap = new Map([['w9', 'w1']]);
    const p = planSpans(cur, tgt, idMap);
    expect(p.deletes).toEqual(['spX']);
    expect(p.creates).toEqual([
      {
        sid: 'sp1',
        spanLayerId: 'SL-pos',
        tokens: ['w1'],
        value: 'NOUN',
        metadata: { prov: 'inferred' },
      },
    ]);
  });

  it('patches a surviving span by value, token set and metadata', () => {
    const cur = idx({ spans: [['sp1', 'POS', ['w1'], 'X', { a: 1 }]] });
    const tgt = idx({ spans: [['sp1', 'POS', ['w1', 'w2'], 'NOUN']] });
    const p = planSpans(cur, tgt, new Map());
    expect(p.updates).toEqual([{ id: 'sp1', value: 'NOUN' }]);
    expect(p.retokens).toEqual([{ id: 'sp1', tokens: ['w1', 'w2'] }]);
    expect(p.metadata).toEqual([{ id: 'sp1', metadata: null }]);
  });

  it('adopts a span born on the same tokens in the same layer, patching its value', () => {
    const cur = idx({ spans: [['spN', 'POS', ['w1'], 'X']] });
    const tgt = idx({ spans: [['sp1', 'POS', ['w1'], 'NOUN']] });
    const p = planSpans(cur, tgt, new Map());
    expect(p.deletes).toEqual([]);
    expect(p.creates).toEqual([]);
    expect(p.updates).toEqual([{ id: 'spN', value: 'NOUN' }]);
  });

  it('reports a span whose token nothing stands for, instead of guessing', () => {
    const cur = idx({ words: [['w1', 0, 6]] });
    const tgt = idx({ spans: [['sp1', 'POS', ['w2'], 'NOUN']] });
    const p = planSpans(cur, tgt, new Map());
    expect(p.creates).toEqual([]);
    expect(p.unresolved).toEqual([{ kind: 'span', id: 'sp1', layerName: 'POS', value: 'NOUN' }]);
  });
});

describe('planLinks', () => {
  it('recreates a link whose entry or tokens changed, and deletes a born one', () => {
    const cur = idx({
      links: [
        ['l1', 'item1', ['w1']],
        ['l2', 'item2', ['w2']],
        ['l9', 'item9', ['w3']],
      ],
    });
    const tgt = idx({
      links: [
        ['l1', 'item1', ['w1']],
        ['l2', 'item3', ['w2']],
        ['l3', 'item4', ['w3'], { prov: 'inferred' }],
      ],
    });
    const p = planLinks(cur, tgt, new Map());
    expect([...p.deletes].sort()).toEqual(['l2', 'l9']);
    expect(p.creates).toEqual([
      { lid: 'l2', itemId: 'item3', itemForm: 'item3', tokens: ['w2'], metadata: {} },
      {
        lid: 'l3',
        itemId: 'item4',
        itemForm: 'item4',
        tokens: ['w3'],
        metadata: { prov: 'inferred' },
      },
    ]);
  });
});

describe('planLinks (adoption)', () => {
  it('adopts a link born on the same entry and tokens', () => {
    const cur = idx({ links: [['lN', 'item1', ['w1'], { prov: 'fuzz' }]] });
    const tgt = idx({ links: [['l1', 'item1', ['w1']]] });
    const p = planLinks(cur, tgt, new Map());
    expect(p.deletes).toEqual([]);
    expect(p.creates).toEqual([]);
    expect(p.metadata).toEqual([{ id: 'lN', metadata: null }]);
  });
});

describe('summarizeRestore (after a restore)', () => {
  it('plans nothing for a state that matches under different ids', () => {
    const cur = indexDocument(
      raw({
        sentences: [['x0', 0, 20]],
        words: [
          ['x1', 0, 6],
          ['x2', 7, 13],
          ['x3', 14, 20],
        ],
        spans: [
          ['q', 'POS', ['x1'], 'NOUN'],
          ['tr', 'Translation', ['x0'], 'Dogs run.'],
        ],
        links: [['k', 'item1', ['x2']]],
      }),
    );
    const tgt = idx({
      spans: [
        ['sp1', 'POS', ['w1'], 'NOUN'],
        ['sp2', 'Translation', ['s1'], 'Dogs run.'],
      ],
      links: [['l1', 'item1', ['w2']]],
    });
    expect(summarizeRestore(cur, tgt).total).toBe(0);
  });
});

describe('planMetadata', () => {
  it('sets or clears document and text metadata that differ', () => {
    expect(planMetadata(idx(), idx({ metadata: { a: 1 }, textMetadata: { lang: 'es' } }))).toEqual({
      document: { a: 1 },
      text: { lang: 'es' },
    });
    expect(planMetadata(idx({ metadata: { a: 1 } }), idx())).toEqual({
      document: null,
      text: undefined,
    });
  });
});

describe('mapPartitionIds', () => {
  it('records the sentences that came back under a new id, by extent', () => {
    const fresh = idx({
      sentences: [
        ['s1', 0, 10],
        ['n1', 10, 20],
      ],
    });
    const tgt = idx({
      sentences: [
        ['s1', 0, 10],
        ['s2', 10, 20],
      ],
    });
    const idMap = new Map();
    mapPartitionIds(fresh, tgt, idMap);
    expect([...idMap]).toEqual([['s2', 'n1']]);
  });
});

describe('normalizeState / compareStates', () => {
  it('sees two states with different ids but the same content as equal', () => {
    const a = idx({
      spans: [['sp1', 'POS', ['w1'], 'NOUN']],
      links: [['l1', 'item1', ['w2']]],
    });
    const b = indexDocument(
      raw({
        words: [
          ['x1', 0, 6],
          ['x2', 7, 13],
          ['x3', 14, 20],
        ],
        spans: [['q', 'POS', ['x1'], 'NOUN']],
        links: [['k', 'item1', ['x2']]],
      }),
    );
    expect(compareStates(normalizeState(a), normalizeState(b))).toEqual([]);
  });

  it('names what differs, in bounded lines', () => {
    const a = idx({ spans: [['sp1', 'POS', ['w1'], 'NOUN']] });
    const b = idx({ spans: [['sp1', 'POS', ['w1'], 'VERB']] });
    const diffs = compareStates(normalizeState(a), normalizeState(b));
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toContain('spans[0].value');
  });
});

describe('summarizeRestore', () => {
  it('counts what the first plan would touch', () => {
    const cur = idx({
      body: 'perros corren rapido',
      words: [
        ['w1', 0, 6],
        ['w2', 7, 13],
        ['w9', 14, 20],
      ],
      spans: [['spX', 'POS', ['w9'], 'X']],
    });
    const tgt = idx({
      body: 'perros corren rapido!',
      words: [
        ['w1', 0, 6],
        ['w2', 7, 13],
        ['w3', 14, 21],
      ],
      spans: [['sp1', 'POS', ['w3'], 'ADV']],
      links: [['l1', 'item1', ['w1']]],
      metadata: { a: 1 },
    });
    const s = summarizeRestore(cur, tgt);
    expect(s).toMatchObject({
      text: true,
      sentences: 0,
      words: 2,
      morphemes: 0,
      alignments: 0,
      annotations: 2,
      links: 1,
      metadata: true,
      total: 6,
    });
  });
});
