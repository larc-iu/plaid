import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';
import { hasUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';

// Values put back into their cells after they were not saved (a refusal, or
// an edit queued behind one): what keeps them on screen, and what counts them
// as unsaved.

vi.mock('@/utils/feedback', () => ({
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
// its way, then type into another cell and leave focus there.
async function refuseFirst(doc, client, more) {
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
  await more();
  const c = [...host.querySelectorAll('[data-cell-key]')].find(
    (el) => !el.dataset.cellKey.startsWith('ma:'),
  );
  focus(c);
  type(c, 'CCC');
  await settle();
  hold();
  await settle(30);
  client.spans.create = create;
  return { a, c };
}

beforeEach(() => resetIds());
afterEach(() => {
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
    expect(hasUnsavedDraft()).toBe('An annotation you have typed');
    // A later render with the stored value unchanged keeps the question.
    await doc.updateMorphemeSpan('m-1', 'Gloss', 'PL', null);
    await settle();
    expect(hasUnsavedDraft()).toBe('An annotation you have typed');
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
    expect(hasUnsavedDraft()).toBe('An annotation you have typed');
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
