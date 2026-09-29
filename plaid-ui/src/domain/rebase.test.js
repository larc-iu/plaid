import { describe, it, expect } from 'vitest';
import { apart, footprintOf, landed, pendingIdsOf, resendable, untouched } from './rebase.js';
import { pendingId } from './pendingIds.js';

// Luke's ruling Q2 (2026-09-29): a refused edit goes again by itself when what
// changed in between touches nothing it writes. Judged by layer and entity on
// the document's own shape, with nothing of any app.

// A document with a word layer, its Gloss spans, and a layer another app
// writes (its own tokens and spans).
const doc = ({ glosses = [], words, other = [], otherSpans = [], version = 1 } = {}) => ({
  id: 'd1',
  name: 'Doc',
  version,
  textLayers: [
    {
      id: 'tl',
      text: { id: 'tx', document: 'd1', body: 'the dog runs home' },
      tokenLayers: [
        {
          id: 'words',
          tokens: words ?? [
            { id: 't1', begin: 0, end: 3 },
            { id: 't2', begin: 4, end: 7 },
            { id: 't3', begin: 8, end: 12 },
            { id: 't4', begin: 13, end: 17 },
          ],
          spanLayers: [{ id: 'gloss', spans: glosses, relationLayers: [] }],
        },
        {
          id: 'nodes',
          tokens: other,
          spanLayers: [{ id: 'concepts', spans: otherSpans }],
        },
      ],
    },
  ],
});

const gloss = (id, token, value) => ({ id, tokens: [token], value, metadata: {} });

// B's edit, made on `base`: the footprint and the document it made.
const edit = (base, change) => {
  const made = structuredClone(base);
  change(made);
  return footprintOf(base, made);
};
const glossLayer = (d) => d.textLayers[0].tokenLayers[0].spanLayers[0];
const words = (d) => d.textLayers[0].tokenLayers[0].tokens;

