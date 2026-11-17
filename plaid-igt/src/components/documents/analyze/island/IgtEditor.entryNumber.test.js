import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  buildRawDoc,
  makeFakeClient,
  makeIgtDoc,
  mountIsland,
  resetIds,
  settle,
} from '@/domain/test-helpers.js';
import { VOCAB_ENTRY_SOURCE } from '@/domain/glossGuess.js';

// H3-2: a lexicon with four entries spelled kai (a headword with two senses,
// and a second headword) names the one a link or a guess means by its number,
// as History and the popover do ('kai 1.2'), in the toasts after a link to
// every one in the text and in the guess's title.

vi.mock('@/utils/feedback', () => ({
  notifyWarning: vi.fn(),
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));
const feedback = await import('@/utils/feedback');

let host;
let editor;
afterEach(() => {
  editor?.destroy();
  host?.remove();
  editor = null;
  host = null;
  resetIds();
});

const ITEMS = [
  { id: 'i-kai1', form: 'kai', metadata: { morphType: 'stem' } },
  { id: 'i-go', form: 'kai', metadata: { parent: 'i-kai1', senseOrder: 1, gloss: 'go' } },
  { id: 'i-walk', form: 'kai', metadata: { parent: 'i-kai1', senseOrder: 2, gloss: 'walk' } },
  { id: 'i-fish', form: 'kai', metadata: { morphType: 'stem', gloss: 'fish' } },
];

function mount() {
  const raw = buildRawDoc({
    body: 'kai kai kai',
    words: [
      { id: 'w-1', begin: 0, end: 3 },
      { id: 'w-2', begin: 4, end: 7 },
      { id: 'w-3', begin: 8, end: 11 },
    ],
  });
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const doc = makeIgtDoc({
    raw,
    project: { id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {} } },
    vocabularies: { v1: { id: 'v1', name: 'Lex', items: ITEMS, vocabLinks: [] } },
    client,
  });
  client.documents.get = async () => doc.raw;
  ({ host, editor } = mountIsland(doc));
  return doc;
}

const walk = { ...ITEMS[2], vocabId: 'v1' };

describe('an entry spelled like others is named with its number', () => {
  it('in the toast after all ×N', async () => {
    mount();
    feedback.notifyInfo.mockClear();
    editor._linkAll('w-1', 'kai', walk, ['w-2', 'w-3']);
    await settle(6);
    expect(feedback.notifyInfo).toHaveBeenCalledWith(
      'Linked 3 “kai” to kai 1.2',
      'Linked in this text',
    );
  });

  it('in the toast after linking every other one', async () => {
    mount();
    feedback.notifyInfo.mockClear();
    editor._linkEverywhere('w-1', 'word', 'kai', walk);
    await settle(6);
    expect(feedback.notifyInfo).toHaveBeenCalledWith(
      'Linked 2 more “kai” to kai 1.2',
      'Linked in this text',
    );
  });

  it('in the title of a guess taken from the entry', () => {
    mount();
    expect(
      editor._guessBasis({
        source: VOCAB_ENTRY_SOURCE,
        entryForm: 'kai',
        entryId: 'i-fish',
        vocabId: 'v1',
        trusted: true,
      }),
    ).toBe('from the entry “kai 2”');
  });
});
