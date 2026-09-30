import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { expectIndexMatchesDom } from './editor/cellParity.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';
import { hasUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';

// Values put back into their cells after they were not saved: what keeps them
// on screen, and what counts them as unsaved.

vi.mock('@/utils/feedback', () => ({
  notifyWarning: vi.fn(),
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

let host;
let editor;

function mount() {
  const raw = buildRawDoc({});
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const doc = new IgtDocument({
    raw,
    project: { id: 'proj-1', vocabs: [], config: {}, maintainers: ['lead@x.com'], writers: [] },
    vocabularies: {},
    client,
    projectId: 'proj-1',
    user: null,
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  editor = new IgtEditor(host, doc, {});
  return { doc, client };
}

const cell = (key) => host.querySelector(`[data-cell-key="${key}"]`);
const focus = (el) => el.focus();
const type = (el, value) => {
  el.value = value;
  el.setSelectionRange(value.length, value.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

// Gloss a (refused once released), then the edits `more` makes while a is on
// its way, then type into another cell and leave focus there. The server
// refuses those too, each in its turn behind a's refusal.
async function refuseFirst(doc, client, more) {
  const before = JSON.parse(JSON.stringify(doc.raw));
  client.documents.get = async () => JSON.parse(JSON.stringify(before));
  const spans = { ...client.spans };
  let hold;
  let first = true;
  let refusing = true;
  for (const method of Object.keys(spans)) {
    client.spans[method] = async (...args) => {
      if (!refusing) return spans[method](...args);
      if (first) {
        first = false;
        await new Promise((r) => (hold = r));
      }
      throw new Error('refused');
    };
  }
  const a = cell('ma:m-1:Gloss');
  focus(a);
  type(a, 'AAA');
  await more();
  const c = [...host.querySelectorAll('[data-cell-key]')].find(
    (el) => !el.dataset.cellKey.startsWith('ma:'),
  );
  focus(c);
  type(c, 'CCC');
  await settle();
  hold();
  await settle(30);
  refusing = false;
  Object.assign(client.spans, spans);
  return { a, c };
}

beforeEach(() => resetIds());
afterEach(() => {
  // What the cell engine reads under each cell is what the grid drew there.
  expectIndexMatchesDom(editor);
  editor?.destroy();
  host?.remove();
  editor = null;
  host = null;
});

describe('a cell edited twice behind a refused edit', () => {
  it('keeps its last value through a later render', async () => {
    const { doc, client } = mount();
    const b = cell('ma:m-2:Gloss');
    await refuseFirst(doc, client, async () => {
      focus(b);
      type(b, 'x');
      focus(cell('ma:m-1:Gloss'));
      focus(b);
      type(b, 'xy');
    });
    expect(b.value).toBe('xy');
    // Another edit re-renders the grid.
    await doc.updateMorphemeSpan('m-1', 'Gloss', 'PL', null);
    await settle();
    expect(b.value).toBe('xy');
    // Escape takes it back to what the server holds.
    focus(b);
    expect(b.dataset.orig).toBe('');
  });
});

describe('the island asks before the tab closes', () => {
  it('while a value put back unsaved sits in a cell without focus', async () => {
    const { doc, client } = mount();
    const b = cell('ma:m-2:Gloss');
    const { c } = await refuseFirst(doc, client, async () => {
      focus(b);
      type(b, 'BBB');
    });
    expect(b.value).toBe('BBB');
    // Focus somewhere with nothing typed: only the values put back are unsaved.
    type(c, c.dataset.orig ?? '');
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });
});

describe('an in-app way out asks', () => {
  it('while a value put back unsaved sits in a cell without focus, until the cell is taken up again', async () => {
    const { doc, client } = mount();
    const b = cell('ma:m-2:Gloss');
    const { c } = await refuseFirst(doc, client, async () => {
      focus(b);
      type(b, 'BBB');
    });
    type(c, c.dataset.orig ?? '');
    expect(b.value).toBe('BBB');
    expect(hasUnsavedDraft()).toMatch(/^Gloss of morpheme "\w+" in sentence 1$/);
    // A later render with the stored value unchanged keeps the question.
    await doc.updateMorphemeSpan('m-1', 'Gloss', 'PL', null);
    await settle();
    expect(hasUnsavedDraft()).toMatch(/^Gloss of morpheme "\w+" in sentence 1$/);
    // Taken up again, leaving the cell sends it, so there is nothing to ask.
    focus(b);
    await settle();
    expect(hasUnsavedDraft()).toBe(null);
  });

  it('no longer once the island is gone', async () => {
    const { doc, client } = mount();
    const b = cell('ma:m-2:Gloss');
    const { c } = await refuseFirst(doc, client, async () => {
      focus(b);
      type(b, 'BBB');
    });
    type(c, c.dataset.orig ?? '');
    expect(hasUnsavedDraft()).toMatch(/^Gloss of morpheme "\w+" in sentence 1$/);
    editor.destroy();
    editor = null;
    expect(hasUnsavedDraft()).toBe(null);
  });
});

describe('a cell typed in again while its earlier edit waits behind a refusal', () => {
  it('keeps the newer text when the earlier edit comes back unsaved', async () => {
    const { doc, client } = mount();
    const b = cell('ma:m-2:Gloss');
    const before = JSON.parse(JSON.stringify(doc.raw));
    client.documents.get = async () => JSON.parse(JSON.stringify(before));
    const create = client.spans.create;
    let hold;
    let first = true;
    client.spans.create = async (...args) => {
      if (!first) return create(...args);
      first = false;
      await new Promise((r) => (hold = r));
      throw new Error('refused');
    };
    const a = cell('ma:m-1:Gloss');
    focus(a);
    type(a, 'AAA');
    focus(b);
    type(b, 'x');
    focus(a);
    focus(b);
    type(b, 'xyz');
    await settle();
    hold();
    await settle(30);
    client.spans.create = create;
    expect(document.activeElement).toBe(b);
    expect(b.value).toBe('xyz');
    // Leaving the cell sends it.
    b.blur();
    await settle(30);
    const gloss = doc.sentences[0].tokens.flatMap((t) => t.morphemes).find((m) => m.id === 'm-2')
      .annotations.Gloss;
    expect(gloss?.value).toBe('xyz');
  });
});

// The second edit of a cell depends on the first (it names the Gloss the first
// was making), so when the first is refused the second is refused too. The
// value put back by the first refusal is not newer typing: the second one's
// refusal puts ITS value back, the last one typed.
describe('a cell edited twice, both edits refused, with focus nowhere', () => {
  it('shows the last value typed', async () => {
    const { doc, client } = mount();
    const before = JSON.parse(JSON.stringify(doc.raw));
    client.documents.get = async () => JSON.parse(JSON.stringify(before));
    const spans = { ...client.spans };
    let hold;
    let first = true;
    for (const method of Object.keys(spans)) {
      client.spans[method] = async () => {
        if (first) {
          first = false;
          await new Promise((r) => (hold = r));
        }
        throw new Error('refused');
      };
    }
    const a = cell('ma:m-1:Gloss');
    const b = cell('ma:m-2:Gloss');
    focus(a);
    type(a, 'AAA');
    focus(b);
    focus(a);
    type(a, 'AAA2');
    focus(b);
    b.blur();
    await settle();
    hold();
    await settle(30);
    Object.assign(client.spans, spans);
    expect(cell('ma:m-1:Gloss').value).toBe('AAA2');
  });
});

// One sentence a page, so the two words are on two pages.
describe('a value put back unsaved, on a page the reader leaves', () => {
  let pageSize;
  beforeEach(() => {
    pageSize = IgtEditor.PAGE_SIZE;
    IgtEditor.PAGE_SIZE = 1;
  });
  afterEach(() => {
    IgtEditor.PAGE_SIZE = pageSize;
  });

  function mountPaged() {
    const raw = buildRawDoc({
      sentences: [
        { id: 's-1', begin: 0, end: 3 },
        { id: 's-2', begin: 4, end: 7 },
      ],
    });
    const client = makeFakeClient();
    client.query = async () => ({ results: [] });
    const doc = new IgtDocument({
      raw,
      project: { id: 'proj-1', vocabs: [], config: {}, maintainers: ['lead@x.com'], writers: [] },
      vocabularies: {},
      client,
      projectId: 'proj-1',
      user: null,
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    editor = new IgtEditor(host, doc, {});
    const before = JSON.parse(JSON.stringify(doc.raw));
    client.documents.get = async () => JSON.parse(JSON.stringify(before));
    const create = client.spans.create;
    let release;
    client.spans.create = async () => {
      client.spans.create = create;
      await new Promise((r) => (release = r));
      throw new Error('refused');
    };
    const refuse = async () => {
      await settle();
      release();
    };
    return { doc, refuse };
  }

  it('is still there, and still asked about, when the reader comes back to its page', async () => {
    const { refuse } = mountPaged();
    const a = cell('ma:m-1:Gloss');
    focus(a);
    type(a, 'AAA');
    // Typing somewhere else on the page, so the value goes back unfocused.
    const other = [...host.querySelectorAll('[data-cell-key]')].find((el) => el !== a);
    focus(other);
    type(other, 'x');
    await refuse();
    await settle(30);
    expect(cell('ma:m-1:Gloss').value).toBe('AAA');
    expect(document.activeElement).toBe(other);
    type(other, other.dataset.orig ?? '');
    // The pager's click takes focus off the cell first.
    other.blur();
    editor._setPage(1);
    await settle();
    expect(cell('ma:m-1:Gloss')).toBe(null);
    expect(hasUnsavedDraft()).toMatch(/^Gloss of morpheme "\w+" in sentence 1$/);
    editor._setPage(0);
    await settle();
    const back = cell('ma:m-1:Gloss');
    expect(back.value).toBe('AAA');
    expect(hasUnsavedDraft()).toMatch(/^Gloss of morpheme "\w+" in sentence 1$/);
    // Taken up again, it is measured against what the server holds.
    focus(back);
    await settle();
    expect(back.dataset.orig).toBe('');
    expect(hasUnsavedDraft()).toBe(null);
  });

  it('comes back when the refusal answers while the reader is on another page', async () => {
    const { refuse } = mountPaged();
    const a = cell('ma:m-1:Gloss');
    focus(a);
    type(a, 'AAA');
    a.blur();
    editor._setPage(1);
    await settle();
    await refuse();
    await settle(30);
    expect(hasUnsavedDraft()).toMatch(/^Gloss of morpheme "\w+" in sentence 1$/);
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    editor._setPage(0);
    await settle();
    expect(cell('ma:m-1:Gloss').value).toBe('AAA');
  });

  it('is not asked about once what it was typed into is gone from the document', async () => {
    const { doc, refuse } = mountPaged();
    const a = cell('ma:m-1:Gloss');
    focus(a);
    type(a, 'AAA');
    a.blur();
    editor._setPage(1);
    await settle();
    // The server's copy has other morphemes under the first word.
    const gone = JSON.parse(JSON.stringify(doc.raw).replaceAll('"m-1"', '"m-9"'));
    doc.client.documents.get = async () => JSON.parse(JSON.stringify(gone));
    await refuse();
    await settle(30);
    expect(hasUnsavedDraft()).toBe(null);
  });

  // Unified with plaid-ud (the cell engine reads the document, not the
  // cell): a refusal answering while the page is away, over a word someone
  // split meanwhile, is a conflict found at once and kept for its page, not a
  // "Not saved" toast with the value gone.
  it('is a conflict kept for its page when its word was re-cut while away', async () => {
    const { doc, refuse } = mountPaged();
    const a = cell('ma:m-1:Gloss');
    focus(a);
    type(a, 'AAA');
    a.blur();
    editor._setPage(1);
    await settle();
    const split = buildRawDoc({
      sentences: [
        { id: 's-1', begin: 0, end: 3 },
        { id: 's-2', begin: 4, end: 7 },
      ],
      words: [
        { id: 'w-1', begin: 0, end: 2 },
        { id: 'w-3', begin: 2, end: 3 },
        { id: 'w-2', begin: 4, end: 7 },
      ],
      morphemes: [
        { id: 'm-1', begin: 0, end: 2, precedence: 1, metadata: {} },
        { id: 'm-3', begin: 2, end: 3, precedence: 1, metadata: {} },
        { id: 'm-2', begin: 4, end: 7, precedence: 1, metadata: {} },
      ],
    });
    doc.client.documents.get = async () => JSON.parse(JSON.stringify(split));
    await refuse();
    await settle(30);
    expect(hasUnsavedDraft()).toBe(null);
    expect(editor._cells.conflictOf('ma:m-1:Gloss')).toMatchObject({
      typed: 'AAA',
      recut: { unit: 'word', text: 'th' },
    });
    editor._setPage(0);
    await settle();
    const back = cell('ma:m-1:Gloss');
    expect(back.value).toBe('');
    expect(back.closest('.igt-cell__face')?.querySelector('.igt-field-conflict')?.textContent).toBe(
      'Yours: AAA · Enter to keep yours',
    );
  });

  it('gives way when the stored value moved on while its page was away', async () => {
    const { doc, refuse } = mountPaged();
    const a = cell('ma:m-1:Gloss');
    focus(a);
    type(a, 'AAA');
    const other = [...host.querySelectorAll('[data-cell-key]')].find((el) => el !== a);
    focus(other);
    await refuse();
    await settle(30);
    other.blur();
    editor._setPage(1);
    await settle();
    await doc.updateMorphemeSpan('m-1', 'Gloss', 'OTHER', null);
    await settle();
    editor._setPage(0);
    await settle();
    expect(cell('ma:m-1:Gloss').value).toBe('OTHER');
    expect(hasUnsavedDraft()).toBe(null);
  });
});
