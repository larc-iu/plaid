// Who may add an entry from the Analyze popover (acl-shared-vocab-writers b,
// and Luke's answer to FIX-R-CREATE Q1): anyone who can write the document,
// for a word and for a multi-word expression. Changing a linked entry's type
// stays with the vocabulary's maintainers.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildRawDoc,
  makeFakeClient,
  resetIds,
  makeIgtDoc,
  settle,
  mountIsland,
} from '@/domain/test-helpers.js';

vi.mock('@/utils/feedback', () => ({
  notifyWarning: vi.fn(),
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

let host;
let editor;

// "the cat sat down", the word "cat" linked, and a writer who does not
// maintain the lexicon.
function mount(text = null) {
  const raw = buildRawDoc(
    text ?? {
      body: 'the cat sat down',
      words: [
        { id: 'w-1', begin: 0, end: 3 },
        { id: 'w-2', begin: 4, end: 7 },
        { id: 'w-3', begin: 8, end: 11 },
        { id: 'w-4', begin: 12, end: 16 },
      ],
    },
  );
  // Punctuation is ignored, as setup makes a project.
  const wordLayer = raw.textLayers[0].tokenLayers.find((l) => l.id === 'wordL');
  wordLayer.config.plaid.ignoredTokens = { type: 'unicodePunctuation', whitelist: [] };
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const doc = makeIgtDoc({
    raw,
    project: { id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {} } },
    vocabularies: {
      v1: {
        id: 'v1',
        name: 'Lexicon',
        maintainers: ['mara@example.com'],
        items: [{ id: 'i-cat', form: 'cat', metadata: { morphType: 'stem' } }],
        vocabLinks: [{ id: 'lk-cat', tokens: ['m-2'], vocabItem: { id: 'i-cat', form: 'cat' } }],
      },
    },
    client,
    user: { id: 'wren@example.com' },
  });
  client.documents.get = async () => doc.raw;
  ({ host, editor } = mountIsland(doc, { canManageVocab: () => false }));
  return { doc, client };
}

const popover = () => host.querySelector('.igt-vocab-pop');
const form = (wordId) => host.querySelector(`[data-word-col="${wordId}"] .igt-token-form`);
const label = (key) => host.querySelector(`button.igt-mwe__label[data-vocab-opener="${key}"]`);
const click = (el, init = {}) =>
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
const key = (el, k, init = {}) =>
  el.dispatchEvent(
    new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }),
  );
const openOn = (tokenId) => click(host.querySelector(`button[data-vocab-opener="${tokenId}"]`));

beforeEach(() => resetIds());
afterEach(() => {
  editor?.destroy();
  host?.remove();
  editor = null;
  host = null;
});

// Luke 2026-11-10: the row reads "+" and the form. The verb is kept for a
// screen reader, which the mark alone would not tell what the row does.
describe('the create row', () => {
  const shown = (el) =>
    [...el.childNodes]
      .filter((n) => n.nodeType === 3 || (n.nodeType === 1 && !n.matches('.igt-sr-only')))
      .map((n) => n.textContent)
      .join('')
      .replace(/\s+/g, ' ')
      .trim();

  it('reads "+" and the form, with the verb for a screen reader only', () => {
    mount();
    openOn('m-1');
    const create = popover().querySelector('.igt-vocab-pop__create');
    expect(shown(create)).toBe('+ “the”');
    expect(create.querySelector('.igt-sr-only').textContent).toBe('Create');
    expect(create.querySelector('[aria-hidden="true"]').textContent).toBe('+');
  });

  it('keeps "+" as the button beside the form while the form is edited', async () => {
    mount();
    openOn('m-1');
    click(popover().querySelector('.igt-vocab-pop__create'));
    await new Promise((r) => setTimeout(r, 300));
    const go = popover().querySelector('.igt-vocab-pop__create-go');
    expect(shown(go)).toBe('+');
    expect(go.querySelector('.igt-sr-only').textContent).toBe('Create');
  });
});

