import { describe, it, expect, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { buildRawDoc, makeFakeClient, makeIgtDoc, mountIsland } from '@/domain/test-helpers.js';

// H2-2: Enter and Tab from the last cell of a row on a page found no cell
// after it (only one page of sentences is drawn), so Enter dropped focus to
// the page and Tab went to whatever came next in the DOM. They go on to the
// same row of the next page, and Shift+Tab back to the previous one.

vi.mock('@/utils/feedback', () => ({
  notifyWarning: vi.fn(),
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

let host;
let editor;
const PAGE_SIZE = IgtEditor.PAGE_SIZE;
afterEach(() => {
  IgtEditor.PAGE_SIZE = PAGE_SIZE;
  editor?.destroy();
  host?.remove();
});

const LEIPZIG = { delimiters: '.', mode: 'closed', values: [{ value: 'PL' }] };

function mount({ closed = false } = {}) {
  const raw = buildRawDoc({
    body: 'the cat sat down',
    words: [
      { id: 'w-1', begin: 0, end: 3 },
      { id: 'w-2', begin: 4, end: 7 },
      { id: 'w-3', begin: 8, end: 11 },
      { id: 'w-4', begin: 12, end: 16 },
    ],
    sentences: [
      { id: 's-1', begin: 0, end: 7 },
      { id: 's-2', begin: 8, end: 16 },
    ],
  });
  if (closed) {
    raw.textLayers[0].tokenLayers
      .flatMap((tl) => tl.spanLayers || [])
      .find((sl) => sl.id === 'ssl-0').config.igt.tagset = 'Leipzig';
  }
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const doc = makeIgtDoc({
    raw,
    client,
    ...(closed
      ? {
          project: {
            id: 'proj-1',
            vocabs: [],
            config: { plaid: {}, igt: { tagsets: { Leipzig: LEIPZIG } } },
          },
        }
      : {}),
  });
  ({ host, editor } = mountIsland(doc));
}

const key = (el, init) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  return event;
};
const pos = (word) => host.querySelector(`input[aria-label="POS for ${word}"]`);
const translation = () => host.querySelector('.igt-field[data-tier^="sa:"]');

describe('Enter and Tab at the edge of a page', () => {
  it('Enter in the last cell of a row goes on to that row on the next page', () => {
    IgtEditor.PAGE_SIZE = 1;
    mount();
    const el = pos('cat');
    el.focus();
    key(el, { key: 'Enter' });
    expect(editor._page).toBe(1);
    expect(document.activeElement).toBe(pos('sat'));
  });

  it('Tab goes on, and Shift+Tab comes back to the last cell of the row', () => {
    IgtEditor.PAGE_SIZE = 1;
    mount();
    pos('cat').focus();
    expect(key(pos('cat'), { key: 'Tab' }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(pos('sat'));
    expect(key(pos('sat'), { key: 'Tab', shiftKey: true }).defaultPrevented).toBe(true);
    expect(editor._page).toBe(0);
    expect(document.activeElement).toBe(pos('cat'));
  });

  it("Tab in a sentence's field goes to the next page's", () => {
    IgtEditor.PAGE_SIZE = 1;
    mount();
    const el = translation();
    el.focus();
    expect(key(el, { key: 'Tab' }).defaultPrevented).toBe(true);
    expect(editor._page).toBe(1);
    expect(document.activeElement).toBe(translation());
    expect(document.activeElement.closest('[data-sentence-id]').dataset.sentenceId).toBe('s-2');
  });

  it('stays put on the last page', () => {
    IgtEditor.PAGE_SIZE = 1;
    mount();
    editor._setPage(1);
    const el = pos('down');
    el.focus();
    expect(editor._navMove(el, 'next')).toBe(false);
    expect(editor._page).toBe(1);
  });

  // REV-HFT-1: the page turned under a value the tagset refused, and the
  // typed value was lost. The cell is committed first, and a refusal keeps
  // the page, the cell, focus and the typed text.
  it('a value the tagset refuses keeps the page, the cell and the text', async () => {
    IgtEditor.PAGE_SIZE = 1;
    mount({ closed: true });
    const el = translation();
    el.focus();
    el.value = 'BAD';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const tab = key(el, { key: 'Tab' });
    expect(tab.defaultPrevented).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(editor._page).toBe(0);
    expect(el.isConnected).toBe(true);
    expect(document.activeElement).toBe(el);
    expect(el.value).toBe('BAD');
    // Enter, the same.
    key(el, { key: 'Enter' });
    await new Promise((r) => setTimeout(r, 10));
    expect(editor._page).toBe(0);
    expect(document.activeElement).toBe(el);
    expect(el.value).toBe('BAD');
  });

  it('an allowed value is committed and the page turns', async () => {
    IgtEditor.PAGE_SIZE = 1;
    mount({ closed: true });
    const el = translation();
    el.focus();
    el.value = 'PL';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    key(el, { key: 'Tab' });
    expect(editor._page).toBe(1);
    expect(document.activeElement.closest('[data-sentence-id]').dataset.sentenceId).toBe('s-2');
  });
});
