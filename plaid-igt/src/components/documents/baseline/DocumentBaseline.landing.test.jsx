import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { all } from '@ui/test/renderComponent.jsx';
import { fakeDocument, mountDocumentHook } from '../../../test/mountDocumentHook.jsx';
import { analyzeFocus, baselineFocus, tokenizeFocus } from '../hooks/focusHandoff.js';
import { DocumentBaseline } from './DocumentBaseline.jsx';

// The Analyze and Baseline tabs hand each other the sentence the reader was
// on (R50). Baseline lands on the sentence the grid was on: it scrolls to it,
// gives it a background that fades, and holds the caret at its start, which
// is where Edit text opens the box and the sentence the grid opens on when the
// reader goes back. A click in the text or the caret in the box moves it.
// Offsets on the wire are code points, the screen's are UTF-16.

// Three lines, a sentence each, with an astral letter (two UTF-16 units)
// before the second and third.
const body = '𐌰b\n𐌲d ef\ngh';
const sentences = [
  { id: 's1', begin: 0, end: 2 },
  { id: 's2', begin: 3, end: 8 },
  { id: 's3', begin: 9, end: 11 },
];

let scrolled;
beforeEach(() => {
  sessionStorage.clear();
  scrolled = [];
  Element.prototype.scrollIntoView = vi.fn(function () {
    scrolled.push(this.textContent);
  });
});
afterEach(() => {
  delete Element.prototype.scrollIntoView;
  vi.useRealTimers();
});

const mount = async ({ text = body, list = sentences, ctx, over = {} } = {}) => {
  const doc = fakeDocument({ id: 'doc-1', body: text, sentences: list, ...over });
  const m = await mountDocumentHook(() => null, {
    doc,
    render: () => <DocumentBaseline />,
    ...(ctx ? { ctx } : {}),
  });
  const view = () => m.container.querySelector('p.whitespace-pre-wrap');
  const flash = () => m.container.querySelector('.baseline-flash');
  const button = (label) => all(m.container, 'button').find((b) => b.textContent.includes(label));
  const box = () => m.container.querySelector('#baseline-text');
  const openEditor = async () => {
    await m.step(async () => button('Edit text').click());
    await m.step(() => new Promise((r) => requestAnimationFrame(r)));
  };
  return { m, doc, view, flash, button, box, openEditor };
};

describe('from the Analyze tab', () => {
  it('scrolls to the sentence the grid was on, lights it and holds the caret at its start', async () => {
    baselineFocus.write({ docId: 'doc-1', sentenceId: 's2', at: 3 });
    const { m, view, flash, openEditor, box } = await mount();
    expect(flash().textContent).toBe('𐌲d ef');
    expect(view().textContent).toBe(body);
    expect(scrolled).toEqual(['𐌲d ef']);
    expect(baselineFocus.read()).toBe(null);
    expect(analyzeFocus.read()).toEqual({ docId: 'doc-1', sentenceId: null, begin: null, at: 3 });
    // Nothing is selected: the light is a background.
    expect(window.getSelection().toString()).toBe('');
    // The caret opens the box where the sentence starts, after the astral letter.
    await openEditor();
    expect(box().selectionStart).toBe(4);
    expect(box().selectionEnd).toBe(4);
    await m.unmount();
  });

  it('takes the light off after a moment', async () => {
    vi.useFakeTimers();
    baselineFocus.write({ docId: 'doc-1', sentenceId: 's2', at: 3 });
    const { m, flash, view } = await mount();
    expect(flash()).not.toBe(null);
    await m.step(() => vi.advanceTimersByTime(2500));
    expect(flash()).toBe(null);
    expect(view().textContent).toBe(body);
    await m.unmount();
  });

  it('lands on the sentence nearest where a deleted one stood', async () => {
    baselineFocus.write({ docId: 'doc-1', sentenceId: 'gone', at: 9 });
    const { m, flash } = await mount({ list: sentences.filter((s) => s.id !== 's3') });
    expect(flash().textContent).toBe('𐌲d ef');
    expect(analyzeFocus.read().at).toBe(3);
    await m.unmount();
  });

  it('lands in right-to-left text', async () => {
    const text = 'שלום עולם\nمرحبا بالعالم';
    baselineFocus.write({ docId: 'doc-1', sentenceId: 'r2', at: 10 });
    const { m, flash, view } = await mount({
      text,
      list: [
        { id: 'r1', begin: 0, end: 9 },
        { id: 'r2', begin: 10, end: 23 },
      ],
    });
    expect(flash().textContent).toBe('مرحبا بالعالم');
    expect(view().getAttribute('dir')).toBe('auto');
    expect(view().textContent).toBe(text);
    await m.unmount();
  });

  it("lands for a reader who cannot edit, and ignores another document's sentence", async () => {
    baselineFocus.write({ docId: 'doc-1', sentenceId: 's3', at: 9 });
    const ro = await mount({ ctx: { readOnly: true, canWrite: false } });
    expect(ro.flash().textContent).toBe('gh');
    expect(ro.button('Edit text')).toBe(undefined);
    await ro.m.unmount();

    baselineFocus.write({ docId: 'doc-2', sentenceId: 's3', at: 9 });
    const other = await mount();
    expect(other.flash()).toBe(null);
    expect(analyzeFocus.read()).toBe(null);
    await other.m.unmount();
  });

  it('opens as before with nothing handed over, and with no sentences', async () => {
    const plain = await mount();
    expect(plain.flash()).toBe(null);
    expect(analyzeFocus.read()).toBe(null);
    await plain.m.unmount();

    baselineFocus.write({ docId: 'doc-1', sentenceId: 's2', at: 3 });
    const none = await mount({ text: 'abc', list: [] });
    expect(none.flash()).toBe(null);
    expect(none.view().textContent).toBe('abc');
    await none.m.unmount();
  });
});

