import { describe, it, expect, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient } from '@/domain/test-helpers.js';

// What the popover writes under an entry: the vocabulary's inline fields. A
// field of type `item` holds entry ids, which say nothing to a reader, so it
// has to read as the entries it names.

vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

const VOCAB = {
  id: 'v1',
  name: 'Lexicon',
  config: {
    igt: {
      dictionary: true,
      fields: {
        gloss: { inline: true },
        variantOf: { inline: true, type: 'item', many: true },
        seeAlso: { inline: true, type: 'item' },
      },
    },
  },
  items: [
    { id: 'h', form: 'kat', metadata: { gloss: 'cat' } },
    { id: 's', form: 'kat', metadata: { gloss: 'lion', parent: 'h', senseOrder: 1 } },
    { id: 'v', form: 'katt', metadata: { gloss: 'cat', variantOf: ['h', 's'], seeAlso: 'gone' } },
  ],
};

let host;

const mount = () => {
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const doc = new IgtDocument({
    raw: buildRawDoc(),
    project: { id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {}, igt: {} } },
    vocabularies: { v1: structuredClone(VOCAB) },
    client,
    projectId: 'proj-1',
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  return { editor: new IgtEditor(host, doc, {}), doc };
};

afterEach(() => {
  host?.remove();
  host = null;
});

describe('the popover detail line', () => {
  it('reads a reference field as the entries it names, numbered', () => {
    const { editor, doc } = mount();
    const vocab = doc.vocabularies.v1;
    const detail = (id) =>
      editor._vocabItemDetail(
        vocab.items.find((i) => i.id === id),
        vocab,
      );
    expect(detail('v')).toBe('cat · kat 1, kat 1.1');
    // An entry with nothing to refer to says only what it has.
    expect(detail('h')).toBe('cat');
  });

  it("falls back to the entry's own values, never to a reserved key", () => {
    const { editor, doc } = mount();
    const vocab = doc.vocabularies.v1;
    // No inline field: the line falls back to what the entry carries, and
    // `parent` is an id written before the fields.
    const bare = { ...vocab, config: { igt: { dictionary: true, fields: {} } } };
    const sense = { id: 's', form: 'kat', metadata: { parent: 'h', senseOrder: 1, gloss: 'lion' } };
    expect(editor._vocabItemDetail(sense, bare)).toBe('lion');
  });

  it('leaves out a reference to an entry that is gone', () => {
    const { editor, doc } = mount();
    const vocab = doc.vocabularies.v1;
    const item = { ...vocab.items[2], metadata: { seeAlso: 'gone' } };
    expect(editor._vocabItemDetail(item, vocab)).toBe('');
  });
});
