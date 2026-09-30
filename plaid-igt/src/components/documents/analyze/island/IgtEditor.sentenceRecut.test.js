import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';
import { notifyError, notifyWarning } from '@/utils/feedback';
import { hasUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';
import { KEPT_IN_CELL } from '@ui/lib/cellConflict.js';

// A translation refused because another user split, joined or respelled its
// sentence meanwhile (REV-W-RESEND2). The sentence keeps its id on its left
// half, or on the joined sentence, so the cell is still there, but the value
// was typed for a sentence that reads differently now. As for a word's gloss
// (IgtEditor.recutConflict.test.js), the cell shows what is stored with
// "Yours: X · Enter to keep yours" under it, leaving sends nothing, and a
// toast names the change. It used to go back into the cell, and leaving it
// stored the translation on the left half.

vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const shape = ({ body = 'the cat. a dog.', sentences } = {}) =>
  buildRawDoc({
    body,
    sentences: sentences ?? [
      { id: 's-1', begin: 0, end: 8 },
      { id: 's-2', begin: 9, end: 15 },
    ],
    words: [
      { id: 'w-1', begin: 0, end: 3 },
      { id: 'w-2', begin: 4, end: 8 },
      { id: 'w-3', begin: 9, end: 10 },
      { id: 'w-4', begin: 11, end: 15 },
    ],
  });

let host;
let editor;

function mount() {
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  client.documents.auditPage = async () => ({
    entries: [{ user: { id: 'b@x.com', displayName: 'b' }, ops: [] }],
    nextCursor: null,
  });
  const doc = new IgtDocument({
    raw: shape(),
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

describe('a translation refused because its sentence changed meanwhile', () => {
  for (const [what, served, now] of [
    [
      'split',
      () =>
        shape({
          sentences: [
            { id: 's-1', begin: 0, end: 8 },
            { id: 's-2', begin: 9, end: 11 },
            { id: 's-3', begin: 11, end: 15 },
          ],
        }),
      'a',
    ],
    [
      'joined',
      () =>
        shape({
          sentences: [{ id: 's-2', begin: 0, end: 15 }],
        }),
      'the cat. a dog.',
    ],
    ['respelled', () => shape({ body: 'the cat. a hog.' }), 'a hog.'],
  ]) {
    it(`shows what is stored with yours under it, and leaving sends nothing (${what})`, async () => {
      const { client } = mount();
      const restore = refuseWith(client, served());
      const c = cell('sa:s-2:Translation');
      c.focus();
      type(c, 'A dog.');
      c.blur();
      await settle();
      restore();

      const after = cell('sa:s-2:Translation');
      expect(after.value).toBe('');
      expect(note('sa:s-2:Translation')?.textContent).toBe('Yours: A dog. · Enter to keep yours');
      after.focus();
      after.blur();
      await settle();
      expect(writes(client)).toEqual([]);
      expect(hasUnsavedDraft()).toBe(null);
      expect(notifyWarning).toHaveBeenCalledWith(
        `b changed this sentence to ${/[.!?…]$/u.test(now) ? now : `${now}.`}`,
      );
      expect(notifyError).not.toHaveBeenCalledWith(KEPT_IN_CELL, expect.anything());
    });
  }

  it('goes back into the cell to be sent again when the sentence reads as it did', async () => {
    const { client } = mount();
    // Refused for a change elsewhere (another sentence's translation).
    const elsewhere = shape();
    elsewhere.textLayers[0].tokenLayers[0].spanLayers[0].spans.push({
      id: 'span-b',
      tokens: ['s-1'],
      value: 'The cat.',
    });
    const restore = refuseWith(client, elsewhere);
    const c = cell('sa:s-2:Translation');
    c.focus();
    type(c, 'A dog.');
    c.blur();
    await settle();
    restore();
    expect(note('sa:s-2:Translation')).toBeNull();
    expect(cell('sa:s-2:Translation').value).toBe('A dog.');
  });
});
