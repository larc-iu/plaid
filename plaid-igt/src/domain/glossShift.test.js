// A gloss refused because the document moved on goes again by itself when
// what changed only moved its word: text typed in an earlier sentence shifts
// the offsets of every later word, sentence and morpheme, and a pure shift
// counts as unchanged (Luke, H17, the Q2 gloss check). A word whose own
// sentence was edited is still refused, since that sentence changed width.
import { describe, it, expect } from 'vitest';
import { footprintOf, resendable } from '@ui/domain/rebase.js';
import { buildRawDoc } from './test-helpers.js';

const BODY = 'one two\nthree four';
const layer = (raw, id) => raw.textLayers[0].tokenLayers.find((l) => l.id === id);
// Words nest in sentences and morphemes in words, as igt's setup makes them.
const base = () => {
  const raw = buildRawDoc({
    body: BODY,
    words: [
      { id: 'w-1', begin: 0, end: 3 },
      { id: 'w-2', begin: 4, end: 7 },
      { id: 'w-3', begin: 8, end: 13 },
      { id: 'w-4', begin: 14, end: 18 },
    ],
    sentences: [
      { id: 's-1', begin: 0, end: 8 },
      { id: 's-2', begin: 8, end: 18 },
    ],
  });
  layer(raw, 'wordL').parentTokenLayer = 'sentL';
  layer(raw, 'morphL').parentTokenLayer = 'wordL';
  return raw;
};

// The gloss write on morpheme `m`, as the page made it on `before`.
const glossOn = (before, m) => {
  const after = structuredClone(before);
  layer(after, 'morphL').spanLayers[0].spans.push({ id: 'g-new', tokens: [m], value: 'G' });
  return footprintOf(before, after);
};

// Another user typed `typed` at the front of the first word, the server's
// text rules having moved every token after it and grown the first sentence.
const typedAtFront = (typed, body = BODY) => {
  const now = base();
  const n = [...typed].length;
  now.textLayers[0].text.body = typed + body;
  for (const id of ['wordL', 'morphL', 'sentL']) {
    for (const t of layer(now, id).tokens) {
      if (t.id === 's-1') t.end += n;
      else {
        t.begin += n;
        t.end += n;
      }
    }
  }
  return now;
};

describe('a gloss after another user typed earlier in the document', () => {
  it('goes again on a word in a later sentence that only moved', () => {
    const before = base();
    expect(
      resendable(glossOn(before, 'm-3'), before, typedAtFront('xx '), { byEntity: true }),
    ).toBe(true);
  });

  it('is refused on a word whose letters changed where it moved to', () => {
    const before = base();
    const now = typedAtFront('xx ', 'one two\nthrxe four');
    expect(resendable(glossOn(before, 'm-3'), before, now, { byEntity: true })).toBe(false);
  });

  it('is refused on a word in the sentence that was edited', () => {
    const before = base();
    expect(
      resendable(glossOn(before, 'm-1'), before, typedAtFront('xx '), { byEntity: true }),
    ).toBe(false);
  });
});
