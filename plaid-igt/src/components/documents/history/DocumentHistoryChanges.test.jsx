import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { buildRawDoc, makeIgtDoc } from '@/domain/test-helpers.js';
import { DocumentHistoryChanges } from './DocumentHistoryChanges.jsx';
import { CHANGE_ROWS_PAGE } from './useChangeRows.js';

// A document's History entry, read as what it changed. Core gives the rows a
// page at a time (audit.changesPage, narrowed to the document and to each of
// its vocabularies); the view places them in the document as of the entry's
// end and draws each sentence it changed, the lexicon entries, and the rest.

const MACHINE = { prov: 'inferred', provSource: 'job:1' };

const VOCAB = {
  v1: {
    id: 'v1',
    name: 'Lexicon',
    config: { igt: { fields: { gloss: { inline: true } } } },
    items: [
      { id: 'i1', form: 'kai', metadata: { gloss: 'go' } },
      { id: 'i2', form: 'ka', metadata: { gloss: 'go' } },
    ],
    vocabLinks: [],
  },
};

// The document after the entry, with the given spans by layer id.
const after = ({ spans = {}, vocabularies = {}, ...opts } = {}) => {
  const raw = buildRawDoc(opts);
  for (const tkl of raw.textLayers[0].tokenLayers) {
    for (const sl of tkl.spanLayers) sl.spans = spans[sl.id] || [];
  }
  return makeIgtDoc({ raw, vocabularies });
};

// A client whose changes read answers `pages[key]`, a list of pages, `key`
// being "document" or the vocabulary's id; a function answer is called.
const clientOf = (pages) => {
  const changesPage = vi.fn(async (entryId, { documentId, vocabLayerId, cursor }) => {
    const key = documentId ? 'document' : vocabLayerId;
    const list = pages[key];
    if (typeof list === 'function') return list();
    const at = cursor ? Number(cursor) : 0;
    const page = (list || [])[at] || [];
    return { entries: page, nextCursor: list && at + 1 < list.length ? String(at + 1) : null };
  });
  return { audit: { changesPage } };
};