describe('to the Analyze tab', () => {
  it('hands over the caret in the box, in code points', async () => {
    const { m, openEditor, box } = await mount();
    await openEditor();
    await m.step(async () => {
      box().focus();
      box().setSelectionRange(8, 8); // after "𐌲d e" on the second line
      box().dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowRight' }));
    });
    expect(analyzeFocus.read()).toEqual({ docId: 'doc-1', sentenceId: null, begin: null, at: 6 });
    await m.unmount();
  });

  it('hands over a click in the text, in code points', async () => {
    const { m, view } = await mount();
    const textNode = view().firstChild;
    await m.step(async () => {
      window.getSelection().collapse(textNode, 11); // before "gh", past two astral letters
      view().dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    expect(analyzeFocus.read()).toEqual({ docId: 'doc-1', sentenceId: null, begin: null, at: 9 });
    await m.unmount();
  });

  it('hands over nothing typed and unsaved: the caret it last had in the saved text stays', async () => {
    const { m, openEditor, box } = await mount();
    await openEditor();
    await m.step(async () => {
      box().focus();
      box().setSelectionRange(11, 11); // before "gh"
      box().dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowDown' }));
    });
    expect(analyzeFocus.read().at).toBe(9);
    // Ten lines typed at the top, the caret then moved inside the draft.
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    await m.step(async () => {
      setValue.call(box(), 'x\n'.repeat(10) + body);
      box().setSelectionRange(5, 5);
      box().dispatchEvent(new Event('input', { bubbles: true }));
    });
    await m.step(async () => {
      box().setSelectionRange(24, 24);
      box().dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowDown' }));
    });
    expect(box().value).not.toBe(body);
    expect(analyzeFocus.read().at).toBe(9);
    await m.unmount();
  });
});

describe('a save that lands', () => {
  it("hands over the box's last caret, read against the text it saved", async () => {
    // The save lands: the stored text is now what the box held.
    let landed = null;
    const editBaselineText = vi.fn(async () => {
      landed.doc.body = landed.box().value;
      return true;
    });
    const view = await mount({ over: { editBaselineText } });
    landed = view;
    const { m, openEditor, box, button } = view;
    await openEditor();
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    const caret = async (u) =>
      m.step(async () => {
        box().setSelectionRange(u, u);
        box().dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowDown' }));
      });
    await m.step(async () => box().focus());
    await caret(0);
    // A line typed at the top, then the caret on "gh", two lines down.
    await m.step(async () => {
      box().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'x' }));
      setValue.call(box(), 'x\n' + body);
      box().setSelectionRange(2, 2);
      box().dispatchEvent(new Event('input', { bubbles: true }));
    });
    await caret(13);
    expect(analyzeFocus.read().at).toBe(0);
    await m.step(async () => button('Save changes').click());
    await m.step(async () => {});
    expect(editBaselineText).toHaveBeenCalled();
    expect(analyzeFocus.read()).toEqual({ docId: 'doc-1', sentenceId: null, begin: null, at: 11 });
    await m.unmount();
  });
});

describe('a handoff is for the next tab only', () => {
  it('drops what was left for Analyze and Tokenize when the tab opens', async () => {
    analyzeFocus.write({ docId: 'doc-1', sentenceId: 's1', begin: null });
    tokenizeFocus.write({ docId: 'doc-1', sentenceId: 's1', begin: 0 });
    const { m } = await mount();
    expect(analyzeFocus.read()).toBe(null);
    expect(tokenizeFocus.read()).toBe(null);
    await m.unmount();
  });

  it('leaves its own landing for Analyze after dropping the rest', async () => {
    tokenizeFocus.write({ docId: 'doc-1', sentenceId: 's1', begin: 0 });
    baselineFocus.write({ docId: 'doc-1', sentenceId: 's3', at: 9 });
    const { m } = await mount();
    expect(tokenizeFocus.read()).toBe(null);
    expect(analyzeFocus.read()).toEqual({ docId: 'doc-1', sentenceId: null, begin: null, at: 9 });
    await m.unmount();
  });
});
