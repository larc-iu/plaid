// @vitest-environment jsdom
//
// jsdom, not the suite's default happy-dom: `isRtlBox` asks for a resolved
// `direction`, which is a question only a real layout engine answers.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isRtlBox, caretAtArrowEdge, arrowStep } from './bidi.js';

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
