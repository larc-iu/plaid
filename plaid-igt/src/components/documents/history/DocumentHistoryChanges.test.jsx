import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { buildRawDoc, makeIgtDoc } from '@/domain/test-helpers.js';
import { DocumentHistoryChanges } from './DocumentHistoryChanges.jsx';
import { CHANGE_ROWS_CEILING, CHANGE_ROWS_PAGE } from './useChangeRows.js';

// A document's History entry, read as what it changed. Core gives the rows a
// page at a time (audit.changesPage, narrowed to the document and to each of
// its vocabularies), all of which are read before anything is drawn; the view
// places them in the document as of the entry's end and draws each sentence
// it changed, the lexicon entries, and the rest.

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

  it('draws a machine gloss beside a person’s in the same word as machine-made, replacing nothing', async () => {
    const morphemes = [
      { id: 'm-1', text: 'text-1', begin: 0, end: 3, precedence: 1, metadata: { form: 'th' } },
      { id: 'm-9', text: 'text-1', begin: 0, end: 3, precedence: 2, metadata: { form: 'e' } },
      { id: 'm-2', text: 'text-1', begin: 4, end: 7, precedence: 1, metadata: {} },
    ];
    const made = { id: 'g9', value: 'DEF', tokens: ['m-9'], metadata: MACHINE };
    const doc = after({
      morphemes,
      spans: { 'msl-0': [{ id: 'g1', value: 'DEM', tokens: ['m-1'], metadata: {} }, made] },
    });
    await mount(
      doc,
      clientOf({ document: [[{ kind: 'span', id: 'g9', layer: 'msl-0', after: made }]] }),
    );
    expect(count()).toBe('1 change, 0 replaced a person’s value');
    const cell = view.container.querySelector('tr[data-row="morph:Gloss"] td');
    const pieces = all(cell, '[data-piece]');
    expect(pieces.map((p) => p.dataset.piece)).toEqual(['m-1', 'm-9']);
    // The person's gloss as it was, plain, and the new one alone marked.
    expect(pieces[0].querySelector('[data-change]')).toBeNull();
    expect(pieces[0].textContent).toBe('DEM');
    expect(pieces[1].querySelector('[data-change]').dataset.change).toBe('added');
    expect(pieces[1].querySelector('.plaid-prov--machine').textContent).toBe('DEF');
    expect(pieces[1].textContent).toBe('-DEF');
    expect(cell.querySelector('del')).toBeNull();
    expect(view.container.querySelector('[data-replaced]')).toBeNull();
  });

  // REV-HD2-6
  it('shows a word segmented anew with its old morphemes struck on a line under the new', async () => {
    const morphemes = [
      {
        id: 'm-8',
        text: 'text-1',
        begin: 0,
        end: 3,
        precedence: 1,
        metadata: { form: 'th', ...MACHINE },
      },
      {
        id: 'm-9',
        text: 'text-1',
        begin: 0,
        end: 3,
        precedence: 2,
        metadata: { form: 'e', ...MACHINE },
      },
      { id: 'm-2', text: 'text-1', begin: 4, end: 7, precedence: 1, metadata: {} },
    ];
    const tok = (id, before, img) => ({
      kind: 'token',
      id,
      layer: 'morphL',
      text: 'text-1',
      ...(before ? { before: img } : { after: img }),
    });
    const client = clientOf({
      document: [
        [
          tok('m-1', true, {
            id: 'm-1',
            begin: 0,
            end: 3,
            precedence: 1,
            metadata: { form: 'the' },
          }),
          tok('m-8', false, morphemes[0]),
          tok('m-9', false, morphemes[1]),
          {
            kind: 'span',
            id: 'g1',
            layer: 'msl-0',
            before: { id: 'g1', value: 'the.DEF', tokens: ['m-1'], metadata: {} },
          },
        ],
      ],
    });
    await mount(after({ morphemes }), client);
    const cell = view.container.querySelector('tr[data-row="morphemes"] td');
    const [now, gone] = [...cell.firstElementChild.children];
    expect(now.textContent).toBe('th-e');
    expect(now.querySelector('del')).toBeNull();
    expect(gone.hasAttribute('data-gone')).toBe(true);
    expect(gone.querySelector('del').textContent).toBe('the');
    expect(gone.querySelector('[data-change]').dataset.change).toBe('replaced');
    const gloss = view.container.querySelector('tr[data-row="morph:Gloss"] td [data-gone] del');
    expect(gloss.textContent).toBe('the.DEF');
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
      // A text edit is a change, never a person's value replaced.
      expect.objectContaining({ change: 'changed', now: 'dog', was: 'cat' }),
      expect.objectContaining({ change: 'deleted', column: 'deleted', was: 'sat' }),
    ]);
    expect(count()).toBe('3 changes, 0 replaced a person’s value');
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

  it('counts another app’s change on a shared word, never "No changes to show."', async () => {
    const udSpan = (value) => ({ id: 'ud1', value, tokens: ['w-1'], metadata: {} });
    const client = clientOf({
      document: [
        [
          {
            kind: 'span',
            id: 'ud1',
            layer: 'ud-lemma',
            before: udSpan('cats'),
            after: udSpan('cat'),
          },
          {
            kind: 'span',
            id: 'g9',
            layer: 'msl-0',
            after: { id: 'g9', value: 'DEF', tokens: ['m-9'], metadata: MACHINE },
          },
        ],
      ],
    });
    await mount(after(), client);
    expect(text()).not.toContain('No changes to show.');
    expect(count()).toBe('2 changes, 0 replaced a person’s value');
    expect(sentences()).toHaveLength(0);
    expect(view.container.querySelector('[data-testid="changes-elsewhere"]').textContent).toBe(
      '1 change to other annotations1 change to annotations deleted later',
    );
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

  // A document of `n` one-morpheme words, `per` words to a sentence, each
  // morpheme glossed by a machine.
  const longDoc = (n, per = 1, prefix = '') => {
    const at = prefix.length;
    const words = Array.from({ length: n }, (_, i) => ({
      id: `w-${i}`,
      begin: at + i * 3,
      end: at + i * 3 + 2,
    }));
    const sentenceCount = Math.ceil(n / per);
    return after({
      body: prefix + Array.from({ length: n }, () => 'ab').join(' '),
      words,
      morphemes: words.map((w, i) => ({
        id: `m-${i}`,
        text: 'text-1',
        begin: w.begin,
        end: w.end,
        precedence: 1,
        metadata: {},
      })),
      sentences: Array.from({ length: sentenceCount }, (_, k) => ({
        id: `s-${k}`,
        begin: k === 0 ? 0 : words[k * per].begin,
        end: words[Math.min(n, (k + 1) * per) - 1].end,
      })),
      spans: {
        'msl-0': words.map((w, i) => ({
          id: `g-${i}`,
          value: 'X',
          tokens: [`m-${i}`],
          metadata: MACHINE,
        })),
      },
    });
  };
  const glossRow = (i) => ({
    kind: 'span',
    id: `g-${i}`,
    layer: 'msl-0',
    after: { id: `g-${i}`, value: 'X', tokens: [`m-${i}`], metadata: MACHINE },
  });
  const chunks = (rows, size) =>
    Array.from({ length: Math.ceil(rows.length / size) }, (_, k) =>
      rows.slice(k * size, (k + 1) * size),
    );

  it('reads every page before it draws, then draws the sentences 50 at a time', async () => {
    const client = clientOf({
      document: chunks(
        Array.from({ length: 120 }, (_, i) => glossRow(i)),
        100,
      ),
    });
    await mount(longDoc(120), client);
    expect(client.audit.changesPage).toHaveBeenCalledTimes(2);
    expect(client.audit.changesPage).toHaveBeenLastCalledWith('g1', {
      documentId: 'doc-1',
      limit: CHANGE_ROWS_PAGE,
      cursor: '1',
    });
    // The count is final, every row read.
    expect(count()).toBe('120 changes, 0 replaced a person’s value');
    expect(sentences()).toHaveLength(50);
    await click(button('Show more sentences'));
    expect(sentences()).toHaveLength(100);
    await click(button('Show more sentences'));
    expect(sentences()).toHaveLength(120);
    expect(button('Show more sentences')).toBeUndefined();
    expect(button('Show more changes')).toBeUndefined();
  });

  it('draws nothing while it reads, and says how many rows it has read', async () => {
    let release;
    const rest = new Promise((resolve) => {
      release = resolve;
    });
    const first = Array.from({ length: 100 }, (_, i) => glossRow(i));
    const changesPage = vi.fn(async (entryId, { cursor }) =>
      cursor ? rest : { entries: first, nextCursor: '1' },
    );
    await mount(longDoc(120), { audit: { changesPage } });
    expect(text()).toContain('Reading changes, 100 so far');
    expect(sentences()).toHaveLength(0);
    expect(count()).toBeUndefined();
    await view.step(async () => {
      release({
        entries: Array.from({ length: 20 }, (_, i) => glossRow(100 + i)),
        nextCursor: null,
      });
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(count()).toBe('120 changes, 0 replaced a person’s value');
  });

  // REV-HD-2: a text edit near the start writes the shifted tokens before
  // the text, so the first page holds no text row.
  it('shows a text edit near the start of a document of 2,000 tokens as the one change it is', async () => {
    const n = 2000;
    const doc = longDoc(n, 10, 'x');
    const shift = (id, layer, begin, end) => ({
      kind: 'token',
      id,
      layer,
      text: 'text-1',
      before: { id, begin: begin - 1, end: end - 1 },
      after: { id, begin, end },
    });
    const raw = doc.raw.textLayers[0].tokenLayers;
    const tokens = (id) => raw.find((l) => l.id === id).tokens;
    const rows = [
      // the first sentence grows by the x, the rest move
      {
        kind: 'token',
        id: 's-0',
        layer: 'sentL',
        text: 'text-1',
        before: { id: 's-0', begin: 0, end: tokens('sentL')[0].end - 1 },
        after: { id: 's-0', begin: 0, end: tokens('sentL')[0].end },
      },
      ...tokens('sentL')
        .slice(1)
        .map((t) => shift(t.id, 'sentL', t.begin, t.end)),
      ...tokens('wordL').map((t) => shift(t.id, 'wordL', t.begin, t.end)),
      ...tokens('morphL').map((t) => shift(t.id, 'morphL', t.begin, t.end)),
      {
        kind: 'text',
        id: 'text-1',
        layer: 'tl-1',
        before: { id: 'text-1', body: doc.raw.textLayers[0].text.body.slice(1) },
        after: { id: 'text-1', body: doc.raw.textLayers[0].text.body },
      },
    ];
    const client = clientOf({ document: chunks(rows, 1000) });
    await mount(doc, client);
    expect(client.audit.changesPage).toHaveBeenCalledTimes(Math.ceil(rows.length / 1000));
    expect(count()).toBe('1 change, 0 replaced a person’s value');
    expect(sentences()).toHaveLength(1);
    expect(sentences()[0].textContent).toContain('Sentence 1');
    expect(view.container.querySelector('[data-change]')).not.toBeNull();
    expect(view.container.querySelector('[data-replaced]')).toBeNull();
  });

  it('shows an import, read over two pages, as sentences added', async () => {
    const doc = after({
      spans: {
        'msl-0': [
          { id: 'g1', value: 'DEF', tokens: ['m-1'], metadata: {} },
          { id: 'g2', value: 'cat', tokens: ['m-2'], metadata: {} },
        ],
      },
    });
    const made = (kind, id, layer, img) => ({ kind, id, layer, text: 'text-1', after: img });
    const raw = doc.raw.textLayers[0];
    const tokenRows = raw.tokenLayers.flatMap((l) =>
      l.tokens.map((t) => made('token', t.id, l.id, t)),
    );
    // In core's order for an import: the text, then the tokens, then the
    // spans, the first page ending after the first word.
    const word = tokenRows.find((r) => r.id === 'w-1');
    const client = clientOf({
      document: [
        [{ kind: 'text', id: 'text-1', layer: 'tl-1', after: raw.text }, word],
        [
          ...tokenRows.filter((r) => r !== word),
          made('span', 'g1', 'msl-0', { id: 'g1', value: 'DEF', tokens: ['m-1'], metadata: {} }),
          made('span', 'g2', 'msl-0', { id: 'g2', value: 'cat', tokens: ['m-2'], metadata: {} }),
        ],
      ],
    });
    await mount(doc, client);
    const [s] = sentences();
    expect(sentences()).toHaveLength(1);
    expect(s.textContent).toContain('Added');
    const gloss = cellsOf('morph:Gloss');
    expect(gloss.map((c) => [c.change, c.now])).toEqual([
      ['added', 'DEF'],
      ['added', 'cat'],
    ]);
    expect(count()).toMatch(/, 0 replaced a person’s value$/);
  });

  const mountAt = async (client) => {
    view = await renderComponent(
      <MemoryRouter initialEntries={['/projects/proj-1/documents/doc-1?tab=analyze&history=g1']}>
        <DocumentHistoryChanges
          context={{
            client,
            projectId: 'proj-1',
            documentId: 'doc-1',
            pastEntry: { id: 'g1' },
            historySnapshot: after(),
          }}
        />
      </MemoryRouter>,
    );
    await view.step(async () => {
      for (let i = 0; i < 70; i++) await Promise.resolve();
    });
  };
  const fullPage = Array.from({ length: CHANGE_ROWS_PAGE }, (_, i) => glossRow(i));
  const fullPages = CHANGE_ROWS_CEILING / CHANGE_ROWS_PAGE;

  // REV-HD2-2 and -3: the ceiling is on rows read, and only a row beyond it
  // reaches it.
  it('says there are too many changes to show when a row lies beyond the ceiling', async () => {
    const client = clientOf({ document: Array.from({ length: fullPages + 1 }, () => fullPage) });
    await mountAt(client);
    expect(client.audit.changesPage).toHaveBeenCalledTimes(fullPages + 1);
    expect(count()).toBe('Too many changes to show here.');
    expect(sentences()).toHaveLength(0);
    const link = all(view.container, 'a').find((a) => a.textContent === 'Show document');
    expect(link.getAttribute('href')).toBe(
      '/projects/proj-1/documents/doc-1?tab=analyze&history=g1&historyView=document',
    );
  });

  it('draws an entry of exactly the ceiling, its last full page followed by none', async () => {
    const pages = [...Array.from({ length: fullPages }, () => fullPage), []];
    const client = clientOf({ document: pages });
    await mountAt(client);
    expect(client.audit.changesPage).toHaveBeenCalledTimes(fullPages + 1);
    expect(text()).not.toContain('Too many changes');
    expect(count()).toMatch(/ replaced a person’s value$/);
  });

  // REV-HD2-4
  it('says a refusal after rows were read, never "No changes to show."', async () => {
    const first = Array.from({ length: 3 }, (_, i) => glossRow(i));
    const changesPage = vi.fn(async (entryId, { cursor }) => {
      if (cursor) throw Object.assign(new Error('Forbidden'), { status: 403 });
      return { entries: first, nextCursor: '1' };
    });
    await mount(after(), { audit: { changesPage } });
    expect(view.container.querySelector('[data-tone="error"]')).not.toBeNull();
    expect(text()).not.toContain('No changes to show.');
    expect(count()).toBeUndefined();
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

  it('says a read that failed, and draws nothing from the rest', async () => {
    const made = { id: 'g1', value: 'DEF', tokens: ['m-1'], metadata: MACHINE };
    const client = clientOf({
      document: [[{ kind: 'span', id: 'g1', layer: 'msl-0', after: made }]],
      v1: () => Promise.reject(Object.assign(new Error('boom'), { status: 500 })),
    });
    await mount(after({ vocabularies: VOCAB, spans: { 'msl-0': [made] } }), client);
    expect(view.container.querySelector('[data-tone="error"]')).not.toBeNull();
    expect(sentences()).toHaveLength(0);
    expect(count()).toBeUndefined();
  });

  it('waits for the document as of the entry before reading', async () => {
    const client = clientOf({ document: [[]] });
    await mount(null, client);
    expect(text()).toContain('Loading changes…');
    expect(client.audit.changesPage).not.toHaveBeenCalled();
  });
});
