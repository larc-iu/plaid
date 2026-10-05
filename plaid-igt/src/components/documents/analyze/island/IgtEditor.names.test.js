import { describe, it, expect, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient } from '@/domain/test-helpers.js';

// What a screen reader calls the grid's small buttons. A button's text wins
// over its title, so the pager's arrows were read as "«" and "‹", and every
// unlinked word's chip as "link", whichever word it was under.

vi.mock('@/utils/feedback', () => ({
  notifyWarning: vi.fn(),
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

let host;
const PAGE_SIZE = IgtEditor.PAGE_SIZE;
afterEach(() => {
  IgtEditor.PAGE_SIZE = PAGE_SIZE;
  host?.remove();
});

function mount() {
  const raw = buildRawDoc({
    body: 'the cat sat down',
    words: [
      { id: 'w-1', begin: 0, end: 3 },
      { id: 'w-2', begin: 4, end: 7 },
      { id: 'w-3', begin: 8, end: 11 },
      { id: 'w-4', begin: 12, end: 16 },
    ],
    sentences: [
      { id: 's-1', begin: 0, end: 7 },
      { id: 's-2', begin: 8, end: 16 },
    ],
  });
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const doc = new IgtDocument({
    raw,
    project: { id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {} } },
    vocabularies: { v1: { id: 'v1', name: 'Lexicon', items: [], vocabLinks: [] } },
    client,
    projectId: 'proj-1',
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  new IgtEditor(host, doc, {});
}

describe('grid button names', () => {
  it("names the pager's arrows by what they do", () => {
    IgtEditor.PAGE_SIZE = 1;
    mount();
    const names = [...host.querySelectorAll('.igt-pager')][0].querySelectorAll('button');
    expect([...names].map((b) => b.getAttribute('aria-label'))).toEqual([
      'First page',
      'Previous page',
      'Next page',
      'Last page',
    ]);
  });

  it("names an unlinked word's chip after its word", () => {
    mount();
    const chip = host.querySelector('[data-word-col="w-2"] .igt-vocab__link');
    expect(chip.getAttribute('aria-label')).toBe('Link cat to a lexicon entry');
  });
});
