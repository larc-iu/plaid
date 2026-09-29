import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';
import { notifyError, notifyWarning } from '@/utils/feedback';
import { hasUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';
import { KEPT_IN_CELL } from '@ui/lib/cellConflict.js';

// A gloss refused because another user split or joined its word meanwhile
// (REV-W-RESEND R-2). The word keeps its id on the left half, or on the
// joined word, so the cell is still there, but the value was typed for a
// word that is not there any more. It used to go back into the cell to be
// sent again on leaving, which stored SING on "si". It now takes Q1's form:
// the cell shows what is stored, "Yours: X · Enter to keep yours" under it,
// leaving sends nothing, and a toast names the change.

vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

let host;
let editor;

function mount() {
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  client.documents.auditPage = async () => ({
    entries: [
      { user: { id: 'b@x.com', displayName: 'b' }, ops: [{ description: 'Split token w-1' }] },
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

// "the cat" as b left it.
const split = () =>
  buildRawDoc({
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
const joined = () =>
  buildRawDoc({
    body: 'the cat',
    words: [{ id: 'w-1', begin: 0, end: 7 }],
    morphemes: [{ id: 'm-1', begin: 0, end: 7, precedence: 1, metadata: {} }],
  });
// Nothing re-cut: b glossed "cat", another cell.
const elsewhere = () => {
  const raw = buildRawDoc({});
  raw.textLayers[0].tokenLayers
    .flatMap((tl) => tl.spanLayers || [])
    .find((sl) => sl.id === 'msl-0')
    .spans.push({ id: 'span-b', tokens: ['m-2'], value: 'CAT' });
  return raw;
};

// Every span write refused as a conflict until `release()`, and the reload
// after it reads `served`.
const refuseWith = (client, served) => {
  const spans = { ...client.spans };
  client.documents.get = async () => JSON.parse(JSON.stringify(served));
  for (const m of ['create', 'update', 'delete']) {
    client.spans[m] = async () => {
      throw Object.assign(new Error('HTTP 409 refused'), { status: 409 });
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
  editor?.destroy();
  host?.remove();
  editor = null;
  host = null;
});

describe('a gloss refused because its word was re-cut meanwhile', () => {
  for (const [what, served, now] of [
    ['split', split, 'th'],
    ['joined', joined, 'the cat'],
  ]) {
    it(`shows what is stored with yours under it, and leaving sends nothing (${what})`, async () => {
      const { client } = mount();
      const restore = refuseWith(client, served());
      const c = cell('ma:m-1:Gloss');
      c.focus();
      type(c, 'THE');
      c.blur();
      await settle();
      restore();

      const after = cell('ma:m-1:Gloss');
      expect(after.value).toBe('');
      expect(note('ma:m-1:Gloss')?.textContent).toBe('Yours: THE · Enter to keep yours');
      after.focus();
      after.blur();
      await settle();
      expect(writes(client)).toEqual([]);
      expect(hasUnsavedDraft()).toBe(null);
      expect(notifyWarning).toHaveBeenCalledWith(`b changed this word to ${now}.`);
      expect(notifyError).not.toHaveBeenCalledWith(KEPT_IN_CELL, expect.anything());
    });
  }

  // igt re-segments a morpheme in its form, not its extent: "the" becomes
  // th-e as two morphemes over the whole word, the first keeping its id with
  // the form "th". A gloss typed for "the" went back into the cell of "th"
  // and was stored there on leaving (REV-W-FINAL).
  it('shows what is stored when the morpheme was re-segmented, and leaving sends nothing', async () => {
    const { client } = mount();
    const resegmented = buildRawDoc({
      morphemes: [
        { id: 'm-1', begin: 0, end: 3, precedence: 1, metadata: { form: 'th' } },
        { id: 'm-3', begin: 0, end: 3, precedence: 2, metadata: { form: 'e' } },
        { id: 'm-2', begin: 4, end: 7, precedence: 1, metadata: {} },
      ],
    });
    const restore = refuseWith(client, resegmented);
    const c = cell('ma:m-1:Gloss');
    c.focus();
    type(c, 'THE');
    c.blur();
    await settle();
    restore();

    const after = cell('ma:m-1:Gloss');
    expect(after.value).toBe('');
    expect(note('ma:m-1:Gloss')?.textContent).toBe('Yours: THE · Enter to keep yours');
    after.focus();
    after.blur();
    await settle();
    expect(writes(client)).toEqual([]);
    expect(notifyWarning).toHaveBeenCalledWith('b changed this morpheme to th.');
    expect(notifyError).not.toHaveBeenCalledWith(KEPT_IN_CELL, expect.anything());
  });

  it('is put back to be sent again when the word was not re-cut', async () => {
    const { client } = mount();
    const restore = refuseWith(client, elsewhere());
    const c = cell('ma:m-1:Gloss');
    c.focus();
    type(c, 'THE');
    c.blur();
    await settle();
    restore();
    expect(cell('ma:m-1:Gloss').value).toBe('THE');
    expect(note('ma:m-1:Gloss')).toBeNull();
    expect(notifyError).toHaveBeenCalledWith(KEPT_IN_CELL, 'Failed to update Gloss');
  });
});
