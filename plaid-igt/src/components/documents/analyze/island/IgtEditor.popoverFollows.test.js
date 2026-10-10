// The lexicon popover on a word's morpheme stays open while the word's first
// gloss is saved. That save makes the morpheme, whose id goes from the
// virtual one to a pending one to the server's, and the popover used to close
// by itself when the save landed, before the refreshed list was ever seen
// (REV-W-IGT2 O1).
import { isPendingId } from '@ui/domain/pendingIds.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildRawDoc,
  makeFakeClient,
  resetIds,
  makeIgtDoc,
  settle,
  mountIsland,
} from '@/domain/test-helpers.js';

vi.mock('@/utils/feedback', () => ({
  notifyWarning: vi.fn(),
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

let host;
let editor;

// "the cat", neither word analyzed, and every batch held until `release`.
function mount() {
  const raw = buildRawDoc({ body: 'the cat', morphemes: [] });
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  let release;
  const gate = new Promise((r) => (release = r));
  const batch = client.batch.bind(client);
  client.batch = () => {
    const b = batch();
    const submit = b.submit;
    b.submit = async () => {
      await gate;
      return submit();
    };
    return b;
  };
  const doc = makeIgtDoc({
    raw,
    project: { id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {} } },
    vocabularies: {
      v1: { id: 'v1', name: 'Lexicon', maintainers: [], items: [], vocabLinks: [] },
    },
    client,
    user: { id: 'wren@example.com' },
  });
  client.documents.get = async () => doc.raw;
  ({ host, editor } = mountIsland(doc, { canManageVocab: () => true }));
  return { doc, release };
}

const popover = () => host.querySelector('.igt-vocab-pop');
const morphemeOf = (doc) => doc.sentences[0].tokens[1].morphemes[0];

beforeEach(() => resetIds());
afterEach(() => {
  editor?.destroy();
  host?.remove();
  editor = null;
  host = null;
});

describe('the lexicon popover on a word whose first gloss is being saved', () => {
  it('stays open when the save lands and the morpheme takes its server id', async () => {
    const { doc, release } = mount();
    await settle(6);
    const saving = doc.updateMorphemeSpan('virtual:w-2', 'Gloss', 'CAT');
    await settle(6);
    const pending = morphemeOf(doc).id;
    expect(isPendingId(pending)).toBe(true);
    host
      .querySelector(`button[data-vocab-opener="${pending}"]`)
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(popover()).not.toBeNull();

    release();
    await saving;
    await settle(6);
    const real = morphemeOf(doc).id;
    expect(isPendingId(real)).toBe(false);
    expect(real).not.toMatch(/^virtual:/);
    expect(popover()).not.toBeNull();
    expect(host.querySelector(`[data-pop-opener="vocab:${real}"]`)).not.toBeNull();
  });

  it('stays open when it was opened on the word before its morpheme was made', async () => {
    const { doc, release } = mount();
    await settle(6);
    host
      .querySelector('button[data-vocab-opener="virtual:w-2"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(popover()).not.toBeNull();
    const saving = doc.updateMorphemeSpan('virtual:w-2', 'Gloss', 'CAT');
    await settle(6);
    expect(popover()).not.toBeNull();
    release();
    await saving;
    await settle(6);
    expect(popover()).not.toBeNull();
  });
});