describe('an edit refused because the document moved on', () => {
  const base = doc({ glosses: [gloss('s1', 't1', 'DEF')] });
  const addGlossOnDog = edit(base, (d) =>
    glossLayer(d).spans.push(gloss(pendingId(), 't2', 'CANINE')),
  );

  it('goes again when the change was a value on another word of the same layer', () => {
    const now = doc({
      version: 2,
      glosses: [gloss('s1', 't1', 'DEF'), gloss('s9', 't3', 'RUN')],
    });
    expect(untouched(addGlossOnDog, base, now)).toBe(true);
  });

  it('goes again when the change was the same words on another word', () => {
    const now = doc({
      version: 2,
      glosses: [gloss('s1', 't1', 'DEF'), gloss('s9', 't3', 'CANINE')],
    });
    expect(untouched(addGlossOnDog, base, now)).toBe(true);
  });

  it('goes again when the change was in a layer the edit does not write', () => {
    const now = doc({
      version: 2,
      glosses: [gloss('s1', 't1', 'DEF')],
      other: [{ id: 'n1', begin: 4, end: 7 }],
      otherSpans: [{ id: 'c1', tokens: ['n1'], value: 'dog-01' }],
    });
    expect(untouched(addGlossOnDog, base, now)).toBe(true);
  });

  it('is refused when someone gave the same word a value of that layer', () => {
    const now = doc({
      version: 2,
      glosses: [gloss('s1', 't1', 'DEF'), gloss('s9', 't2', 'HOUND')],
    });
    expect(untouched(addGlossOnDog, base, now)).toBe(false);
  });

  it('is refused when the word itself changed or went', () => {
    const moved = doc({ version: 2, glosses: [gloss('s1', 't1', 'DEF')] });
    words(moved)[1] = { id: 't2', begin: 4, end: 8 };
    expect(untouched(addGlossOnDog, base, moved)).toBe(false);
    const gone = doc({ version: 2, glosses: [gloss('s1', 't1', 'DEF')] });
    words(gone).splice(1, 1);
    expect(untouched(addGlossOnDog, base, gone)).toBe(false);
  });

  it('is refused when someone changed the very value it changes', () => {
    const change = edit(base, (d) => {
      glossLayer(d).spans[0].value = 'ART';
    });
    const now = doc({ version: 2, glosses: [gloss('s1', 't1', 'THE')] });
    expect(untouched(change, base, now)).toBe(false);
    const elsewhere = doc({
      version: 2,
      glosses: [gloss('s1', 't1', 'DEF'), gloss('s9', 't4', 'X')],
    });
    expect(untouched(change, base, elsewhere)).toBe(true);
  });

  it('judges a change to a word by the text it covers', () => {
    const split = edit(base, (d) => {
      words(d)[2] = { id: 't3', begin: 8, end: 11 };
      words(d).splice(3, 0, { id: pendingId(), begin: 11, end: 12 });
    });
    const beside = doc({ version: 2, glosses: [gloss('s1', 't1', 'DEF')] });
    words(beside)[0] = { id: 't1', begin: 0, end: 2 };
    expect(untouched(split, base, beside)).toBe(true);
    const over = doc({ version: 2, glosses: [gloss('s1', 't1', 'DEF')] });
    words(over).push({ id: 't5', begin: 10, end: 12 });
    expect(untouched(split, base, over)).toBe(false);
  });

  it('is refused when the edit changed the document itself (its name or metadata)', () => {
    // A document's own fields hold no entity the rule could compare, so
    // someone else's save to the same field would be written over unseen.
    const renamed = edit(base, (d) => {
      d.name = 'Mine';
    });
    const theirs = doc({ version: 2, glosses: [gloss('s1', 't1', 'DEF')] });
    theirs.name = 'Theirs';
    expect(untouched(renamed, base, theirs)).toBe(false);
    const meta = edit(base, (d) => {
      d.metadata = { speaker: 'Bea' };
    });
    const theirMeta = doc({ version: 2, glosses: [gloss('s1', 't1', 'DEF')] });
    theirMeta.metadata = { speaker: 'Ana' };
    expect(untouched(meta, base, theirMeta)).toBe(false);
  });

  it('goes again for the first value in an empty layer', () => {
    const empty = doc();
    const first = edit(empty, (d) => glossLayer(d).spans.push(gloss(pendingId(), 't2', 'CANINE')));
    const now = doc({ version: 2, glosses: [gloss('s9', 't3', 'RUN')] });
    expect(untouched(first, empty, now)).toBe(true);
  });

  it('is refused when it places something in a text someone else has edited', () => {
    // Its positions were measured in the text as it was: sent again, a node
    // for "dog" would land on whatever the new text holds there.
    const addNode = edit(base, (d) => {
      d.textLayers[0].tokenLayers[1].tokens.push({ id: pendingId(), begin: 4, end: 7 });
    });
    const shifted = doc({
      version: 2,
      glosses: [gloss('s1', 't1', 'DEF')],
      words: [
        { id: 't1', begin: 3, end: 6 },
        { id: 't2', begin: 7, end: 10 },
        { id: 't3', begin: 11, end: 15 },
        { id: 't4', begin: 16, end: 20 },
      ],
    });
    shifted.textLayers[0].text.body = 'Xx the dog runs home';
    expect(untouched(addNode, base, shifted)).toBe(false);
    // A value on a word places nothing: an edit to the text past that word
    // leaves it alone.
    const later = doc({
      version: 2,
      glosses: [gloss('s1', 't1', 'DEF')],
      words: [
        { id: 't1', begin: 0, end: 3 },
        { id: 't2', begin: 4, end: 7 },
        { id: 't3', begin: 11, end: 15 },
        { id: 't4', begin: 16, end: 20 },
      ],
    });
    later.textLayers[0].text.body = 'the dog Xx runs home';
    expect(untouched(addGlossOnDog, base, later)).toBe(true);
    const elsewhere = doc({
      version: 2,
      glosses: [gloss('s1', 't1', 'DEF'), gloss('s9', 't3', 'X')],
    });
    expect(untouched(addNode, base, elsewhere)).toBe(true);
  });

  it('reads a row this page made as the server has it, whatever order or empty fields it was shown with', () => {
    // A row shown before the server answered keeps the shape the page gave
    // it (fields in another order, no `precedence: null`) until a read. It
    // is not a change someone else made.
    const shown = doc({ glosses: [{ id: 's1', value: 'DEF', tokens: ['t1'], metadata: {} }] });
    words(shown)[1] = { end: 7, begin: 4, id: 't2' };
    const addOnDog = edit(shown, (d) => {
      glossLayer(d).spans[0].value = 'ART';
    });
    const now = doc({ version: 2, glosses: [gloss('s1', 't1', 'DEF'), gloss('s9', 't3', 'RUN')] });
    words(now)[1] = { id: 't2', begin: 4, end: 7, precedence: null };
    expect(untouched(addOnDog, shown, now)).toBe(true);
  });

  it('is refused when nothing is known of what the edit writes', () => {
    expect(untouched(footprintOf(base, structuredClone(base)), base, doc({ version: 2 }))).toBe(
      false,
    );
  });
});

