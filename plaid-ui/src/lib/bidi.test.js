// @vitest-environment jsdom
//
// jsdom, not the suite's default happy-dom: `isRtlBox` asks for a resolved
// `direction`, which is a question only a real layout engine answers.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isRtlBox, caretAtArrowEdge, arrowStep, isolate, isolateLabel } from './bidi.js';

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

// REV-HFT-7: a History label is stored as typed, and its two sides of an
// arrow are isolated where it is shown, so two right-to-left spellings do not
// join into one run that reads backwards.
describe('isolateLabel', () => {
  it('isolates each side of an arrow, and leaves a label with no value as it is', () => {
    expect(isolateLabel('Respell \u0643\u062a\u0628 → \u0643\u062a')).toBe(
      '\u2068Respell \u0643\u062a\u0628\u2069 → \u2068\u0643\u062a\u2069',
    );
    expect(isolateLabel('Confirm word analysis')).toBe('Confirm word analysis');
    expect(isolateLabel(null)).toBe(null);
  });

  // H2-8-2: a cell edit's value, after the first colon, and every quoted
  // subject keep their own direction.
  it('isolates the value after the last colon and each quoted run', () => {
    const ar = '\u0630\u0647\u0628 Ahmed \u0625\u0644\u0649';
    expect(isolateLabel(`Translation of sentence 1: ${ar}`)).toBe(
      `Translation of sentence 1: \u2068${ar}\u2069`,
    );
    expect(isolateLabel('Gloss of morpheme "\u0630\u0647\u0628" in sentence 2: go')).toBe(
      'Gloss of morpheme "\u2068\u0630\u0647\u0628\u2069" in sentence 2: \u2068go\u2069',
    );
    expect(isolateLabel('Create and link the entry “\u0630\u0647\u0628”')).toBe(
      'Create and link the entry “\u2068\u0630\u0647\u0628\u2069”',
    );
    // A colon inside a quoted subject is not the value's.
    expect(isolateLabel('Gloss of "a: b" cleared')).toBe('Gloss of "\u2068a: b\u2069" cleared');
    // The first colon: a value may hold one of its own.
    expect(isolateLabel('Note of sentence 1: a: b')).toBe('Note of sentence 1: \u2068a: b\u2069');
    expect(isolateLabel('Undo entry: Gloss of "x" in sentence 1: X')).toBe(
      'Undo entry: \u2068Gloss of "\u2068x\u2069" in sentence 1: X\u2069',
    );
  });
});
