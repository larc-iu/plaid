import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';

// What History calls an edit made in a cell: the field, the word or morpheme,
// the sentence and the value, rather than "Update Gloss" for every one.

vi.mock('@/utils/feedback', () => ({
  notifyWarning: vi.fn(),
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

let host;
let editor;

function mount(opts = {}) {
  const raw = buildRawDoc(opts);
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const doc = new IgtDocument({
    raw,
    project: { id: 'proj-1', vocabs: [], config: {}, maintainers: ['lead@x.com'], writers: [] },
    vocabularies: {},
    client,
    projectId: 'proj-1',
    user: null,
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  editor = new IgtEditor(host, doc, {});
  return { doc, client };
}

const cell = (key) => host.querySelector(`[data-cell-key="${key}"]`);
const commit = async (el, value) => {
  el.focus();
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.blur();
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const labels = (client) =>
  client.calls.filter((c) => c.kind === 'beginOperation').map((c) => c.args[0]);

beforeEach(() => resetIds());
afterEach(() => {
  editor?.destroy();
  host?.remove();
  editor = null;
  host = null;
});

describe('an edit made in a cell is named in History', () => {
  it('for a word field, an orthography and a sentence field', async () => {
    const { client } = mount({
      body: 'the cat\ndogs ran',
      sentences: [
        { id: 's-1', begin: 0, end: 7 },
        { id: 's-2', begin: 8, end: 16 },
      ],
      words: [
        { id: 'w-1', begin: 0, end: 3 },
        { id: 'w-2', begin: 4, end: 7 },
        { id: 'w-3', begin: 8, end: 12 },
        { id: 'w-4', begin: 13, end: 16 },
      ],
    });
    await commit(cell('wa:w-3:POS'), 'N');
    await commit(cell('or:w-3:IPA'), 'dɔgz');
    await commit(cell('sa:s-2:Translation'), 'The dogs ran.');
    await commit(cell('wa:w-3:POS'), '');
    expect(labels(client)).toEqual([
      'POS of "dogs" in sentence 2: N',
      'IPA of "dogs" in sentence 2: dɔgz',
      'Translation of sentence 2: The dogs ran.',
      'POS of "dogs" in sentence 2 cleared',
    ]);
  });

  it('for a morpheme, by its form within its word', async () => {
    const { client } = mount({
      morphemes: [
        { id: 'm-1', text: 'text-1', begin: 4, end: 7, precedence: 1, metadata: { form: 'ca' } },
        { id: 'm-2', text: 'text-1', begin: 4, end: 7, precedence: 2, metadata: { form: 't' } },
      ],
    });
    await commit(cell('ma:m-2:Gloss'), 'PL');
    await commit(cell('mf:m-2'), 'tt');
    // "the" has no morpheme stored: the one it shows is the whole word.
    await commit(cell('ma:virtual:w-1:Gloss'), 'DEF');
    expect(labels(client)).toEqual([
      'Gloss of morpheme "t" of "cat" in sentence 1: PL',
      'Form of morpheme 2 of "cat" in sentence 1: tt',
      'Gloss of morpheme "the" in sentence 1: DEF',
    ]);
  });

  it('cuts a long value short', async () => {
    const { client } = mount();
    await commit(cell('sa:s-1:Translation'), 'x'.repeat(60));
    expect(labels(client)).toEqual([`Translation of sentence 1: ${'x'.repeat(40)}…`]);
  });
});
