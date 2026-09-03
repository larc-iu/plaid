import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';

// Multi-word expressions in the interlinear editor: how a linked one draws,
// how words are gathered (Shift+click, Shift+arrows), what the popover does in
// expression mode, and how an existing one is changed. DOM interactions
// against the real IgtDocument and the in-memory fake client.

vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

let host;
let editor;

// "the cat sat down", one sentence, and a lexicon with a phrase entry.
function mount({ links = [] } = {}) {
  const raw = buildRawDoc({
    body: 'the cat sat down',
    words: [
      { id: 'w-1', begin: 0, end: 3 },
      { id: 'w-2', begin: 4, end: 7 },
      { id: 'w-3', begin: 8, end: 11 },
      { id: 'w-4', begin: 12, end: 16 },
    ],
  });
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const doc = new IgtDocument({
    raw,
    project: { id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {} } },
    vocabularies: {
      v1: {
        id: 'v1',
        name: 'Lexicon',
        items: [
          { id: 'i-cat', form: 'cat', metadata: { morphType: 'stem' } },
          { id: 'i-sit', form: 'sit down', metadata: { morphType: 'phrase' } },
          { id: 'i-the', form: 'the', metadata: { morphType: 'stem' } },
        ],
        vocabLinks: links,
      },
    },
    client,
    projectId: 'proj-1',
  });
  client.documents.get = async () => doc.raw;
  host = document.createElement('div');
  document.body.appendChild(host);
  editor = new IgtEditor(host, doc, {});
  return { doc, client };
}

const linkOver = (id, tokens, item = { id: 'i-sit', form: 'sit down' }, metadata) => ({
  id,
  tokens,
  vocabItem: { ...item, metadata: { morphType: 'phrase' } },
  ...(metadata ? { metadata } : {}),
});

const form = (wordId) => host.querySelector(`[data-word-col="${wordId}"] .igt-token-form`);
const pieces = (key) => [...host.querySelectorAll(`.igt-mwe[data-mwe="${key}"]`)];
const label = (key) => host.querySelector(`button.igt-mwe__label[data-vocab-opener="${key}"]`);
const popover = () => host.querySelector('.igt-vocab-pop');
const lanesOf = () => host.querySelector('.igt-sentence').style.getPropertyValue('--igt-mwe-lanes');
const selectedForms = () =>
  [...host.querySelectorAll('.igt-token-form.is-selected')].map(
    (el) => el.closest('[data-word-col]').dataset.wordCol,
  );

const click = (el, init = {}) =>
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
const key = (el, k, init = {}) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
};
const settle = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => resetIds());
afterEach(() => {
  editor?.destroy();
  host?.remove();
  editor = null;
  host = null;
});

