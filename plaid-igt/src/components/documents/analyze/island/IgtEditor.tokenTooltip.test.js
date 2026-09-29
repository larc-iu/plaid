// A word token a tokenizer service made says so in its tooltip, in the one
// word every app uses for machine output ("machine-made", the owner's ruling
// of 2026-09-28) narrowed to what the machine did: "machine-tokenized". The
// grid swaps the word in the shared tooltip, so a token whose own text is
// "machine-made" must keep its text.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';

vi.mock('@/utils/feedback', () => ({
  notifyWarning: vi.fn(),
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

let host;
let editor;

const MACHINE = { prov: 'inferred', provSource: 'service:tokenizer' };

function mount() {
  resetIds();
  const raw = buildRawDoc({
    body: 'machine-made cat dog',
    words: [
      { id: 'w-1', begin: 0, end: 12, metadata: MACHINE },
      { id: 'w-2', begin: 13, end: 16, metadata: { ...MACHINE, provConfirmed: true } },
      { id: 'w-3', begin: 17, end: 20 },
    ],
  });
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const doc = new IgtDocument({
    raw,
    project: { id: 'proj-1', vocabs: [], config: {}, maintainers: [], writers: [] },
    vocabularies: {},
    client,
    projectId: 'proj-1',
    user: null,
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  editor = new IgtEditor(host, doc, {});
}

afterEach(() => {
  editor?.destroy();
  host?.remove();
  editor = null;
  host = null;
});

const title = (wordId) =>
  host.querySelector(`[data-word-col="${wordId}"] .igt-token-form`).getAttribute('title');

describe('the word token tooltip', () => {
  it('says machine-tokenized, and keeps a token text that reads machine-made', () => {
    mount();
    expect(title('w-1')).toMatch(/^machine-made: machine-tokenized, unverified\. /);
    expect(title('w-2')).toBe('cat: machine-tokenized, confirmed');
    expect(title('w-3')).toBe('dog');
  });
});