// REV-F-IGT O5(b): the first gloss on a word makes a morpheme over it. Sent
// again after another user split that word, it made a morpheme across two
// words.
describe('an edit that places something inside a token of a parent layer', () => {
  // A morpheme layer nested in the word layer, and a layer another app
  // writes that is not.
  const nested = (over = {}) => {
    const d = doc(over);
    d.textLayers[0].tokenLayers.push({
      id: 'morphs',
      parentTokenLayer: 'words',
      tokens: over.morphs ?? [],
      spanLayers: [],
    });
    return d;
  };
  const morphs = (d) => d.textLayers[0].tokenLayers[2].tokens;
  const base = nested();
  const morphOnDog = edit(base, (d) => morphs(d).push({ id: pendingId(), begin: 4, end: 7 }));

  it('is refused when that token was split, resized or removed since', () => {
    const split = nested({ version: 2 });
    words(split)[1] = { id: 't2', begin: 4, end: 5 };
    words(split).push({ id: 't9', begin: 6, end: 7 });
    expect(untouched(morphOnDog, base, split)).toBe(false);
    const gone = nested({ version: 2 });
    words(gone).splice(1, 1);
    expect(untouched(morphOnDog, base, gone)).toBe(false);
  });

  it('goes again when the parent token elsewhere changed, or a token was only added there', () => {
    const elsewhere = nested({ version: 2 });
    words(elsewhere)[2] = { id: 't3', begin: 8, end: 10 };
    words(elsewhere).push({ id: 't9', begin: 10, end: 12 });
    expect(untouched(morphOnDog, base, elsewhere)).toBe(true);
  });

  it('goes again when a layer that is not its parent was cut up over the same text', () => {
    // A UMR node placed on "dog" and igt's morphemes of "dog" re-cut: the
    // node layer does not nest in the morpheme layer.
    const withMorphs = nested({ morphs: [{ id: 'm1', begin: 4, end: 7 }] });
    const nodeOnDog = edit(withMorphs, (d) =>
      d.textLayers[0].tokenLayers[1].tokens.push({ id: pendingId(), begin: 4, end: 7 }),
    );
    const recut = nested({ version: 2, morphs: [{ id: 'm1', begin: 4, end: 5 }] });
    morphs(recut).push({ id: 'm2', begin: 5, end: 7 });
    expect(untouched(nodeOnDog, withMorphs, recut)).toBe(true);
  });
});

