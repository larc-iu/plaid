import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';
import { notifyError } from '@/utils/feedback';
import { hasUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';

// A cell edit refused as a conflict because another user deleted or merged
// its word meanwhile: the cell is gone with the word, so nothing can be put
// back, and the refusal is said (the cell claims the conflict, so the
// document raises no toast of its own).

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
  client.documents.auditPage = async () => ({ entries: [], nextCursor: null });
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

const cell = (key) => host.querySelector(`[data-cell-key="${key}"]`);
const type = (el, value) => {
  el.value = value;
  el.setSelectionRange(value.length, value.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const settle = async (n = 30) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

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

describe('a cell edit refused after another user removed its word', () => {
  it('says it was not saved', async () => {
    const { client } = mount();
    // b deleted "cat" (w-2 and its morpheme m-2).
    const served = buildRawDoc({
      words: [{ id: 'w-1', begin: 0, end: 3 }],
      morphemes: [{ id: 'm-1', text: 'text-1', begin: 0, end: 3, precedence: 1, metadata: {} }],
    });
    client.documents.get = async () => JSON.parse(JSON.stringify(served));
    client.spans.create = async () => {
      throw Object.assign(new Error('HTTP 409 refused'), { status: 409 });
    };
    const c = cell('ma:m-2:Gloss');
    c.focus();
    type(c, 'CAT');
    c.blur();
    await settle();

    expect(cell('ma:m-2:Gloss')).toBeNull();
    expect(notifyError).toHaveBeenCalledWith('Not saved: CAT', 'Changed elsewhere');
    expect(hasUnsavedDraft()).toBe(null);
  });
});
