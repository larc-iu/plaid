// @vitest-environment jsdom
//
// jsdom, not the suite's default happy-dom: `isRtlBox` asks for a resolved
// `direction`, which is a question only a real layout engine answers.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isRtlBox, caretAtArrowEdge, arrowStep, isolate, labelParts, labelText } from './bidi.js';

let host;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => host.remove());

const field = (value, dir) => {
  const el = document.createElement('input');
  if (dir) el.setAttribute('dir', dir);
  el.value = value;
  host.appendChild(el);
  return el;
};

const caretAt = (el, at) => {
  el.selectionStart = at;
  el.selectionEnd = at;
  return el;
};

describe('isRtlBox', () => {
  it('reads an explicit direction', () => {
    expect(isRtlBox(field('x', 'rtl'))).toBe(true);
    expect(isRtlBox(field('x', 'ltr'))).toBe(false);
  });

  it('says false rather than throwing when there is nothing to ask', () => {
    expect(isRtlBox(null)).toBe(false);
    expect(isRtlBox(undefined)).toBe(false);
  });
});

describe('caretAtArrowEdge', () => {
  it('lets the caret walk through an LTR value before it leaves', () => {
    const el = caretAt(field('book', 'ltr'), 2);
    expect(caretAtArrowEdge(el, true)).toBe(false);
    expect(caretAtArrowEdge(el, false)).toBe(false);
  });

  it('leaves an LTR value at the end going right, at the start going left', () => {
    const el = field('book', 'ltr');
    expect(caretAtArrowEdge(caretAt(el, 4), true)).toBe(true);
    expect(caretAtArrowEdge(caretAt(el, 4), false)).toBe(false);
    expect(caretAtArrowEdge(caretAt(el, 0), false)).toBe(true);
    expect(caretAtArrowEdge(caretAt(el, 0), true)).toBe(false);
  });

  it('reverses the two for an RTL value, where the logical end is on the left', () => {
    const el = field('كتاب', 'rtl');
    expect(caretAtArrowEdge(caretAt(el, 4), false)).toBe(true);
    expect(caretAtArrowEdge(caretAt(el, 4), true)).toBe(false);
    expect(caretAtArrowEdge(caretAt(el, 0), true)).toBe(true);
    expect(caretAtArrowEdge(caretAt(el, 0), false)).toBe(false);
  });

  it('holds a selection inside the field', () => {
    const el = field('book', 'ltr');
    el.selectionStart = 0;
    el.selectionEnd = 4;
    expect(caretAtArrowEdge(el, true)).toBe(false);
    expect(caretAtArrowEdge(el, false)).toBe(false);
  });

  it('is at both edges of an empty field', () => {
    const el = field('', 'ltr');
    expect(caretAtArrowEdge(el, true)).toBe(true);
    expect(caretAtArrowEdge(el, false)).toBe(true);
  });
});

describe('arrowStep', () => {
  it('reads right as forwards in an LTR grid', () => {
    expect(arrowStep(true, false)).toBe(1);
    expect(arrowStep(false, false)).toBe(-1);
  });

  it('reads LEFT as forwards in an RTL grid, where the next word is leftward', () => {
    expect(arrowStep(false, true)).toBe(1);
    expect(arrowStep(true, true)).toBe(-1);
  });
});

describe('isolate', () => {
  it('puts a value between FSI and PDI, and nothing in an empty one', () => {
    expect(isolate('كتاب')).toBe('\u2068كتاب\u2069');
    expect(isolate(undefined)).toBe('\u2068\u2069');
  });
});

// REV-HFT-7, H2-8-2, REV-G4-1: a History label is stored as typed, and
// where it is shown each value is drawn in a <bdi>: the label comes back in
// parts, a string drawn as it is and { isolate } in a <bdi>. Joined, the parts
// are the label itself, with no isolate character added.
describe('labelParts', () => {
  const ar = '\u0630\u0647\u0628 Ahmed \u0625\u0644\u0649';
  const same = (label) => {
    expect(labelText(labelParts(label))).toBe(label);
    expect(JSON.stringify(labelParts(label))).not.toMatch(/[\u2066-\u2069]/);
  };

  it('isolates each side of an arrow, and leaves a label with no value whole', () => {
    expect(labelParts('Respell \u0643\u062a\u0628 → \u0643\u062a')).toEqual([
      { isolate: ['Respell \u0643\u062a\u0628'] },
      ' → ',
      { isolate: ['\u0643\u062a'] },
    ]);
    // A quoted run on a side is isolated within it (REV-G4-R2-2).
    expect(labelParts('Replace “a” → “b” in Gloss')).toEqual([
      { isolate: ['Replace “', { isolate: ['a'] }, '”'] },
      ' → ',
      { isolate: ['“', { isolate: ['b'] }, '” in Gloss'] },
    ]);
    expect(labelParts('Confirm word analysis')).toEqual(['Confirm word analysis']);
    expect(labelParts(null)).toEqual([]);
  });

  it('isolates the value after the first colon and each quoted run', () => {
    expect(labelParts(`Translation of sentence 1: ${ar}`)).toEqual([
      'Translation of sentence 1',
      ': ',
      { isolate: [ar] },
    ]);
    expect(labelParts('Gloss of morpheme "\u0630\u0647\u0628" in sentence 2: go')).toEqual([
      'Gloss of morpheme "',
      { isolate: ['\u0630\u0647\u0628'] },
      '" in sentence 2',
      ': ',
      { isolate: ['go'] },
    ]);
    expect(labelParts('Create and link the entry “\u0630\u0647\u0628”')).toEqual([
      'Create and link the entry “',
      { isolate: ['\u0630\u0647\u0628'] },
      '”',
    ]);
    // A colon inside a quoted subject is not the value's, and the value may
    // hold one of its own.
    expect(labelParts('Gloss of "a: b" cleared')).toEqual([
      'Gloss of "',
      { isolate: ['a: b'] },
      '" cleared',
    ]);
    expect(labelParts('Note of sentence 1: a: b')).toEqual([
      'Note of sentence 1',
      ': ',
      { isolate: ['a: b'] },
    ]);
    expect(labelParts('Undo entry: Gloss of "x" in sentence 1: X')).toEqual([
      'Undo entry',
      ': ',
      { isolate: ['Gloss of "', { isolate: ['x'] }, '" in sentence 1: X'] },
    ]);
  });

  it('joins back to the stored label, with no isolate character', () => {
    for (const label of [
      'Respell kat → cat',
      `Translation of sentence 1: ${ar}`,
      'Delete entry "kaia"',
      'Gloss of "" in sentence 1: ',
      'Undo entry: Gloss of "x" in sentence 1: X',
      'Move vocabulary “Lexicon” to project “Kukama (UMR)”',
      'unbalanced "quote: here',
    ])
      same(label);
  });
});
