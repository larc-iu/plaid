import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient } from '@/domain/test-helpers.js';

// Tab inside the grid walks every cell of the document, so Escape in a cell
// with nothing typed, then Tab, leaves the grid. Escape over typing still only
// puts the value back.

vi.mock('@/utils/feedback', () => ({
  notifyWarning: vi.fn(),
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

let page;
let editor;
afterEach(() => {
  editor?.destroy();
  page?.remove();
});

function mount() {
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
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const doc = new IgtDocument({
    raw,
    project: { id: 'proj-1', vocabs: [], config: { plaid: {} } },
    vocabularies: {},
    client,
    projectId: 'proj-1',
  });
  page = document.createElement('div');
  page.innerHTML =
    '<button id="before">Before</button><div id="host"></div><button id="after">After</button>';
  document.body.appendChild(page);
  editor = new IgtEditor(page.querySelector('#host'), doc, {});
}

const key = (el, init) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  return event;
};

const cell = () => page.querySelector('input[aria-label="POS for cat"]');

describe('leaving the Analyze grid', () => {
  beforeEach(() => mount());

  it('Escape in an untouched cell, then Tab, goes past the grid', () => {
    const el = cell();
    el.focus();
    key(el, { key: 'Escape' });
    expect(document.activeElement).not.toBe(el);
    const tab = key(document.body, { key: 'Tab' });
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement.id).toBe('after');
  });

  it('Shift+Tab goes before the grid, to the toolbar', () => {
    const el = cell();
    el.focus();
    key(el, { key: 'Escape' });
    key(document.body, { key: 'Tab', shiftKey: true });
    const at = document.activeElement;
    expect(at.closest('.igt-sentence')).toBe(null);
    expect(page.contains(at)).toBe(true);
  });

  it('Escape over typing only puts the value back', () => {
    const el = cell();
    el.focus();
    el.value = 'N';
    key(el, { key: 'Escape' });
    expect(el.value).toBe('');
    expect(key(document.body, { key: 'Tab' }).defaultPrevented).toBe(false);
  });

  it('a key between Escape and Tab takes it back', () => {
    const el = cell();
    el.focus();
    key(el, { key: 'Escape' });
    key(document.body, { key: 'x' });
    expect(key(document.body, { key: 'Tab' }).defaultPrevented).toBe(false);
  });
});
