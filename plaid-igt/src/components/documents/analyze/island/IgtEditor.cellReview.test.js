import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { expectIndexMatchesDom } from './editor/cellParity.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';
import { notifyError, notifyWarning } from '@/utils/feedback';
import { KEPT_IN_CELL } from '@ui/lib/cellConflict.js';

// The review of the shared cell engine (REV-cell-engine F1, F3, F4): what a
// cell does when the document is read again while a value waits in it or
// has been taken up by focus, and what a refusal says for a cell not drawn.

vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

let host;
let editor;

function mount(raw = buildRawDoc({})) {
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  client.documents.auditPage = async () => ({
    entries: [{ user: { id: 'b@x.com', displayName: 'b' }, ops: [{ description: 'x' }] }],
    nextCursor: null,
  });
  const doc = new IgtDocument({
    raw,
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

// Every span write refused until `release()`, and the reload after it reads `served`.
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
const withGloss = (raw, morph, value, id = 'span-b') => {
  raw.textLayers[0].tokenLayers
    .flatMap((tl) => tl.spanLayers || [])
    .find((sl) => sl.id === 'msl-0')
    .spans.push({ id, tokens: [morph], value });
  return raw;
};

const cell = (key) => host.querySelector(`[data-cell-key="${key}"]`);
const note = (key) =>
  cell(key)?.closest('.igt-cell__face')?.querySelector('.igt-field-conflict') ?? null;
const type = (el, value) => {
  el.value = value;
  el.setSelectionRange(value.length, value.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
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
  expectIndexMatchesDom(editor);
  editor?.destroy();
  host?.remove();
  editor = null;
  host = null;
});

describe('a waiting value that turns into a conflict as its morpheme column shifts', () => {
  it('takes focus to its own cell, never to the morpheme drawn where it was', async () => {
    const two = () =>
      buildRawDoc({
        morphemes: [
          { id: 'm-1', begin: 0, end: 3, precedence: 1, metadata: { form: 'th' } },
          { id: 'm-5', begin: 0, end: 3, precedence: 2, metadata: { form: 'e' } },
          { id: 'm-2', begin: 4, end: 7, precedence: 1, metadata: {} },
        ],
      });
    const { client, doc } = mount(two());
    const restore = refuseWith(client, two(), 500);
    const c = cell('ma:m-5:Gloss');
    c.focus();
    type(c, 'hound');
    cell('ma:m-2:Gloss').focus();
    await settle();
    restore();
    expect(editor._cells.unsentOf('ma:m-5:Gloss')).toBeTruthy();
    document.activeElement.blur();
    // b splits "th" (a new morpheme m-8 before m-5) and glosses m-5 CAT.
    const served = withGloss(
      buildRawDoc({
        morphemes: [
          { id: 'm-1', begin: 0, end: 3, precedence: 1, metadata: { form: 't' } },
          { id: 'm-8', begin: 0, end: 3, precedence: 2, metadata: { form: 'h' } },
          { id: 'm-5', begin: 0, end: 3, precedence: 3, metadata: { form: 'e' } },
          { id: 'm-2', begin: 4, end: 7, precedence: 1, metadata: {} },
        ],
      }),
      'm-5',
      'CAT',
    );
    client.documents.get = async () => JSON.parse(JSON.stringify(served));
    await doc.reload();
    await settle();
    expect(note('ma:m-5:Gloss')?.textContent).toBe('Yours: hound · Enter to keep yours');
    const active = document.activeElement;
    expect(active?.dataset?.cellKey).toBe('ma:m-5:Gloss');
    expect(active.value).toBe('CAT');
    type(active, 'zzz');
    active.blur();
    await settle();
    expect(writes(client).filter(([, tokens]) => tokens?.[0] === 'm-8')).toEqual([]);
  });
});

describe('a value taken up by focus when another user stores the cell', () => {
  it('shows theirs with the note, and leaving sends nothing', async () => {
    const { client, doc } = mount();
    const restore = refuseWith(client, buildRawDoc({}), 500);
    const c = cell('ma:m-1:Gloss');
    c.focus();
    type(c, 'hound');
    cell('ma:m-2:Gloss').focus();
    await settle();
    restore();
    c.focus();
    expect(c.value).toBe('hound');
    client.documents.get = async () => withGloss(buildRawDoc({}), 'm-1', 'dog.PL');
    await doc.reload();
    await settle();
    expect(c.value).toBe('dog.PL');
    expect(note('ma:m-1:Gloss')?.textContent).toBe('Yours: hound · Enter to keep yours');
    const before = writes(client).length;
    c.blur();
    await settle();
    expect(writes(client).slice(before)).toEqual([]);
  });

  it('keeps newer typing, which leaving sends', async () => {
    const { client, doc } = mount();
    const restore = refuseWith(client, buildRawDoc({}), 500);
    const c = cell('ma:m-1:Gloss');
    c.focus();
    type(c, 'hound');
    cell('ma:m-2:Gloss').focus();
    await settle();
    restore();
    c.focus();
    type(c, 'hounds');
    client.documents.get = async () => withGloss(buildRawDoc({}), 'm-1', 'dog.PL');
    await doc.reload();
    await settle();
    expect(c.value).toBe('hounds');
    c.blur();
    await settle();
    expect(writes(client).at(-1)).toEqual(['span-b', 'hounds']);
  });
});

describe('a value refused while its page is not drawn', () => {
  let pageSize;
  beforeEach(() => {
    pageSize = IgtEditor.PAGE_SIZE;
    IgtEditor.PAGE_SIZE = 1;
  });
  afterEach(() => {
    IgtEditor.PAGE_SIZE = pageSize;
  });

  it('says the value is in its cell and not saved, as ud does', async () => {
    const raw = () =>
      buildRawDoc({
        sentences: [
          { id: 's-1', begin: 0, end: 3 },
          { id: 's-2', begin: 4, end: 7 },
        ],
      });
    const { client } = mount(raw());
    const create = client.spans.create;
    let release;
    client.documents.get = async () => JSON.parse(JSON.stringify(raw()));
    client.spans.create = async () => {
      client.spans.create = create;
      await new Promise((r) => (release = r));
      throw Object.assign(new Error('HTTP 409 refused'), { status: 409 });
    };
    const a = cell('ma:m-1:Gloss');
    a.focus();
    type(a, 'AAA');
    a.blur();
    editor._setPage(1);
    await settle();
    release();
    await settle();
    expect(editor._cells.unsentOf('ma:m-1:Gloss')).toBeTruthy();
    expect(notifyError).toHaveBeenCalledWith(KEPT_IN_CELL, 'Failed to update Gloss');
    expect(KEPT_IN_CELL).toBe('Changed elsewhere. Your value is in its cell, not saved.');
  });
});