describe('a linked multi-word expression', () => {
  it('draws one bracket piece per member column, labelled with the entry form', () => {
    mount({ links: [linkOver('lk-1', ['w-3', 'w-4'])] });
    const ps = pieces('mwe:lk-1');
    expect(ps.map((p) => p.className)).toEqual(['igt-mwe igt-mwe--start', 'igt-mwe igt-mwe--end']);
    expect(ps[0].closest('[data-word-col]').dataset.wordCol).toBe('w-3');
    expect(label('mwe:lk-1').textContent.trim()).toBe('sit down');
    expect(lanesOf()).toBe('1');
    // The words' own chip slots are untouched.
    expect(host.querySelector('[data-word-col="w-3"] .igt-vocab__link')).not.toBeNull();
  });

  it('dots a skipped word and stacks an overlapping expression on a second lane', () => {
    mount({
      links: [
        linkOver('lk-1', ['w-1', 'w-3']),
        linkOver('lk-2', ['w-2', 'w-4'], { id: 'i-cat', form: 'cat' }),
      ],
    });
    expect(pieces('mwe:lk-1').map((p) => p.className)).toEqual([
      'igt-mwe igt-mwe--start',
      'igt-mwe igt-mwe--pass',
      'igt-mwe igt-mwe--end',
    ]);
    expect(pieces('mwe:lk-2').map((p) => p.style.getPropertyValue('--igt-lane'))).toEqual([
      '1',
      '1',
      '1',
    ]);
    expect(lanesOf()).toBe('2');
  });

  it('shows an auto-linked one in the machine style, and Enter on its label confirms it', async () => {
    const { doc, client } = mount({
      links: [
        linkOver('lk-1', ['w-3', 'w-4'], undefined, { prov: 'inferred', provSource: 'rule' }),
      ],
    });
    const lbl = label('mwe:lk-1');
    expect(lbl.classList.contains('igt-mwe__label--machine')).toBe(true);
    lbl.focus();
    key(lbl, 'Enter');
    await settle();
    expect(client.calls.some((c) => c.kind === 'vocabLinks.patchMetadata')).toBe(true);
    expect(doc.sentences[0].mwes[0].prov).toBe('verified');
    expect(label('mwe:lk-1').classList.contains('igt-mwe__label--verified')).toBe(true);
  });

  it('opens from its label with the entry marked linked, and unlink removes it', async () => {
    const { doc, client } = mount({ links: [linkOver('lk-1', ['w-3', 'w-4'])] });
    click(label('mwe:lk-1'));
    const pop = popover();
    expect(pop).not.toBeNull();
    expect(
      [...pop.querySelectorAll('.igt-vocab-pop__member')].map((m) =>
        m.textContent.replace(/\s+/g, ''),
      ),
    ).toEqual(['sat×', 'down×']);
    const linkedRow = pop.querySelector('.igt-vocab-pop__item.is-linked');
    expect(linkedRow.textContent).toContain('sit down');
    click(linkedRow.querySelector('.igt-vocab-pop__x'));
    await settle();
    expect(client.calls.map((c) => c.kind)).toContain('vocabLinks.delete');
    expect(doc.sentences[0].mwes).toEqual([]);
    expect(pieces('mwe:lk-1')).toEqual([]);
  });

  it('choosing another entry relinks the same words', async () => {
    const { doc, client } = mount({ links: [linkOver('lk-1', ['w-3', 'w-4'])] });
    click(label('mwe:lk-1'));
    const row = [...popover().querySelectorAll('.igt-vocab-pop__item')].find((r) =>
      r.textContent.includes('cat'),
    );
    click(row);
    await settle();
    const create = client.calls.find((c) => c.kind === 'vocabLinks.create');
    expect(create.args).toEqual(['i-cat', ['w-3', 'w-4']]);
    expect(doc.sentences[0].mwes[0].item.id).toBe('i-cat');
  });
});