// REV-F-NET D-6: a resend of a write whose first answer was lost is refused,
// and the read after it shows whether the write is there already.
describe('whether an edit is on the server already', () => {
  const base = doc({ glosses: [gloss('s1', 't1', 'DEF')] });
  const made = (change) => {
    const d = structuredClone(base);
    change(d);
    return d;
  };

  it('finds a row it added by its fields, and names its server id', () => {
    const id = pendingId();
    const mine = made((d) => glossLayer(d).spans.push(gloss(id, 't2', 'CANINE')));
    const now = doc({
      version: 2,
      glosses: [gloss('s1', 't1', 'DEF'), gloss('s7', 't2', 'CANINE')],
    });
    expect(landed(base, mine, now)).toEqual(new Map([[id, 's7']]));
    const other = doc({
      version: 2,
      glosses: [gloss('s1', 't1', 'DEF'), gloss('s7', 't2', 'HOUND')],
    });
    expect(landed(base, mine, other)).toBe(null);
    expect(landed(base, mine, base)).toBe(null);
  });

  it('ties the rows it added to each other by the ids they name', () => {
    const tok = pendingId();
    const span = pendingId();
    const mine = made((d) => {
      d.textLayers[0].tokenLayers[1].tokens.push({ id: tok, begin: 4, end: 7 });
      d.textLayers[0].tokenLayers[1].spanLayers[0].spans.push({
        id: span,
        tokens: [tok],
        value: 'dog',
      });
    });
    const now = doc({
      version: 2,
      glosses: [gloss('s1', 't1', 'DEF')],
      other: [
        { id: 'n1', begin: 0, end: 3 },
        { id: 'n2', begin: 4, end: 7 },
      ],
      otherSpans: [
        { id: 'c1', tokens: ['n1'], value: 'dog' },
        { id: 'c2', tokens: ['n2'], value: 'dog' },
      ],
    });
    expect(landed(base, mine, now)).toEqual(
      new Map([
        [tok, 'n2'],
        [span, 'c2'],
      ]),
    );
  });

  it('reads a changed field and a removed row', () => {
    const mine = made((d) => {
      glossLayer(d).spans[0].value = 'ART';
    });
    expect(landed(base, mine, doc({ version: 2, glosses: [gloss('s1', 't1', 'ART')] }))).toEqual(
      new Map(),
    );
    expect(landed(base, mine, doc({ version: 2, glosses: [gloss('s1', 't1', 'THE')] }))).toBe(null);
    const removed = made((d) => glossLayer(d).spans.splice(0, 1));
    expect(landed(base, removed, doc({ version: 2 }))).toEqual(new Map());
    expect(landed(base, removed, base)).toBe(null);
  });

  it('knows nothing of an edit that changed no row', () => {
    expect(landed(base, structuredClone(base), base)).toBe(null);
  });
});

describe('the pending ids an edit makes and names', () => {
  it('tells the rows it made from the ones it only points at', () => {
    const tok = pendingId();
    const before = doc();
    before.textLayers[0].tokenLayers[1].tokens.push({ id: tok, begin: 4, end: 7 });
    const span = pendingId();
    const after = structuredClone(before);
    after.textLayers[0].tokenLayers[1].spanLayers[0].spans.push({
      id: span,
      tokens: [tok],
      value: 'x',
    });
    const { created, named } = pendingIdsOf(before, after);
    expect([...created]).toEqual([span]);
    expect([...named].sort()).toEqual([span, tok].sort());
  });
});

describe('an edit that removes a row', () => {
  // A node (token n1 and its concept c1) with a relation layer beside it, as
  // an app keeps edges apart from the nodes they join.
  const withEdges = (relations) => {
    const d = doc({
      other: [
        { id: 'n1', begin: 4, end: 7 },
        { id: 'n2', begin: 8, end: 12 },
      ],
      otherSpans: [
        { id: 'c1', tokens: ['n1'], value: 'dog' },
        { id: 'c2', tokens: ['n2'], value: 'run-01' },
      ],
    });
    d.textLayers[0].tokenLayers[1].spanLayers[0].relationLayers = [{ id: 'edges', relations }];
    return d;
  };
  const base = withEdges([]);
  const removeDog = edit(base, (d) => {
    const nodes = d.textLayers[0].tokenLayers[1];
    nodes.tokens = nodes.tokens.filter((t) => t.id !== 'n1');
    nodes.spanLayers[0].spans = nodes.spanLayers[0].spans.filter((s) => s.id !== 'c1');
  });

  it('is refused when someone made a row in another layer that names it', () => {
    // The server takes that row with it: sent again, the removal would undo it unseen.
    const now = withEdges([{ id: 'e1', source: 'c2', target: 'c1', value: ':ARG0' }]);
    expect(untouched(removeDog, base, now)).toBe(false);
  });

  it('goes again when the row made elsewhere names something else', () => {
    const now = withEdges([{ id: 'e1', source: 'c2', target: 'c2', value: ':ARG0' }]);
    expect(untouched(removeDog, base, now)).toBe(true);
  });
});

