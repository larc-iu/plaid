import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildRawDoc,
  makeFakeClient,
  resetIds,
  makeIgtDoc,
  settle,
  mountIsland,
} from '@/domain/test-helpers.js';
import { RESPELL_SPACE } from '@/domain/respell.js';
import { keys } from '@/lib/keymap.js';

// R51: respell a word in place. The word's popover's Respell row and the
// respell key (F2) open a box over the word with its text selected. Enter
// saves, Escape and leaving the box cancel, and a click never opens it.

vi.mock('@/utils/feedback', () => ({
  notifyWarning: vi.fn(),
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

let host;
let editor;

function mount({ readOnly = false, body = 'the kat', vocab = true } = {}) {
  const raw = buildRawDoc({ body });
  raw.textLayers[0].text.digest = 'digest-1';
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const doc = makeIgtDoc({
    raw,
    project: {
      id: 'proj-1',
      vocabs: vocab ? [{ id: 'v1' }] : [],
      config: { plaid: {} },
    },
    vocabularies: vocab ? { v1: { id: 'v1', name: 'Lexicon', items: [], vocabLinks: [] } } : {},
    client,
  });
  client.documents.get = async () => doc.raw;
  ({ host, editor } = mountIsland(doc, { readOnly }));
  return { doc, client };
}

const box = () => host.querySelector('.igt-respell__box');
const note = () => host.querySelector('.igt-respell__note');
const glossCell = (wordId) => host.querySelector(`[data-word-col="${wordId}"] .igt-field`);
const form = (wordId) => host.querySelector(`[data-word-col="${wordId}"] .igt-token-form`);
const click = (el) =>
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const key = (el, k) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const textWrites = (client) => client.calls.filter((c) => c.kind === 'texts.update');

beforeEach(() => resetIds());
afterEach(() => {
  editor?.destroy();
  host?.remove();
  editor = null;
  host = null;
});

describe('the respell box', () => {
  it('is bound to F2 by default', () => {
    expect(keys.caps('analyze.respell')).toEqual(['F2']);
  });

  it('opens on F2 from a cell of the word, holding the word, selected', () => {
    mount();
    const cell = glossCell('w-2');
    cell.focus();
    key(cell, 'F2');
    const el = box();
    expect(el).not.toBeNull();
    expect(el.closest('[data-word-col]').dataset.wordCol).toBe('w-2');
    expect(el.value).toBe('kat');
    expect(document.activeElement).toBe(el);
    expect([el.selectionStart, el.selectionEnd]).toEqual([0, 3]);
    expect(el.getAttribute('dir')).toBe('auto');
  });

  it('saves on Enter: one respell of the word, shown at once', async () => {
    const { doc, client } = mount();
    glossCell('w-2').focus();
    key(glossCell('w-2'), 'F2');
    box().value = 'cat';
    key(box(), 'Enter');
    expect(box()).toBeNull();
    expect(doc.body).toBe('the cat');
    expect(form('w-2').textContent).toContain('cat');
    await settle(3);
    const writes = textWrites(client);
    expect(writes).toHaveLength(1);
    expect(writes[0].args[1]).toEqual([{ type: 'replace', index: 4, length: 3, value: 'cat' }]);
    expect(client.operations.map((o) => o.message)).toContain('Respell kat → cat');
  });

  it('cancels on Escape and on leaving the box, sending nothing', async () => {
    const { doc, client } = mount();
    glossCell('w-2').focus();
    key(glossCell('w-2'), 'F2');
    box().value = 'cat';
    key(box(), 'Escape');
    expect(box()).toBeNull();
    key(glossCell('w-2'), 'F2');
    box().value = 'cat';
    box().blur();
    expect(box()).toBeNull();
    await settle(2);
    expect(textWrites(client)).toEqual([]);
    expect(doc.body).toBe('the kat');
  });

  it('sends nothing for the same spelling', async () => {
    const { client } = mount();
    glossCell('w-2').focus();
    key(glossCell('w-2'), 'F2');
    key(box(), 'Enter');
    expect(box()).toBeNull();
    await settle(2);
    expect(textWrites(client)).toEqual([]);
  });

  it('refuses a space and nothing typed in the box, which stays open', async () => {
    const { client } = mount();
    glossCell('w-2').focus();
    key(glossCell('w-2'), 'F2');
    box().value = 'c at';
    key(box(), 'Enter');
    expect(box()).not.toBeNull();
    expect(note().textContent).toBe(RESPELL_SPACE);
    expect(note().textContent).toMatch(/Tokenize/);
    box().value = '';
    key(box(), 'Enter');
    expect(note().textContent).toMatch(/at least one character/);
    await settle(2);
    expect(textWrites(client)).toEqual([]);
  });

  it('never opens on a plain click on the word', () => {
    mount();
    click(form('w-2'));
    expect(box()).toBeNull();
  });

  it('is offered in the word’s popover as Respell', () => {
    mount();
    click(host.querySelector('[data-pop-opener="vocab:w-2"]'));
    const row = [...host.querySelectorAll('.igt-vocab-pop button')].find(
      (b) => b.textContent.trim() === 'Respell',
    );
    expect(row).toBeTruthy();
    click(row);
    expect(host.querySelector('.igt-vocab-pop')).toBeNull();
    expect(box()?.value).toBe('kat');
  });

  it('is offered in the popover of a project with no lexicon', async () => {
    const { doc } = mount({ vocab: false });
    // An analyzed word, so it has the popover such a project offers.
    await doc.updateTokenSpan('w-2', 'POS', 'N');
    await settle(2);
    const opener = host.querySelector('[data-pop-opener="vocab:w-2"]');
    expect(opener).toBeTruthy();
    click(opener);
    const row = [...host.querySelectorAll('.igt-vocab-pop button')].find(
      (b) => b.textContent.trim() === 'Respell',
    );
    expect(row).toBeTruthy();
  });

  it('is not offered in a read-only grid', () => {
    mount({ readOnly: true });
    const cell = glossCell('w-2');
    cell.focus();
    key(cell, 'F2');
    expect(box()).toBeNull();
  });

  it('closes when the grid goes read-only', () => {
    mount();
    glossCell('w-2').focus();
    key(glossCell('w-2'), 'F2');
    expect(box()).not.toBeNull();
    editor.setReadOnly(true);
    expect(box()).toBeNull();
  });

  it('respells a right-to-left word', async () => {
    const { doc } = mount({ body: 'كتب ولد' });
    glossCell('w-2').focus();
    key(glossCell('w-2'), 'F2');
    expect(box().value).toBe('ولد');
    box().value = 'أولاد';
    key(box(), 'Enter');
    expect(doc.body).toBe('كتب أولاد');
  });
});
