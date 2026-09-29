import { describe, it, expect } from 'vitest';
import { footprintOf, untouched } from './rebase.js';
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
