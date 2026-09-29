import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';
import { notifyError } from '@/utils/feedback';

// A morpheme column is drawn by its position in the word, so a refetch that
// brings in another writer's morphemes can hand the input someone is typing
// into to a different morpheme. What was typed is never written to that one.

vi.mock('@/utils/feedback', () => ({
  notifyWarning: vi.fn(),
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

let host;
let editor;

const morph = (id, precedence, form) => ({
  id,
  text: 'text-1',
  begin: 0,
  end: 3,
  precedence,
  metadata: form == null ? {} : { form },
});

// `served` is what the server answers every read with from here on: the
// document as another writer left it.
function mount(morphemes) {
  const raw = buildRawDoc({ morphemes });
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
  const serve = (ms) => {
    client.documents.get = async () => buildRawDoc({ morphemes: ms });
  };
  return { doc, client, serve };
}

const cell = (key) => host.querySelector(`[data-cell-key="${key}"]`);
const type = (el, value) => {
  el.value = value;
  el.setSelectionRange(value.length, value.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const key = (el, k) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const settle = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
const writes = (client) =>
  client.calls.filter((c) => /^(spans|tokens)\.(create|update|patchMetadata)/.test(c.kind));

beforeEach(() => {
  resetIds();
  vi.mocked(notifyError).mockClear();
});
afterEach(() => {
  editor?.destroy();
  host?.remove();
  editor = null;
  host = null;
});

describe('a gloss being typed when a refetch puts another morpheme in its column', () => {
  it('is not written to that morpheme, and the cell shows what that one holds', async () => {
    const { doc, client, serve } = mount([morph('m-1', 1, 'th'), morph('m-2', 2, 'e')]);
    const c = cell('ma:m-2:Gloss');
    c.focus();
    type(c, 'PST');
    // Meanwhile m-2 was merged away and the word split again elsewhere.
    serve([morph('m-1', 1, 'th'), morph('m-9', 2, 'he')]);
    await doc.reload();
    await settle();

    expect(c.dataset.cellKey).toBe('ma:m-9:Gloss');
    expect(c.value).toBe('');
    // Focus leaves the input, so the next keystroke cannot go onto m-9.
    expect(document.activeElement).not.toBe(c);
    c.focus();
    c.blur();
    await settle();
    expect(writes(client)).toHaveLength(0);
    // Its morpheme is gone, so what was typed has nowhere to go: said, once.
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(notifyError).mock.calls[0][0])).toContain('PST');
  });

  it('goes back unsent into its own morpheme when that one moved', async () => {
    const { doc, client, serve } = mount([morph('m-1', 1, 'th'), morph('m-2', 2, 'e')]);
    const c = cell('ma:m-2:Gloss');
    c.focus();
    type(c, 'PST');
    // Another writer put a morpheme in front of m-2.
    serve([morph('m-1', 1, 't'), morph('m-9', 2, 'h'), morph('m-2', 3, 'e')]);
    await doc.reload();
    await settle();

    expect(c.dataset.cellKey).toBe('ma:m-9:Gloss');
    expect(c.value).toBe('');
    const own = cell('ma:m-2:Gloss');
    expect(own).not.toBe(c);
    expect(own.value).toBe('PST');
    // Focus goes with the text, so typing goes on in its own morpheme.
    expect(document.activeElement).toBe(own);
    expect(own.selectionStart).toBe(3);
    expect(notifyError).not.toHaveBeenCalled();
    type(own, 'PSTX');
    own.blur();
    await settle();
    expect(writes(client).map((w) => [w.kind, w.args[1], w.args[2]])).toEqual([
      ['spans.create', ['m-2'], 'PSTX'],
    ]);
  });

  it('keeps a value put back unsent off the morpheme its input is reused for', async () => {
    const { doc, client, serve } = mount([morph('m-1', 1, 'th'), morph('m-2', 2, 'e')]);
    const c = cell('ma:m-2:Gloss');
    editor._restoreUnsent(c, 'PST', '');
    // m-2 gone, a morpheme with the same (empty) gloss in its place.
    serve([morph('m-1', 1, 'th'), morph('m-9', 2, 'he')]);
    await doc.reload();
    await settle();

    expect(c.dataset.cellKey).toBe('ma:m-9:Gloss');
    expect(c.value).toBe('');
    c.focus();
    c.blur();
    await settle();
    expect(writes(client)).toHaveLength(0);
  });
});

describe('a split refused by the server', () => {
  it('takes the letters typed into its new cell with it, not onto the morpheme drawn there after', async () => {
    const { client, serve } = mount([]);
    // The split is held, then refused, and the refetch brings another
    // writer's split of the same word.
    let release;
    client.batched = async () => {
      await new Promise((r) => (release = r));
      throw Object.assign(new Error('HTTP 409 changed'), { status: 409 });
    };
    serve([morph('x-1', 1, 'thx'), morph('x-2', 2, 'e')]);
    const f = cell('mf:virtual:w-1');
    f.focus();
    f.setSelectionRange(2, 2);
    key(f, '-');
    await settle();
    // The new cell took focus; the letters typed into it.
    const fresh = document.activeElement;
    expect(fresh.dataset.prec).toBe('2');
    type(fresh, 'ee');
    release();
    await settle(30);

    expect(fresh.dataset.cellKey).toBe('mf:x-2');
    expect(fresh.value).toBe('e');
    expect(document.activeElement).not.toBe(fresh);
    fresh.focus();
    fresh.blur();
    await settle();
    expect(writes(client)).toHaveLength(0);
    // The refusal is the message: the cell it made is gone with it.
    expect(notifyError).not.toHaveBeenCalled();
  });
});

describe('a cell whose morpheme this page makes', () => {
  it('stays the same cell while its id goes from derived to pending to stored', async () => {
    const { doc, client } = mount([]);
    const gloss = cell('ma:virtual:w-1:Gloss');
    gloss.focus();
    type(gloss, 'D');
    // The form committed from elsewhere makes the morpheme under the gloss.
    await doc.updateMorphemeForm('virtual:w-1', 'the');
    await settle();
    expect(gloss.dataset.cellKey).not.toBe('ma:virtual:w-1:Gloss');
    expect(gloss.value).toBe('D');
    gloss.blur();
    await settle();
    const spans = client.calls.filter((c) => c.kind === 'spans.create');
    expect(spans).toHaveLength(1);
    expect(spans[0].args[1]).toEqual([doc.sentences[0].tokens[0].morphemes[0].id]);
  });
});
