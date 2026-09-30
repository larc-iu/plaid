import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { expectIndexMatchesDom } from './editor/cellParity.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';
import { notifyError, notifyWarning } from '@/utils/feedback';
import { hasUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';

// A cell edit refused because another user changed the cell first (Luke's
// ruling Q1): the cell shows theirs, with "Yours: X · Enter to keep yours"
// under it. Enter writes yours over theirs, Escape or typing lets it go, and
// leaving the cell sends nothing. A toast names who changed it and to what.

vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

let host;
let editor;

// The document as another user left it: b glossed "the" as `value`.
const theirs = (value, spanId = 'span-b') => {
  const raw = buildRawDoc({});
  const layer = raw.textLayers[0].tokenLayers
    .flatMap((tl) => tl.spanLayers || [])
    .find((sl) => sl.id === 'msl-0');
  if (value != null) layer.spans.push({ id: spanId, tokens: ['m-1'], value });
  return raw;
};

function mount() {
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  client.documents.auditPage = async () => ({
    entries: [
      {
        user: { id: 'b@x.com', displayName: 'b' },
        ops: [{ type: 'span/create', description: 'Create span span-b' }],
      },
    ],
    nextCursor: null,
  });
  const doc = new IgtDocument({
    raw: buildRawDoc({}),
    project: { id: 'proj-1', vocabs: [], config: {}, maintainers: ['lead@x.com'], writers: [] },
    vocabularies: {},
    client,
    projectId: 'proj-1',
    user: { id: 'c@x.com' },
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  editor = new IgtEditor(host, doc, {});
  return { doc, client };
}

// Every span write refused as a conflict until `release()`, and the reload
// after it reads `served`.
const refuseWith = (client, served, status = 409) => {
  const spans = { ...client.spans };
  client.documents.get = async () => JSON.parse(JSON.stringify(served));
  for (const m of ['create', 'update', 'delete']) {
    client.spans[m] = async () => {
      throw Object.assign(new Error(`HTTP ${status} refused`), { status });
    };
  }
  return () => Object.assign(client.spans, spans);
};

const cell = (key) => host.querySelector(`[data-cell-key="${key}"]`);
const note = (key) =>
  cell(key)?.closest('.igt-cell__face')?.querySelector('.igt-field-conflict') ?? null;
const type = (el, value) => {
  el.value = value;
  el.setSelectionRange(value.length, value.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const key = (el, k, init = {}) =>
  el.dispatchEvent(
    new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }),
  );
const settle = async (n = 30) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
const writes = (client) =>
  client.calls.filter((c) => /^spans\.(create|update|delete)/.test(c.kind)).map((c) => c.args);

beforeEach(() => {
  resetIds();
  vi.mocked(notifyWarning).mockClear();
  vi.mocked(notifyError).mockClear();
});
afterEach(() => {
  // What the cell engine reads under each cell is what the grid drew there.
  expectIndexMatchesDom(editor);
  editor?.destroy();
  host?.remove();
  editor = null;
  host = null;
});

describe('a cell edit that lost to another user', () => {
  it('shows theirs with yours under it, and leaving the cell sends nothing', async () => {
    const { client } = mount();
    const restore = refuseWith(client, theirs('dog.PL'));
    const c = cell('ma:m-1:Gloss');
    c.focus();
    type(c, 'hound');
    c.blur();
    await settle();
    restore();

    expect(c.value).toBe('dog.PL');
    expect(c.classList.contains('igt-field--conflict')).toBe(true);
    expect(note('ma:m-1:Gloss')?.textContent).toBe('Yours: hound · Enter to keep yours');
    // Focus was nowhere, so the cell has it, to take Enter.
    expect(document.activeElement).toBe(c);
    c.blur();
    await settle();
    expect(writes(client)).toEqual([]);
    expect(notifyWarning).toHaveBeenCalledWith('b changed this to dog.PL.');
    // Nothing is asked on leaving.
    expect(hasUnsavedDraft()).toBe(null);
  });

  it('keeps yours on Enter, written over theirs', async () => {
    const { client } = mount();
    const restore = refuseWith(client, theirs('dog.PL'));
    const c = cell('ma:m-1:Gloss');
    c.focus();
    type(c, 'hound');
    c.blur();
    await settle();
    restore();

    c.focus();
    key(c, 'Enter');
    await settle();
    expect(writes(client)).toEqual([['span-b', 'hound']]);
    expect(note('ma:m-1:Gloss')).toBeNull();
  });

  it('lets yours go on Escape or when another value is typed', async () => {
    const { client } = mount();
    let restore = refuseWith(client, theirs('dog.PL'));
    const c = cell('ma:m-1:Gloss');
    c.focus();
    type(c, 'hound');
    c.blur();
    await settle();
    restore();
    c.focus();
    key(c, 'Escape');
    await settle();
    expect(note('ma:m-1:Gloss')).toBeNull();
    expect(c.value).toBe('dog.PL');
    expect(writes(client)).toEqual([]);

    restore = refuseWith(client, theirs('dog.SG'));
    c.focus();
    type(c, 'cur');
    c.blur();
    await settle();
    restore();
    expect(note('ma:m-1:Gloss')?.textContent).toContain('Yours: cur');
    c.focus();
    type(c, 'hound');
    await settle();
    expect(note('ma:m-1:Gloss')).toBeNull();
  });

  it('leaves focus in the cell the user moved on to, and says "(none)" for a value cleared', async () => {
    const { client } = mount();
    // The reload brings b's gloss; our edit had cleared the cell we saw
    // holding "DEF".
    const restore = refuseWith(client, theirs('the.DEF'));
    const c = cell('ma:m-1:Gloss');
    editor._cells.clear();
    c.focus();
    type(c, 'x');
    type(c, '');
    const other = cell('ma:m-2:Gloss');
    other.focus();
    await settle();
    restore();
    expect(document.activeElement).toBe(other);
    // Typed '' over '': nothing was sent for it.
    expect(note('ma:m-1:Gloss')).toBeNull();
  });

  it('goes when the stored value changes again', async () => {
    const { client, doc } = mount();
    const restore = refuseWith(client, theirs('dog.PL'));
    const c = cell('ma:m-1:Gloss');
    c.focus();
    type(c, 'hound');
    c.blur();
    await settle();
    restore();
    expect(note('ma:m-1:Gloss')).not.toBeNull();
    client.documents.get = async () => theirs('dog.PL2');
    await doc.reload();
    await settle();
    expect(c.value).toBe('dog.PL2');
    expect(note('ma:m-1:Gloss')).toBeNull();
  });

  it('names nobody when the log does not say who', async () => {
    const { client } = mount();
    client.documents.auditPage = async () => ({ entries: [], nextCursor: null });
    const restore = refuseWith(client, theirs('dog.PL'));
    const c = cell('ma:m-1:Gloss');
    c.focus();
    type(c, 'hound');
    c.blur();
    await settle();
    restore();
    expect(notifyWarning).toHaveBeenCalledWith('Someone changed this to dog.PL.');
  });
});

describe('who reports a conflict', () => {
  it('the cell alone, when the conflict is over this cell: the document raises nothing', async () => {
    const { client, doc } = mount();
    const errors = [];
    doc.onError = (msg) => errors.push(msg);
    const restore = refuseWith(client, theirs('dog.PL'));
    const c = cell('ma:m-1:Gloss');
    c.focus();
    type(c, 'hound');
    c.blur();
    await settle();
    restore();
    expect(errors).toEqual([]);
    expect(doc.error).toBe('');
    expect(notifyWarning).toHaveBeenCalledTimes(1);
  });

  it('the cell, as a failed update, when another change came first elsewhere', async () => {
    const { client } = mount();
    // Nothing changed under this cell: the value goes back to be sent again.
    const restore = refuseWith(client, theirs(null));
    const c = cell('ma:m-1:Gloss');
    const other = cell('ma:m-2:Gloss');
    c.focus();
    type(c, 'hound');
    other.focus();
    await settle();
    restore();
    expect(notifyWarning).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyError).mock.calls[0][1]).toBe('Failed to update Gloss');
    expect(editor._cells.unsentOf('ma:m-1:Gloss')).toBeTruthy();
  });
});

describe('a cell edit refused where sending again cannot mend it', () => {
  it('is not put back: the cell shows what is stored', async () => {
    const { client } = mount();
    const restore = refuseWith(client, theirs(null), 403);
    const c = cell('ma:m-1:Gloss');
    const other = cell('ma:m-2:Gloss');
    c.focus();
    type(c, 'hound');
    other.focus();
    await settle();
    restore();
    expect(c.value).toBe('');
    expect(editor._cells.unsentOf('ma:m-1:Gloss')).toBeNull();
    expect(note('ma:m-1:Gloss')).toBeNull();
    expect(hasUnsavedDraft()).toBe(null);
  });
});

describe('a value put back unsent (nobody else changed the cell)', () => {
  it('is marked, and the leave question names its cell', async () => {
    const { client } = mount();
    const restore = refuseWith(client, theirs(null));
    const c = cell('ma:m-1:Gloss');
    const other = cell('ma:m-2:Gloss');
    c.focus();
    type(c, 'hound');
    other.focus();
    await settle();
    restore();
    expect(c.value).toBe('hound');
    expect(c.classList.contains('igt-field--unsent')).toBe(true);
    expect(hasUnsavedDraft()).toBe('Gloss of morpheme "the" in sentence 1');
    // Taken up, it is an edit like any other, and loses the mark.
    c.focus();
    expect(c.classList.contains('igt-field--unsent')).toBe(false);
  });

  it("turns into a conflict when another user's value comes in over it", async () => {
    const { client, doc } = mount();
    const restore = refuseWith(client, theirs(null));
    const c = cell('ma:m-1:Gloss');
    const other = cell('ma:m-2:Gloss');
    c.focus();
    type(c, 'hound');
    other.focus();
    await settle();
    restore();
    expect(editor._cells.unsentOf('ma:m-1:Gloss')).toBeTruthy();
    client.documents.get = async () => theirs('dog.PL');
    await doc.reload();
    await settle();
    expect(c.value).toBe('dog.PL');
    expect(note('ma:m-1:Gloss')?.textContent).toBe('Yours: hound · Enter to keep yours');
    expect(document.activeElement).toBe(other);
    expect(notifyWarning).toHaveBeenCalledWith('b changed this to dog.PL.');
  });
});
