import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';
import { notifyError, notifyWarning } from '@/utils/feedback';

// A sentence field (Translation) refused because someone else wrote a value
// on another sentence meanwhile goes again by itself, as a gloss does
// (DECISIONS D25, DocumentModel.resendsByEntity). The same sentence's field
// is still refused.

vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const BODY = 'the cat. a dog.';
const shape = () =>
  buildRawDoc({
    body: BODY,
    sentences: [
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

// The document as b left it: a translation on sentence `sentence`.
const theirs = (sentence, value) => {
  const raw = shape();
  const layer = raw.textLayers[0].tokenLayers[0].spanLayers[0];
  layer.spans.push({ id: 'span-b', tokens: [sentence], value });
  return raw;
};

let host;
let editor;

// A client in strict mode whose server moved on to version 2 (b's write):
// the first span write, stamped 1, is refused 409, and the read after it
// serves `served` at version 2.
function mount(served) {
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  client.documents.auditPage = async () => ({
    entries: [{ user: { id: 'b@x.com', displayName: 'b' }, ops: [] }],
    nextCursor: null,
  });
  client.strictModeDocumentId = 'doc-1';
  client.documentVersions = { 'doc-1': 1 };
  client.documents.get = async () => {
    client.documentVersions = { ...client.documentVersions, 'doc-1': 2 };
    return JSON.parse(JSON.stringify(served));
  };
  const sent = [];
  const create = client.spans.create;
  client.spans.create = async (...args) => {
    sent.push({ version: client.documentVersions['doc-1'], value: args[2] });
    if (client.documentVersions['doc-1'] !== 2) {
      throw Object.assign(new Error('HTTP 409 conflict'), { status: 409 });
    }
    return create(...args);
  };
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
  return { doc, sent };
}

const cell = (key) => host.querySelector(`[data-cell-key="${key}"]`);
const type = (el, value) => {
  el.value = value;
  el.setSelectionRange(value.length, value.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const settle = async (n = 40) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
const translations = (doc) =>
  doc.raw.textLayers[0].tokenLayers[0].spanLayers[0].spans.map((s) => [s.tokens[0], s.value]);

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

describe('a translation refused because another sentence was translated meanwhile', () => {
  it('goes again by itself, and both translations stand with no message', async () => {
    const { doc, sent } = mount(theirs('s-1', 'The cat.'));
    const c = cell('sa:s-2:Translation');
    c.focus();
    type(c, 'A dog.');
    c.blur();
    await settle();

    expect(sent).toEqual([
      { version: 1, value: 'A dog.' },
      { version: 2, value: 'A dog.' },
    ]);
    expect(translations(doc)).toEqual([
      ['s-1', 'The cat.'],
      ['s-2', 'A dog.'],
    ]);
    expect(notifyError).not.toHaveBeenCalled();
    expect(notifyWarning).not.toHaveBeenCalled();
    expect(doc.error).toBe('');
  });

  it('is refused when the other translation was on the same sentence', async () => {
    const { doc, sent } = mount(theirs('s-2', 'One dog.'));
    const c = cell('sa:s-2:Translation');
    c.focus();
    type(c, 'A dog.');
    c.blur();
    await settle();

    expect(sent).toEqual([{ version: 1, value: 'A dog.' }]);
    expect(translations(doc)).toEqual([['s-2', 'One dog.']]);
  });
});