describe('an edit that joins two rows placed in a nested layer', () => {
  // A relation between two spans on morphemes, the morpheme layer nested in
  // the word layer, as ud's words nest in its sentences.
  const joined = (over = {}) => {
    const d = doc(over);
    d.textLayers[0].tokenLayers.push({
      id: 'morphs',
      parentTokenLayer: 'words',
      tokens: [
        { id: 'm1', begin: 0, end: 3 },
        { id: 'm2', begin: 4, end: 7 },
      ],
      spanLayers: [
        {
          id: 'lemmas',
          spans: [
            { id: 'l1', tokens: ['m1'], value: 'the' },
            { id: 'l2', tokens: ['m2'], value: 'dog' },
          ],
          relationLayers: [{ id: 'deps', relations: [] }],
        },
      ],
    });
    return d;
  };
  const deps = (d) => d.textLayers[0].tokenLayers[2].spanLayers[0].relationLayers[0].relations;
  const base = joined();
  const headOfThe = edit(base, (d) =>
    deps(d).push({ id: pendingId(), source: 'l2', target: 'l1', value: 'det' }),
  );

  it('is refused when a token of a parent layer under one of its ends was re-cut', () => {
    // The stretch the two ends sat in was cut up differently (a sentence
    // split between them): the relation may now join two of them.
    const split = joined({ version: 2 });
    words(split)[1] = { id: 't2', begin: 4, end: 5 };
    words(split).push({ id: 't9', begin: 6, end: 7 });
    expect(untouched(headOfThe, base, split)).toBe(false);
  });

  it('goes again when the parent layer was re-cut elsewhere', () => {
    const elsewhere = joined({ version: 2 });
    words(elsewhere)[2] = { id: 't3', begin: 8, end: 10 };
    words(elsewhere).push({ id: 't9', begin: 10, end: 12 });
    expect(untouched(headOfThe, base, elsewhere)).toBe(true);
  });
});