describe('a writer who does not maintain the lexicon', () => {
  it('is offered "+ Create" on a word, and it makes and links the entry', async () => {
    const { doc, client } = mount();
    openOn('m-1');
    const create = popover().querySelector('.igt-vocab-pop__create');
    expect(create).not.toBeNull();
    expect(create.textContent).toContain('“the”');
    click(create);
    click(popover().querySelector('.igt-vocab-pop__create'));
    await settle(4);
    const made = client.calls.find((c) => c.kind === 'vocabItems.create');
    expect(made.args.slice(0, 2)).toEqual(['v1', 'the']);
    const link = client.calls.find((c) => c.kind === 'vocabLinks.create');
    expect(link.args[1]).toEqual(['m-1']);
    expect(doc.vocabularies.v1.vocabLinks.some((l) => l.vocabItem.form === 'the')).toBe(true);
  });

  // H5-3: the form box sat inside the create row's <button>, so a Space typed
  // in it activated the button, whose click created the entry from what was
  // typed so far ("lei" of "lei re"). A browser activates the nearest button
  // around a focused box, so no box in the popover may have one.
  it('takes a form with a space, and no box in the popover sits inside a button', async () => {
    const { client } = mount();
    openOn('m-1');
    click(popover().querySelector('.igt-vocab-pop__create'));
    await new Promise((r) => setTimeout(r, 300));
    const input = popover().querySelector('.igt-vocab-pop__create-input');
    expect(input).not.toBeNull();
    input.value = 'lei re';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    for (const box of popover().querySelectorAll('input, select, textarea')) {
      expect(box.closest('button, [role="button"]')).toBeNull();
    }
    expect(client.calls.some((c) => c.kind === 'vocabItems.create')).toBe(false);
    click(popover().querySelector('.igt-vocab-pop__create-go'));
    await settle(4);
    const made = client.calls.find((c) => c.kind === 'vocabItems.create');
    expect(made.args.slice(0, 2)).toEqual(['v1', 'lei re']);
  });

  it('puts no box inside a button on a word or an expression either', async () => {
    mount();
    for (const open of [
      () => openOn('w-1'),
      () => {
        click(form('w-3'), { shiftKey: true });
        click(form('w-4'), { shiftKey: true });
        key(label('mwe:new'), 'Enter');
      },
    ]) {
      open();
      click(popover().querySelector('.igt-vocab-pop__create'));
      await new Promise((r) => setTimeout(r, 300));
      expect(popover().querySelector('.igt-vocab-pop__create-input')).not.toBeNull();
      for (const box of popover().querySelectorAll('input, select, textarea')) {
        expect(box.closest('button, [role="button"]')).toBeNull();
      }
      key(popover().querySelector('.igt-vocab-pop__search'), 'Escape');
    }
  });

  // H5-2: a word's values in fields that name a lexicon field go into the
  // entry made from it, as a morpheme's gloss does (IgtEditor.pairPicker).
  it('gives the entry made from a word the values its cells hold', async () => {
    const raw = buildRawDoc({
      body: 'the cat',
      words: [
        { id: 'w-1', begin: 0, end: 3 },
        { id: 'w-2', begin: 4, end: 7 },
      ],
      lexiconFields: { 'Word:POS': 'pos' },
    });
    const pos = raw.textLayers[0].tokenLayers
      .flatMap((l) => l.spanLayers || [])
      .find((l) => l.id === 'wsl-0');
    pos.spans.push({ id: 'sp-pos', tokens: ['w-1'], value: 'DET', metadata: {} });
    const client = makeFakeClient();
    client.query = async () => ({ results: [] });
    const doc = makeIgtDoc({
      raw,
      project: { id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {} } },
      vocabularies: { v1: { id: 'v1', name: 'Lexicon', items: [], vocabLinks: [] } },
      client,
      user: { id: 'wren@example.com' },
    });
    client.documents.get = async () => doc.raw;
    ({ host, editor } = mountIsland(doc, { canManageVocab: () => false }));
    openOn('w-1');
    click(popover().querySelector('.igt-vocab-pop__create'));
    click(popover().querySelector('.igt-vocab-pop__create'));
    await settle(4);
    const made = client.calls.find((c) => c.kind === 'vocabItems.create');
    expect(made.args.slice(0, 3)).toEqual(['v1', 'the', { pos: 'DET' }]);
  });

  it('is offered "+ Create" for a multi-word expression', () => {
    mount();
    click(form('w-3'), { shiftKey: true });
    click(form('w-4'), { shiftKey: true });
    key(label('mwe:new'), 'Enter');
    const create = popover().querySelector('.igt-vocab-pop__create');
    expect(create).not.toBeNull();
    expect(create.textContent).toContain('“sat down”');
  });

  it('cannot change the type of a linked entry', () => {
    mount();
    openOn('m-2');
    const type = popover().querySelector('.igt-vocab-pop__type select');
    expect(type).not.toBeNull();
    expect(type.disabled).toBe(true);
  });
});

describe('the type row of a morpheme linked to an untyped entry', () => {
  // A linked morpheme goes by its entry's type, else its own, as the grid
  // joins it. The row shows the one it goes by.
  it('shows the type the morpheme holds', async () => {
    const raw = buildRawDoc({
      body: 'kari',
      words: [{ id: 'w-1', begin: 0, end: 4 }],
      morphemes: [
        { id: 'm-1', begin: 0, end: 4, precedence: 1, metadata: { form: 'ka' } },
        {
          id: 'm-2',
          begin: 0,
          end: 4,
          precedence: 2,
          metadata: { form: 'ri', morphType: 'enclitic' },
        },
      ],
    });
    const client = makeFakeClient();
    client.query = async () => ({ results: [] });
    const doc = makeIgtDoc({
      raw,
      project: { id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {} } },
      vocabularies: {
        v1: {
          id: 'v1',
          name: 'Lexicon',
          maintainers: ['wren@example.com'],
          items: [{ id: 'i-ri', form: 'ri', metadata: {} }],
          vocabLinks: [{ id: 'lk-ri', tokens: ['m-2'], vocabItem: { id: 'i-ri', form: 'ri' } }],
        },
      },
      client,
      user: { id: 'wren@example.com' },
    });
    client.documents.get = async () => doc.raw;
    ({ host, editor } = mountIsland(doc, { canManageVocab: () => true }));
    openOn('m-2');
    const row = popover().querySelector('.igt-vocab-pop__type');
    expect(row.querySelector('option[selected]').value).toBe('enclitic');
    expect(row.querySelector('span').textContent).toBe('Type');
  });
});

