// Who may add an entry from the Analyze popover (acl-shared-vocab-writers b,
// and Luke's answer to FIX-R-CREATE Q1): anyone who can write the document,
// for a word and for a multi-word expression. Changing a linked entry's type
// stays with the vocabulary's maintainers.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

// "the cat sat down", the word "cat" linked, and a writer who does not
// maintain the lexicon.
function mount() {
  const raw = buildRawDoc({
    body: 'the cat sat down',
    words: [
      { id: 'w-1', begin: 0, end: 3 },
      { id: 'w-2', begin: 4, end: 7 },
      { id: 'w-3', begin: 8, end: 11 },
      { id: 'w-4', begin: 12, end: 16 },
    ],
  });
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const doc = new IgtDocument({
    raw,
    project: { id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {} } },
    vocabularies: {
      v1: {
        id: 'v1',
        name: 'Lexicon',
        maintainers: ['mara@example.com'],
        items: [{ id: 'i-cat', form: 'cat', metadata: { morphType: 'stem' } }],
        vocabLinks: [{ id: 'lk-cat', tokens: ['m-2'], vocabItem: { id: 'i-cat', form: 'cat' } }],
      },
    },
    client,
    projectId: 'proj-1',
    user: { id: 'wren@example.com' },
  });
  client.documents.get = async () => doc.raw;
  host = document.createElement('div');
  document.body.appendChild(host);
  editor = new IgtEditor(host, doc, { canManageVocab: () => false });
  return { doc, client };
}

const popover = () => host.querySelector('.igt-vocab-pop');
const form = (wordId) => host.querySelector(`[data-word-col="${wordId}"] .igt-token-form`);
const label = (key) => host.querySelector(`button.igt-mwe__label[data-vocab-opener="${key}"]`);
const click = (el, init = {}) =>
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
const key = (el, k, init = {}) =>
  el.dispatchEvent(
    new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }),
  );
const settle = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
const openOn = (tokenId) => click(host.querySelector(`button[data-vocab-opener="${tokenId}"]`));

beforeEach(() => resetIds());
afterEach(() => {
  editor?.destroy();
  host?.remove();
  editor = null;
  host = null;
});

describe('a writer who does not maintain the lexicon', () => {
  it('is offered "+ Create" on a word, and it makes and links the entry', async () => {
    const { doc, client } = mount();
    openOn('m-1');
    const create = popover().querySelector('.igt-vocab-pop__create');
    expect(create).not.toBeNull();
    expect(create.textContent).toContain('"the"');
    click(create);
    click(popover().querySelector('.igt-vocab-pop__create'));
    await settle();
    const made = client.calls.find((c) => c.kind === 'vocabItems.create');
    expect(made.args.slice(0, 2)).toEqual(['v1', 'the']);
    const link = client.calls.find((c) => c.kind === 'vocabLinks.create');
    expect(link.args[1]).toEqual(['m-1']);
    expect(doc.vocabularies.v1.vocabLinks.some((l) => l.vocabItem.form === 'the')).toBe(true);
  });

  it('is offered "+ Create" for a multi-word expression', () => {
    mount();
    click(form('w-3'), { shiftKey: true });
    click(form('w-4'), { shiftKey: true });
    key(label('mwe:new'), 'Enter');
    const create = popover().querySelector('.igt-vocab-pop__create');
    expect(create).not.toBeNull();
    expect(create.textContent).toContain('"sat down"');
  });

  it('cannot change the type of a linked entry', () => {
    mount();
    openOn('m-2');
    const type = popover().querySelector('.igt-vocab-pop__type select');
    expect(type).not.toBeNull();
    expect(type.disabled).toBe(true);
  });
});