// Luke's ruling Q2 narrowed (2026-09-30): every edit goes again only when
// what changed in between is all in layers it neither reads nor writes. A
// caller may opt a value write that moves no token in to the rule by entity.
describe('the rule by layer, which every edit gets', () => {
  const base = doc({ glosses: [gloss('s1', 't1', 'DEF')] });
  const addGlossOnDog = edit(base, (d) =>
    glossLayer(d).spans.push(gloss(pendingId(), 't2', 'CANINE')),
  );
  const addNode = edit(base, (d) => {
    const nodes = d.textLayers[0].tokenLayers[1];
    const id = pendingId();
    nodes.tokens.push({ id, begin: 8, end: 12 });
    nodes.spanLayers[0].spans.push({ id: pendingId(), tokens: [id], value: 'run-01' });
  });
  const glossElsewhere = doc({
    version: 2,
    glosses: [gloss('s1', 't1', 'DEF'), gloss('s9', 't3', 'RUN')],
  });
  const nodeElsewhere = doc({
    version: 2,
    glosses: [gloss('s1', 't1', 'DEF')],
    other: [{ id: 'n1', begin: 0, end: 3 }],
    otherSpans: [{ id: 'c1', tokens: ['n1'], value: 'the' }],
  });

  it('refuses a change on another word of a layer the edit writes', () => {
    expect(apart(addGlossOnDog, base, glossElsewhere)).toBe(false);
    expect(resendable(addGlossOnDog, base, glossElsewhere)).toBe(false);
    expect(apart(addNode, base, nodeElsewhere)).toBe(false);
  });

  it('lets an edit pass a change in layers it neither reads nor writes, both ways', () => {
    // An igt gloss and a UMR node.
    expect(apart(addGlossOnDog, base, nodeElsewhere)).toBe(true);
    expect(apart(addNode, base, glossElsewhere)).toBe(true);
  });

  it('counts the layers under what the edit names as read', () => {
    // A gloss reads the word layer it sits on: a word changed elsewhere refuses it.
    const wordMoved = doc({ version: 2, glosses: [gloss('s1', 't1', 'DEF')] });
    words(wordMoved)[3] = { id: 't4', begin: 13, end: 16 };
    expect(apart(addGlossOnDog, base, wordMoved)).toBe(false);
    // And the text, whose positions the words are measured in.
    const textEdited = doc({ version: 2, glosses: [gloss('s1', 't1', 'DEF')] });
    textEdited.textLayers[0].text.body = 'the dog runs home!';
    expect(apart(addGlossOnDog, base, textEdited)).toBe(false);
    expect(apart(addNode, base, textEdited)).toBe(false);
  });

  it('counts a re-cut of a parent layer, and a change to a layer itself, as touching', () => {
    const nested = (over = {}) => {
      const d = doc(over);
      d.textLayers[0].tokenLayers.push({
        id: 'morphs',
        parentTokenLayer: 'words',
        tokens: over.morphs ?? [{ id: 'm0', begin: 0, end: 3 }],
        spanLayers: [{ id: 'mgloss', spans: [] }],
      });
      return d;
    };
    const mbase = nested();
    const morphOnRuns = edit(mbase, (d) =>
      d.textLayers[0].tokenLayers[2].tokens.push({ id: pendingId(), begin: 8, end: 12 }),
    );
    // A word split elsewhere: the parent layer changed.
    const split = nested({ version: 2 });
    words(split)[0] = { id: 't1', begin: 0, end: 2 };
    words(split).push({ id: 't9', begin: 2, end: 3 });
    expect(apart(morphOnRuns, mbase, split)).toBe(false);
    // The morpheme layer's own settings.
    const configured = nested({ version: 2 });
    configured.textLayers[0].tokenLayers[2].config = { igt: { kind: 'morpheme' } };
    expect(apart(morphOnRuns, mbase, configured)).toBe(false);
    // A gloss elsewhere, a layer it does not read.
    expect(apart(morphOnRuns, mbase, nested({ ...glossElsewhere, version: 2 }))).toBe(true);
  });

  it('refuses a removal when a row in any layer now names what it removes', () => {
    const withNode = doc({
      other: [{ id: 'n1', begin: 4, end: 7 }],
      otherSpans: [{ id: 'c1', tokens: ['n1'], value: 'dog' }],
    });
    const clearDog = edit(withNode, (d) => {
      d.textLayers[0].tokenLayers[1].spanLayers[0].spans = [];
      d.textLayers[0].tokenLayers[1].tokens = [];
    });
    const named = structuredClone(withNode);
    named.textLayers[0].tokenLayers[0].spanLayers[0].relationLayers = [
      { id: 'links', relations: [{ id: 'r1', source: 's1', target: 'c1', value: 'x' }] },
    ];
    named.textLayers[0].tokenLayers[0].spanLayers[0].spans = [gloss('s1', 't1', 'DEF')];
    expect(apart(clearDog, withNode, named)).toBe(false);
  });

  it('counts every layer under one an edit re-cuts, one still empty included', () => {
    const withEdges = (relations) => {
      const d = doc({
        other: [
          { id: 'n1', begin: 0, end: 3 },
          { id: 'n2', begin: 4, end: 7 },
        ],
        otherSpans: [
          { id: 'c1', tokens: ['n1'], value: 'the' },
          { id: 'c2', tokens: ['n2'], value: 'dog' },
        ],
      });
      d.textLayers[0].tokenLayers[1].spanLayers[0].relationLayers = [{ id: 'edges', relations }];
      return d;
    };
    const empty = withEdges([]);
    const addNodeOnRuns = edit(empty, (d) => {
      const nodes = d.textLayers[0].tokenLayers[1];
      const id = pendingId();
      nodes.tokens.push({ id, begin: 8, end: 12 });
      nodes.spanLayers[0].spans.push({ id: pendingId(), tokens: [id], value: 'run-01' });
    });
    // A node added reads neither the edges nor the other nodes' concepts.
    const firstEdge = withEdges([{ id: 'e1', source: 'c2', target: 'c1', value: ':mod' }]);
    expect(apart(addNodeOnRuns, empty, firstEdge)).toBe(true);
    // A node moved takes its edges along: its first edge, made meanwhile.
    const moveDog = edit(empty, (d) => {
      d.textLayers[0].tokenLayers[1].tokens[1] = { id: 'n2', begin: 8, end: 12 };
    });
    const edgeOnCat = withEdges([{ id: 'e1', source: 'c1', target: 'c1', value: ':mod' }]);
    expect(apart(moveDog, empty, edgeOnCat)).toBe(false);
    // A text edit moves the tokens of every layer in that text.
    const retext = edit(empty, (d) => {
      d.textLayers[0].text.body = 'the dog runs home!';
    });
    const nodeAdded = structuredClone(empty);
    nodeAdded.textLayers[0].tokenLayers[1].tokens.push({ id: 'n3', begin: 13, end: 17 });
    expect(apart(retext, empty, nodeAdded)).toBe(false);
  });

  it('lets a value on a word pass a value on a morpheme nested in it', () => {
    // igt's IPA on a word, as a field of the word, and a gloss on a morpheme.
    const nested = (spans = []) => {
      const d = doc();
      d.textLayers[0].tokenLayers.push({
        id: 'morphs',
        parentTokenLayer: 'words',
        tokens: [{ id: 'm1', begin: 8, end: 12 }],
        spanLayers: [{ id: 'mgloss', spans }],
      });
      return d;
    };
    const mbase = nested();
    const ipaOnThe = edit(mbase, (d) => {
      words(d)[0].metadata = { ipa: 'ðə' };
    });
    expect(apart(ipaOnThe, mbase, nested([gloss('g1', 'm1', 'RUN')]))).toBe(true);
  });

  it("does not count this page's own rows the server does not have", () => {
    // An edit ahead of this one was refused: its rows are gone from the read.
    const mine = doc({ glosses: [gloss('s1', 't1', 'DEF'), gloss(pendingId(), 't3', 'RUN')] });
    const addNodeOnMine = edit(mine, (d) =>
      d.textLayers[0].tokenLayers[1].tokens.push({ id: pendingId(), begin: 0, end: 3 }),
    );
    const now = doc({ version: 2, glosses: [gloss('s1', 't1', 'DEF')] });
    expect(apart(addNodeOnMine, mine, now)).toBe(true);
  });

  it('gives an opted-in value write the rule by entity', () => {
    expect(resendable(addGlossOnDog, base, glossElsewhere, { byEntity: true })).toBe(true);
    const sameWord = doc({
      version: 2,
      glosses: [gloss('s1', 't1', 'DEF'), gloss('s9', 't2', 'HOUND')],
    });
    expect(resendable(addGlossOnDog, base, sameWord, { byEntity: true })).toBe(false);
  });

  it('gives an opted-in write that moves a token or the text the rule by layer all the same', () => {
    const resize = edit(base, (d) => {
      words(d)[3] = { id: 't4', begin: 13, end: 16 };
    });
    expect(untouched(resize, base, glossElsewhere)).toBe(true);
    expect(resendable(resize, base, glossElsewhere, { byEntity: true })).toBe(false);
    const retext = edit(base, (d) => {
      d.textLayers[0].text.body = 'the dog runs home!';
    });
    const wordGlossedElsewhere = doc({ version: 2, glosses: [gloss('s1', 't1', 'ART')] });
    expect(resendable(retext, base, nodeElsewhere, { byEntity: true })).toBe(false);
    expect(resendable(retext, base, wordGlossedElsewhere, { byEntity: true })).toBe(false);
  });
});