describe('gathering words into a multi-word expression', () => {
  it('Shift+click outlines the words and shows a pending bracket; Escape drops them', () => {
    mount();
    click(form('w-2'), { shiftKey: true });
    click(form('w-3'), { shiftKey: true });
    expect(selectedForms()).toEqual(['w-2', 'w-3']);
    expect(pieces('mwe:new').map((p) => p.className)).toEqual([
      'igt-mwe igt-mwe--start igt-mwe--pending',
      'igt-mwe igt-mwe--end igt-mwe--pending',
    ]);
    expect(lanesOf()).toBe('1');
    // The pending label took focus, so Enter can open the popover.
    expect(document.activeElement).toBe(label('mwe:new'));
    key(host, 'Escape');
    expect(selectedForms()).toEqual([]);
    expect(pieces('mwe:new')).toEqual([]);
    expect(lanesOf()).toBe('0');
  });

  it('a click on a gathered word drops it again, and the last one ends the gathering', () => {
    mount();
    click(form('w-1'), { shiftKey: true });
    click(form('w-2'));
    expect(selectedForms()).toEqual(['w-1', 'w-2']);
    click(form('w-1'));
    expect(selectedForms()).toEqual(['w-2']);
    click(form('w-2'));
    expect(selectedForms()).toEqual([]);
  });

  it('Shift+→ from a cell extends the selection, Ctrl+Shift+→ skips a word', () => {
    mount();
    const cell = host.querySelector('[data-cell-key="wa:w-1:POS"]');
    cell.focus();
    key(cell, 'ArrowRight', { shiftKey: true });
    expect(selectedForms()).toEqual(['w-1', 'w-2']);
    key(cell, 'ArrowRight', { shiftKey: true, ctrlKey: true });
    key(cell, 'ArrowRight', { shiftKey: true });
    expect(selectedForms()).toEqual(['w-1', 'w-2', 'w-4']);
    expect(pieces('mwe:new').map((p) => p.className)).toEqual([
      'igt-mwe igt-mwe--start igt-mwe--pending',
      'igt-mwe igt-mwe--mid igt-mwe--pending',
      'igt-mwe igt-mwe--pass igt-mwe--pending',
      'igt-mwe igt-mwe--end igt-mwe--pending',
    ]);
    // Focus stayed in the cell the whole time.
    expect(document.activeElement).toBe(cell);
  });

  it('inside a value Shift+→ is still text selection', () => {
    mount();
    const cell = host.querySelector('[data-cell-key="wa:w-1:POS"]');
    cell.focus();
    cell.value = 'NOUN';
    cell.setSelectionRange(1, 1);
    const e = key(cell, 'ArrowRight', { shiftKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(selectedForms()).toEqual([]);
  });

  it('Enter opens the popover in expression mode: members, phrase entries first, the joined form to create', () => {
    mount();
    click(form('w-3'), { shiftKey: true });
    click(form('w-4'), { shiftKey: true });
    key(label('mwe:new'), 'Enter');
    const pop = popover();
    expect(pop).not.toBeNull();
    expect(pop.getAttribute('aria-label')).toBe('Link words to lexicon');
    expect(
      [...pop.querySelectorAll('.igt-vocab-pop__member')].map((m) =>
        m.textContent.replace(/\s+/g, ''),
      ),
    ).toEqual(['sat×', 'down×']);
    const rows = [...pop.querySelectorAll('.igt-vocab-pop__item .igt-vocab-pop__form')].map((r) =>
      r.textContent.trim(),
    );
    expect(rows[0]).toBe('sit down');
    expect(pop.querySelector('.igt-vocab-pop__create').textContent).toContain('"sat down"');
    const type = pop.querySelector('.igt-vocab-pop__type select');
    expect(type.querySelector('option[selected]').value).toBe('phrase');
    expect(type.disabled).toBe(true);
  });

  it('picking an entry links the gathered words to it', async () => {
    const { doc, client } = mount();
    click(form('w-3'), { shiftKey: true });
    click(form('w-4'), { shiftKey: true });
    key(label('mwe:new'), 'Enter');
    const row = [...popover().querySelectorAll('.igt-vocab-pop__item')].find((r) =>
      r.textContent.includes('sit down'),
    );
    click(row);
    await settle();
    const create = client.calls.find((c) => c.kind === 'vocabLinks.create');
    expect(create.args[0]).toBe('i-sit');
    expect(create.args[1]).toEqual(['w-3', 'w-4']);
    expect(doc.sentences[0].mwes[0].item.form).toBe('sit down');
    expect(selectedForms()).toEqual([]);
    expect(pieces('mwe:new')).toEqual([]);
    expect(label(`mwe:${doc.sentences[0].mwes[0].linkId}`).textContent.trim()).toBe('sit down');
  });

  it('creating an entry for skipped words types it a discontiguous phrase', async () => {
    const { doc, client } = mount();
    click(form('w-2'), { shiftKey: true });
    click(form('w-4'), { shiftKey: true });
    key(label('mwe:new'), 'Enter');
    const create = popover().querySelector('.igt-vocab-pop__create');
    click(create);
    click(create);
    await settle();
    const item = client.calls.find((c) => c.kind === 'vocabItems.create');
    expect(item.args).toEqual(['v1', 'cat down', { morphType: 'discontiguous phrase' }]);
    expect(doc.sentences[0].mwes[0].item.form).toBe('cat down');
  });

  it('the single-word popover offers to start an expression and lists the ones the word is in', () => {
    mount({ links: [linkOver('lk-1', ['w-3', 'w-4'])] });
    click(host.querySelector('[data-word-col="w-3"] .igt-vocab__link'));
    const rows = [...popover().querySelectorAll('.igt-vocab-pop__mwe')].map((r) =>
      r.textContent.replace(/\s+/g, ' ').trim(),
    );
    expect(rows).toEqual(['In: sit down', 'Part of a longer expression…']);
    click(popover().querySelectorAll('.igt-vocab-pop__mwe')[1]);
    expect(popover()).toBeNull();
    expect(selectedForms()).toEqual(['w-3']);
    expect(pieces('mwe:new')).toEqual([]);
    expect(label('mwe:new').textContent.trim()).toBe('add words…');
  });

  it('Shift+click while an expression is open re-covers it with the new words', async () => {
    const { doc, client } = mount({ links: [linkOver('lk-1', ['w-3', 'w-4'])] });
    click(label('mwe:lk-1'));
    click(form('w-2'), { shiftKey: true });
    await settle();
    expect(popover()).toBeNull();
    const create = client.calls.find((c) => c.kind === 'vocabLinks.create');
    expect(create.args[1]).toEqual(['w-2', 'w-3', 'w-4']);
    expect(doc.sentences[0].mwes[0].memberTokenIds).toEqual(['w-2', 'w-3', 'w-4']);
  });
});