describe('the lexicon popover', () => {
  // H5-1: on a form no entry is spelled like, the list starts on "+ Create",
  // not on the entry nearest by edit distance, so Enter cannot link a word to
  // an unrelated entry ("thei" to "na").
  it('starts on "+ Create" when no entry matches the form, and Enter links nothing', async () => {
    const { client } = mount();
    openOn('w-1');
    const pop = popover();
    expect([...pop.querySelectorAll('.igt-vocab-pop__item')].length).toBeGreaterThan(0);
    expect(pop.querySelector('.igt-vocab-pop__item.is-active')).toBeNull();
    expect(pop.querySelector('.igt-vocab-pop__create').classList).toContain('is-active');
    key(pop.querySelector('.igt-vocab-pop__search'), 'Enter');
    await settle(4);
    expect(client.calls.some((c) => c.kind === 'vocabLinks.create')).toBe(false);
    expect(popover().querySelector('.igt-vocab-pop__create-input')).not.toBeNull();
  });

  it('starts on an entry spelled like the word', () => {
    mount();
    openOn('w-2');
    expect(popover().querySelector('.igt-vocab-pop__item.is-active')).not.toBeNull();
  });

  // REV-FX-A-3: a word that keeps edge punctuation (an imported "cat.") is
  // spelled like the entry its "+ Create" would duplicate.
  it('starts on the entry a word with edge punctuation is spelled like', () => {
    mount({
      body: 'a the cat.',
      words: [
        { id: 'w-1', begin: 0, end: 1 },
        { id: 'w-2', begin: 2, end: 5 },
        { id: 'w-3', begin: 6, end: 10 },
      ],
    });
    openOn('w-3');
    const active = popover().querySelector('.igt-vocab-pop__item.is-active');
    expect(active?.textContent).toContain('cat');
    expect(popover().querySelector('.igt-vocab-pop__create')?.classList.contains('is-active')).toBe(
      false,
    );
  });

  it('reads the lexicon again when it opens, so an entry added elsewhere since the page loaded is offered', async () => {
    const { doc, client } = mount();
    // Another person added "sat" after this page loaded.
    const fresh = {
      id: 'v1',
      name: 'Lexicon',
      maintainers: ['mara@example.com'],
      timeModified: 2,
      items: [
        { id: 'i-cat', form: 'cat', metadata: { morphType: 'stem' } },
        { id: 'i-sat', form: 'sat', metadata: { morphType: 'stem' } },
      ],
    };
    client.vocabLayers = { get: async () => fresh };
    const forms = () =>
      [...popover().querySelectorAll('.igt-vocab-pop__item .igt-vocab-pop__form')].map((el) =>
        el.textContent.trim(),
      );
    openOn('m-3');
    expect(forms()).not.toContain('sat');
    await settle(4);
    expect(doc.vocabularies.v1.items.map((it) => it.form)).toContain('sat');
    expect(forms()).toContain('sat');
    // The link made from the popover's best row is to the entry that exists.
    key(popover().querySelector('.igt-vocab-pop__search'), 'Enter');
    await settle(4);
    const link = client.calls.find((c) => c.kind === 'vocabLinks.create');
    expect(link.args.slice(0, 2)).toEqual(['i-sat', ['m-3']]);
    expect(client.calls.some((c) => c.kind === 'vocabItems.create')).toBe(false);
  });

  it('opened while an older read is out that brings nothing back, reads once more', async () => {
    const { doc, client } = mount();
    let open;
    const gate = new Promise((r) => (open = r));
    let reads = 0;
    const fresh = {
      id: 'v1',
      name: 'Lexicon',
      maintainers: ['mara@example.com'],
      timeModified: 2,
      items: [
        { id: 'i-cat', form: 'cat', metadata: { morphType: 'stem' } },
        { id: 'i-sat', form: 'sat', metadata: { morphType: 'stem' } },
      ],
    };
    // The first read answers with no entries (a stub), and only after the
    // popover opened. Reads after it have "sat".
    client.vocabLayers = {
      get: async (_id, withItems) => {
        if (!withItems) {
          if (reads === 0) await gate;
          return { id: 'v1', timeModified: reads + 1 };
        }
        reads += 1;
        return reads === 1 ? null : fresh;
      },
    };
    const forms = () =>
      [...popover().querySelectorAll('.igt-vocab-pop__item .igt-vocab-pop__form')].map((el) =>
        el.textContent.trim(),
      );
    // A read started before the popover (the tab came back).
    editor._refreshVocabularies();
    openOn('m-3');
    open();
    await settle(4);
    expect(reads).toBe(2);
    expect(doc.vocabularies.v1.items.map((it) => it.form)).toContain('sat');
    expect(forms()).toContain('sat');
  });
});