let view;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const mount = async (doc, client) => {
  view = await renderComponent(
    <MemoryRouter>
      <DocumentHistoryChanges
        context={{
          client,
          projectId: 'proj-1',
          documentId: 'doc-1',
          pastEntry: { id: 'g1', unit: true },
          historySnapshot: doc,
        }}
      />
    </MemoryRouter>,
  );
  await view.step(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
};

const text = () => view.container.textContent;
const count = () => view.container.querySelector('[data-testid="change-count"]')?.textContent;
const sentences = () => all(view.container, '[data-sentence]');
const cellsOf = (row) =>
  all(view.container, `tr[data-row="${row}"] td`).map((td) => ({
    change: td.querySelector('[data-change]')?.dataset.change ?? null,
    now: td.querySelector('[data-change] > span')?.textContent ?? td.textContent,
    was: td.querySelector('del')?.textContent ?? null,
    column: td.dataset.column,
  }));
const click = (el) =>
  view.step(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
const button = (label) => all(view.container, 'button').find((b) => b.textContent.includes(label));

describe('DocumentHistoryChanges', () => {
  it('shows a machine gloss over a blank as added and one over a person’s as replaced', async () => {
    const doc = after({
      spans: {
        'msl-0': [
          { id: 'g1', value: 'DEF', tokens: ['m-1'], metadata: MACHINE },
          { id: 'g2', value: 'cat.N', tokens: ['m-2'], metadata: MACHINE },
        ],
      },
    });
    const client = clientOf({
      document: [
        [
          {
            kind: 'span',
            id: 'g1',
            layer: 'msl-0',
            after: { id: 'g1', value: 'DEF', tokens: ['m-1'], metadata: MACHINE },
          },
          {
            kind: 'span',
            id: 'g2',
            layer: 'msl-0',
            before: { id: 'g2', value: 'cat', tokens: ['m-2'], metadata: {} },
            after: { id: 'g2', value: 'cat.N', tokens: ['m-2'], metadata: MACHINE },
          },
        ],
      ],
    });
    await mount(doc, client);
    expect(client.audit.changesPage).toHaveBeenCalledWith('g1', {
      documentId: 'doc-1',
      limit: CHANGE_ROWS_PAGE,
      cursor: undefined,
    });
    expect(count()).toBe('2 changes, 1 replaced a person’s value');
    expect(sentences()).toHaveLength(1);
    const gloss = cellsOf('morph:Gloss');
    expect(gloss[0]).toMatchObject({ change: 'added', was: null });
    expect(gloss[1]).toMatchObject({ change: 'replaced', was: 'cat' });
    // Whose each value is, in the grid's marks and words.
    const old = view.container.querySelector('[data-change="replaced"] del span');
    expect(old.className).toBe('');
    expect(old.title).toBe('a person’s');
    const made = view.container.querySelector('[data-change="added"] span span');
    expect(made.className).toContain('plaid-prov--machine');
    expect(made.title).toBe('machine-made');
    // The sentence is a link into the grid.
    expect(view.container.querySelector('[data-sentence] a').getAttribute('href')).toBe(
      '/projects/proj-1/documents/doc-1?tab=analyze&focusSentence=s-1',
    );
  });

  it('shows only the sentences where a person’s value went, on asking', async () => {
    const doc = after({
      body: 'ab cd',
      words: [
        { id: 'w-1', begin: 0, end: 2 },
        { id: 'w-2', begin: 3, end: 5 },
      ],
      morphemes: [
        { id: 'm-1', text: 'text-1', begin: 0, end: 2, precedence: 1, metadata: {} },
        { id: 'm-2', text: 'text-1', begin: 3, end: 5, precedence: 1, metadata: {} },
      ],
      sentences: [
        { id: 's-1', begin: 0, end: 2 },
        { id: 's-2', begin: 3, end: 5 },
      ],
      spans: {
        'msl-0': [
          { id: 'g1', value: 'A', tokens: ['m-1'], metadata: MACHINE },
          { id: 'g2', value: 'B', tokens: ['m-2'], metadata: MACHINE },
        ],
      },
    });
    const client = clientOf({
      document: [
        [
          {
            kind: 'span',
            id: 'g1',
            layer: 'msl-0',
            after: { id: 'g1', value: 'A', tokens: ['m-1'], metadata: MACHINE },
          },
          {
            kind: 'span',
            id: 'g2',
            layer: 'msl-0',
            before: { id: 'g2', value: 'b', tokens: ['m-2'], metadata: {} },
            after: { id: 'g2', value: 'B', tokens: ['m-2'], metadata: MACHINE },
          },
        ],
      ],
    });
    await mount(doc, client);
    expect(sentences().map((s) => s.dataset.sentence)).toEqual(['s-1', 's-2']);
    await click(button('A person’s value replaced'));
    expect(sentences().map((s) => s.dataset.sentence)).toEqual(['s-2']);
  });

  it('shows a deleted word, a deleted sentence and a text edit', async () => {
    const doc = after({
      body: 'the dog ran',
      words: [
        { id: 'w-1', begin: 0, end: 3 },
        { id: 'w-2', begin: 4, end: 7 },
      ],
      morphemes: [],
      sentences: [{ id: 's-1', begin: 0, end: 7 }],
    });
    const tok = (id, layer, begin, end) => ({
      kind: 'token',
      id,
      layer,
      text: 'text-1',
      before: { id, begin, end },
    });
    const client = clientOf({
      document: [
        [
          {
            kind: 'text',
            id: 'text-1',
            layer: 'tl-1',
            before: { id: 'text-1', body: 'the cat sat ran' },
            after: { id: 'text-1', body: 'the dog ran' },
          },
          {
            kind: 'token',
            id: 's-1',
            layer: 'sentL',
            text: 'text-1',
            before: { id: 's-1', begin: 0, end: 11 },
            after: { id: 's-1', begin: 0, end: 7 },
          },
          tok('w-3', 'wordL', 8, 11),
          tok('s-2', 'sentL', 12, 15),
          tok('w-4', 'wordL', 12, 15),
        ],
      ],
    });
    await mount(doc, client);
    const [first, second] = sentences();
    expect(first.textContent).toContain('Sentence 1');
    expect(second.textContent).toContain('Sentence 2');
    expect(second.textContent).toContain('Deleted');
    const surface = cellsOf('surface');
    expect(surface.slice(0, 3)).toEqual([
      expect.objectContaining({ change: null, now: 'the' }),
      expect.objectContaining({ change: 'replaced', now: 'dog', was: 'cat' }),
      expect.objectContaining({ change: 'replaced', column: 'deleted', was: 'sat' }),
    ]);
    expect(first.textContent).toContain('Text');
    // The deleted sentence links nowhere: it is not in the document.
    expect(second.querySelector('a')).toBeNull();
  });

  it('lists the lexicon entries the entry made, changed and merged, each a link', async () => {
    const doc = after({ vocabularies: VOCAB });
    const client = clientOf({
      document: [[]],
      v1: [
        [
          {
            kind: 'vocab-item',
            id: 'i1',
            vocabLayer: 'v1',
            before: { id: 'i1', form: 'kai', metadata: { gloss: 'walk' } },
            after: { id: 'i1', form: 'kai', metadata: { gloss: 'go' } },
          },
          {
            kind: 'vocab-item',
            id: 'i2',
            vocabLayer: 'v1',
            after: { id: 'i2', form: 'ka', metadata: { gloss: 'go' } },
            changedSince: true,
          },
          {
            kind: 'vocab-item',
            id: 'i3',
            vocabLayer: 'v1',
            before: { id: 'i3', form: 'ko', metadata: {} },
          },
        ],
      ],
    });
    await mount(doc, client);
    expect(client.audit.changesPage).toHaveBeenCalledWith('g1', {
      vocabLayerId: 'v1',
      limit: CHANGE_ROWS_PAGE,
      cursor: undefined,
    });
    expect(count()).toBe('3 changes, 0 replaced a person’s value');
    const entries = all(view.container, '[data-entry]');
    expect(entries.map((e) => e.querySelector('a').getAttribute('href'))).toEqual([
      '/vocabularies/v1?item=i1',
      '/vocabularies/v1?item=i2',
      // Gone, so its vocabulary's History at this entry.
      '/vocabularies/v1?history=g1',
    ]);
    const heads = entries.map((e) =>
      [...e.querySelector('div').children].map((c) => c.textContent).join(' '),
    );
    expect(heads).toEqual(['kai Changed', 'ka Added Changed again later', 'ko Deleted']);
    expect(entries[0].querySelector('dd del').textContent).toBe('walk');
  });

  it('says what changed the document’s name and outside the sentences', async () => {
    const doc = after({ alignmentTokens: [{ id: 'a1', text: 'text-1', begin: 0, end: 7 }] });
    const client = clientOf({
      document: [
        [
          {
            kind: 'document',
            id: 'doc-1',
            before: { name: 'Text', metadata: {} },
            after: { name: 'Text 1', metadata: {} },
          },
          {
            kind: 'token',
            id: 'a1',
            layer: 'alignL',
            text: 'text-1',
            after: { id: 'a1', begin: 0, end: 7 },
          },
        ],
      ],
    });
    await mount(doc, client);
    expect(sentences()).toHaveLength(0);
    expect(text()).toContain('Name');
    expect(view.container.querySelector('dd del').textContent).toBe('Text');
    expect(text()).toContain('1 change to transcript segments');
  });

  it('lays a right-to-left document’s columns out from the right', async () => {
    const doc = after({
      body: 'שלום עולם',
      words: [
        { id: 'w-1', begin: 0, end: 4 },
        { id: 'w-2', begin: 5, end: 9 },
      ],
    });
    const client = clientOf({
      document: [
        [
          {
            kind: 'span',
            id: 'g1',
            layer: 'msl-0',
            after: { id: 'g1', value: 'peace', tokens: ['m-1'], metadata: {} },
          },
        ],
      ],
    });
    doc.raw.textLayers[0].tokenLayers.find((l) => l.id === 'morphL').spanLayers[0].spans = [
      { id: 'g1', value: 'peace', tokens: ['m-1'], metadata: {} },
    ];
    await mount(doc, client);
    expect(doc.textDirection).toBe('rtl');
    expect(view.container.querySelector('[data-sentence] table').getAttribute('dir')).toBe('rtl');
    // A value takes its own direction.
    expect(view.container.querySelector('[data-sentence] td').getAttribute('dir')).toBe('auto');
  });

  it('shows the first page of a huge entry and reads the next on asking', async () => {
    const n = 600;
    const words = Array.from({ length: n }, (_, i) => ({
      id: `w-${i}`,
      begin: i * 3,
      end: i * 3 + 2,
    }));
    const body = Array.from({ length: n }, () => 'ab').join(' ');
    const doc = after({
      body,
      words,
      morphemes: words.map((w, i) => ({
        id: `m-${i}`,
        text: 'text-1',
        begin: w.begin,
        end: w.end,
        precedence: 1,
        metadata: {},
      })),
      sentences: words.map((w, i) => ({ id: `s-${i}`, begin: w.begin, end: w.end })),
      spans: {
        'msl-0': words.map((w, i) => ({
          id: `g-${i}`,
          value: 'X',
          tokens: [`m-${i}`],
          metadata: MACHINE,
        })),
      },
    });
    const row = (i) => ({
      kind: 'span',
      id: `g-${i}`,
      layer: 'msl-0',
      after: { id: `g-${i}`, value: 'X', tokens: [`m-${i}`], metadata: MACHINE },
    });
    const pages = [
      Array.from({ length: 500 }, (_, i) => row(i)),
      Array.from({ length: 100 }, (_, i) => row(500 + i)),
    ];
    const client = clientOf({ document: pages });
    await mount(doc, client);
    // One read before the first paint, not every page.
    expect(client.audit.changesPage).toHaveBeenCalledTimes(1);
    expect(sentences()).toHaveLength(500);
    expect(count()).toBe('500 changes so far, 0 replaced a person’s value');
    await click(button('Show more changes'));
    await view.step(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(client.audit.changesPage).toHaveBeenLastCalledWith('g1', {
      documentId: 'doc-1',
      limit: CHANGE_ROWS_PAGE,
      cursor: '1',
    });
    expect(sentences()).toHaveLength(600);
    expect(count()).toBe('600 changes, 0 replaced a person’s value');
    expect(button('Show more changes')).toBeUndefined();
  });

  it('shows what a reader may read when a vocabulary’s rows are refused', async () => {
    const doc = after({
      vocabularies: VOCAB,
      spans: { 'msl-0': [{ id: 'g1', value: 'DEF', tokens: ['m-1'], metadata: MACHINE }] },
    });
    const client = clientOf({
      document: [
        [
          {
            kind: 'span',
            id: 'g1',
            layer: 'msl-0',
            after: { id: 'g1', value: 'DEF', tokens: ['m-1'], metadata: MACHINE },
          },
        ],
      ],
      v1: () => Promise.reject(Object.assign(new Error('Forbidden'), { status: 403 })),
    });
    await mount(doc, client);
    expect(sentences()).toHaveLength(1);
    expect(view.container.querySelector('[data-tone="error"]')).toBeNull();
    expect(text()).not.toContain('Lexicon');
    // Nothing on the view writes: a reader sees what anyone sees.
    expect(all(view.container, 'input, textarea')).toHaveLength(0);
  });

  it('says so when the entry changed nothing it can show', async () => {
    await mount(after(), clientOf({ document: [[]] }));
    expect(text()).toContain('No changes to show.');
    expect(count()).toBeUndefined();
  });

  it('says a read that failed, and shows the rest', async () => {
    const client = clientOf({
      document: () => Promise.reject(Object.assign(new Error('boom'), { status: 500 })),
    });
    await mount(after(), client);
    expect(view.container.querySelector('[data-tone="error"]')).not.toBeNull();
  });

  it('waits for the document as of the entry before reading', async () => {
    const client = clientOf({ document: [[]] });
    await mount(null, client);
    expect(text()).toContain('Loading changes…');
    expect(client.audit.changesPage).not.toHaveBeenCalled();
  });
});
