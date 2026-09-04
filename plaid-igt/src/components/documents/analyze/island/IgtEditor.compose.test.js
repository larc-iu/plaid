import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';

// Backslash codes and the zero morph, in the grid. The interesting part is not
// the table (domain/compose.test.js covers that) but the two places the grid
// already owns the keys a code needs: `-`/`=` split a morpheme, and Alt+key
// inserts a literal.

vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

let host;
let editor;

function mount() {
  const raw = buildRawDoc();
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const doc = new IgtDocument({
    raw,
    project: { id: 'proj-1', vocabs: [], config: { plaid: {}, igt: {} } },
    vocabularies: {},
    client,
    projectId: 'proj-1',
  });
  client.documents.get = async () => doc.raw;
  host = document.createElement('div');
  document.body.appendChild(host);
  editor = new IgtEditor(host, doc, {});
  return { doc, client };
}

const cell = (key) => host.querySelector(`[data-cell-key="${key}"]`);
const formsOf = (doc) => doc.sentences[0].tokens[0].morphemes.map((m) => m.metadata.form);

// One keystroke, in the order a browser delivers it: keydown first, and only
// if nothing cancelled it does the character reach beforeinput and the field.
const press = (el, ch, init = {}) => {
  const kd = new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(kd);
  if (kd.defaultPrevented) return;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const bi = new InputEvent('beforeinput', {
    inputType: 'insertText',
    data: ch,
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(bi);
  if (bi.defaultPrevented) return;
  el.value = el.value.slice(0, start) + ch + el.value.slice(end);
  el.setSelectionRange(start + 1, start + 1);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

const typeAll = (el, s) => {
  for (const ch of s) press(el, ch);
};

const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => resetIds());
afterEach(() => {
  editor?.destroy();
  host?.remove();
  editor = null;
  host = null;
});

describe('codes in the grid', () => {
  it('composes in a morpheme form cell', async () => {
    mount();
    const c = cell('mf:m-1');
    c.focus();
    c.value = '';
    c.setSelectionRange(0, 0);
    typeAll(c, 'k\\swt');
    expect(c.value).toBe('kət');
  });

  it('composes in an annotation cell', async () => {
    mount();
    const c = cell('ma:m-1:Gloss');
    c.focus();
    c.value = '';
    c.setSelectionRange(0, 0);
    typeAll(c, '\\ng');
    expect(c.value).toBe('ŋ');
  });

  it('leaves a metalanguage word alone', async () => {
    mount();
    const c = cell('ma:m-1:Gloss');
    c.focus();
    c.value = '';
    c.setSelectionRange(0, 0);
    typeAll(c, 'blue');
    expect(c.value).toBe('blue');
  });
});

describe('a code that ends in a split key', () => {
  it('composes instead of splitting the morpheme', async () => {
    // `\i-` is ɨ. The `-` must reach the composer, not the split.
    const { doc } = mount();
    const c = cell('mf:m-1');
    c.focus();
    c.value = '';
    c.setSelectionRange(0, 0);
    typeAll(c, 't\\i-');
    await settle();
    expect(c.value).toBe('tɨ');
    expect(formsOf(doc)).toHaveLength(1); // no split happened
  });

  it('still splits on a plain hyphen', async () => {
    const { doc } = mount();
    const c = cell('mf:m-1');
    c.focus();
    c.value = 'the';
    c.setSelectionRange(3, 3);
    press(c, '-');
    await settle();
    expect(formsOf(doc)).toEqual(['the', '']);
  });

  it('splits again once the code is finished', async () => {
    const { doc } = mount();
    const c = cell('mf:m-1');
    c.focus();
    c.value = '';
    c.setSelectionRange(0, 0);
    typeAll(c, '\\i-');
    expect(c.value).toBe('ɨ');
    press(c, '-'); // nothing pending now, so this one is a boundary
    await settle();
    expect(formsOf(doc)).toEqual(['ɨ', '']);
  });
});

describe('the zero morph', () => {
  it('Alt+0 types it into a morpheme form cell', () => {
    mount();
    const c = cell('mf:m-1');
    c.focus();
    c.value = '';
    c.setSelectionRange(0, 0);
    press(c, '0', { altKey: true });
    expect(c.value).toBe('∅');
  });

  it('is also reachable as a code', () => {
    mount();
    const c = cell('mf:m-1');
    c.focus();
    c.value = '';
    c.setSelectionRange(0, 0);
    typeAll(c, '\\0/');
    expect(c.value).toBe('∅');
  });

  it('commits to the morpheme as a real form', async () => {
    const { doc } = mount();
    const c = cell('mf:m-1');
    c.focus();
    c.value = '';
    c.setSelectionRange(0, 0);
    press(c, '0', { altKey: true });
    c.blur();
    await settle();
    expect(formsOf(doc)).toEqual(['∅']);
  });
});
