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
