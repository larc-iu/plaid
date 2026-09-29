import { describe, it, expect, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';
import { openPrecedent, precedentBase } from '@/domain/precedentCache.js';
import { precedentCounts } from '@/domain/precedent.js';

// A document edited and left counts, as it was left, in the next document's
// precedent. The editor instance that closes the document is not always the
// one it was edited in: a look at a history entry takes the live editor
// read-only and destroys it when the snapshot lands, and closing the history
// builds a new one around the same live document. So does a run that ends
// in a reload while the person moves on.

vi.mock('@/utils/feedback', () => ({
  notifyWarning: vi.fn(),
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

let logins = 0;
const makeDoc = (id, client, asOf = null) => {
  const raw = buildRawDoc({ body: 'the cat', wordFields: ['POS'], morphFields: [] });
  raw.id = id;
  raw.version = 1;
  return new IgtDocument({
    raw,
    project: { id: 'proj-p', vocabs: [], config: {}, maintainers: [], writers: [] },
    vocabularies: {},
    client,
    projectId: 'proj-p',
    user: null,
    asOf,
  });
};

// The person tags "the" DET.
const tagThe = (doc) =>
  doc._applyRawPatch((raw) => {
    raw.textLayers[0].tokenLayers[1].spanLayers[0].spans.push({
      id: 'sp-1',
      value: 'DET',
      tokens: ['w-1'],
      metadata: {},
    });
  });

const settle = () => new Promise((r) => setTimeout(r, 0));

async function run(between) {
  resetIds();
  const client = makeFakeClient();
  client.baseUrl = 'http://core';
  client.token = `precedent-${++logins}`; // a cache entry of its own
  client.query = async () => ({ results: [] }); // the project held nothing when read
  client.projects.listDocuments = async () => [
    { id: 'doc-a', version: 1 },
    { id: 'doc-b', version: 1 },
  ];
  const a = makeDoc('doc-a', client);
  const host = document.createElement('div');
  document.body.appendChild(host);
  let editor = new IgtEditor(host, a, {});
  await openPrecedent(a);
  await settle();
  tagThe(a);
  editor = await between(editor, host, a, client);
  editor.destroy(); // on to the next document
  host.remove();
  const b = makeDoc('doc-b', client);
  await openPrecedent(b);
  return precedentCounts(precedentBase(b), 'word', 'the', 'POS');
}

describe('precedent: a document edited and left', () => {
  it('counts in the next document', async () => {
    expect(await run(async (editor) => editor)).toEqual(new Map([['DET', 1]]));
  });

  it('counts after a look at one of its history entries', async () => {
    const counts = await run(async (editor, host, a, client) => {
      editor.setReadOnly(true); // the click on an entry
      editor.destroy(); // the snapshot landed
      const snapshot = makeDoc('doc-a', client, '2026-09-01T00:00:00Z');
      const past = new IgtEditor(host, snapshot, { readOnly: true });
      await settle();
      past.destroy(); // the history closed
      const live = new IgtEditor(host, a, {}); // the live document again
      await settle();
      return live;
    });
    expect(counts).toEqual(new Map([['DET', 1]]));
  });

  it('counts when it is left while a run holds it read-only', async () => {
    const counts = await run(async (editor) => {
      editor.setReadOnly(true);
      return editor;
    });
    expect(counts).toEqual(new Map([['DET', 1]]));
  });
});
