import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildRawDoc,
  makeFakeClient,
  resetIds,
  makeIgtDoc,
  mountIsland,
} from '@/domain/test-helpers.js';

// Text no word covers (punctuation) wraps with the word beside it: a
// sentence's full stop never wraps into a band of its own when the grid
// narrows (RP-3, opening the side panel). A word and the text after it are
// one unit of the wrap, and text before the first word goes with that word.

vi.mock('@/utils/feedback', () => ({
  notifyWarning: vi.fn(),
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

let host;
let editor;

const mount = (docOpts) => {
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const doc = makeIgtDoc({
    raw: buildRawDoc(docOpts),
    project: { id: 'proj-1', vocabs: [], config: {}, maintainers: [], writers: [] },
    client,
    user: null,
  });
  client.documents.get = async () => doc.raw;
  ({ host, editor } = mountIsland(doc));
  return doc;
};

beforeEach(() => resetIds());
afterEach(() => {
  editor?.destroy();
  host?.remove();
  editor = null;
  host = null;
});

// What each item the band wraps holds, in order: a word by its form, a run
// of uncovered text by its text.
const units = () =>
  [...host.querySelector('.igt-tokens').children]
    .filter((el) => !el.classList.contains('igt-labels'))
    .map((el) =>
      [...(el.classList.contains('igt-col-group') ? el.children : [el])].map(
        (c) => c.querySelector('.igt-token-form, .igt-gap-form')?.textContent.trim() ?? c.className,
      ),
    );

describe('punctuation in the grid', () => {
  it('wraps with the word before it, and text before the first word with that word', () => {
    // "“the dog, sat.”" by code point: “ 0-1, the 1-4, dog 5-8, , 8-9, sat 10-13, .” 13-15.
    mount({
      body: '“the dog, sat.”',
      words: [
        { id: 'w-1', begin: 1, end: 4 },
        { id: 'w-2', begin: 5, end: 8 },
        { id: 'w-3', begin: 10, end: 13 },
      ],
    });
    expect(units()).toEqual([
      ['“', 'the'],
      ['dog', ','],
      ['sat', '.”'],
    ]);
  });

  it('leaves a word with nothing beside it a column of its own', () => {
    mount({
      body: 'the dog',
      words: [
        { id: 'w-1', begin: 0, end: 3 },
        { id: 'w-2', begin: 4, end: 7 },
      ],
    });
    expect(units()).toEqual([['the'], ['dog']]);
    expect(host.querySelector('.igt-col-group')).toBeNull();
  });
});
