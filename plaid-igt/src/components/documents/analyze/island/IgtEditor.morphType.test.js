// The morpheme type control in the Analyze grid (R48) and the clitic side of
// "=" shown by spacing (R49).
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

// "kari", segmented ka + ri, ri linked to the entry `ri` when `linked`.
function mount({
  lexicon = true,
  linked = false,
  entryType = 'enclitic',
  own = {},
  own2 = {},
} = {}) {
  const raw = buildRawDoc({
    body: 'kari',
    words: [{ id: 'w-1', begin: 0, end: 4 }],
    morphemes: [
      { id: 'm-1', begin: 0, end: 4, precedence: 1, metadata: { form: 'ka', ...own } },
      { id: 'm-2', begin: 0, end: 4, precedence: 2, metadata: { form: 'ri', ...own2 } },
    ],
  });
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const item = { id: 'i-ri', form: 'ri', metadata: entryType ? { morphType: entryType } : {} };
  const doc = makeIgtDoc({
    raw,
    project: { id: 'proj-1', vocabs: lexicon ? [{ id: 'v1' }] : [], config: { plaid: {} } },
    vocabularies: lexicon
      ? {
          v1: {
            id: 'v1',
            name: 'Lexicon',
            maintainers: ['wren@example.com'],
            items: [item],
            vocabLinks: linked
              ? [{ id: 'lk-ri', tokens: ['m-2'], vocabItem: { id: 'i-ri', form: 'ri' } }]
              : [],
          },
        }
      : {},
    client,
    user: { id: 'wren@example.com' },
  });
  client.documents.get = async () => doc.raw;
  ({ host, editor } = mountIsland(doc, { canManageVocab: () => true }));
  return { doc, client };
}

const popover = () => host.querySelector('.igt-vocab-pop');
const click = (el) =>
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const openOn = (tokenId) => click(host.querySelector(`button[data-vocab-opener="${tokenId}"]`));
const choose = (value) => {
  const select = popover().querySelector('.igt-vocab-pop__type select');
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
};
const joiner = () => host.querySelector('.igt-morph-joiner');
const HAIR = String.fromCodePoint(0x200a);

beforeEach(() => resetIds());
afterEach(() => {
  editor?.destroy();
  host?.remove();
  editor = null;
  host = null;
});

describe('the morpheme type control (R48)', () => {
  it('sets an unlinked morpheme’s own type in one write, shown at once', async () => {
    const { doc, client } = mount();
    openOn('m-1');
    choose('proclitic');
    expect(doc.sentences[0].tokens[0].morphemes[0].morphType).toBe('proclitic');
    await settle(4);
    const writes = client.calls.filter((c) => c.kind === 'tokens.patchMetadata');
    expect(writes).toHaveLength(1);
    expect(writes[0].args).toEqual([
      'm-1',
      [{ op: 'set', path: ['morphType'], value: 'proclitic' }],
    ]);
  });

  it('clears an unlinked morpheme’s type', async () => {
    const { doc, client } = mount({ own: { morphType: 'stem' } });
    openOn('m-1');
    choose('');
    expect(doc.sentences[0].tokens[0].morphemes[0].metadata.morphType).toBeUndefined();
    await settle(4);
    const write = client.calls.find((c) => c.kind === 'tokens.patchMetadata');
    expect(write.args).toEqual(['m-1', [{ op: 'delete', path: ['morphType'] }]]);
  });

  it('shows a linked morpheme’s entry type, and a change edits the entry, saying it applies to every use', async () => {
    const { doc, client } = mount({ linked: true });
    openOn('m-2');
    const row = popover().querySelector('.igt-vocab-pop__type');
    expect(row.querySelector('option[selected]').value).toBe('enclitic');
    expect(popover().querySelector('.igt-vocab-pop__type-note').textContent.trim()).toBe(
      'Applies to every use of this entry.',
    );
    choose('suffix');
    await settle(4);
    expect(client.calls.find((c) => c.kind === 'vocabItems.patchMetadata').args).toEqual([
      'i-ri',
      [{ op: 'set', path: ['morphType'], value: 'suffix' }],
    ]);
    expect(client.calls.some((c) => c.kind === 'tokens.patchMetadata')).toBe(false);
    expect(doc.sentences[0].tokens[0].morphemes[1].morphType).toBe('suffix');
  });

  it('on a morpheme linked to an untyped entry, shows and clears the morpheme’s own type (CL-3)', async () => {
    const { doc, client } = mount({
      linked: true,
      entryType: null,
      own2: { morphType: 'enclitic', morphTypeFromEquals: 'enclitic' },
    });
    openOn('m-2');
    expect(popover().querySelector('.igt-vocab-pop__type option[selected]').value).toBe('enclitic');
    expect(popover().querySelector('.igt-vocab-pop__type-note')).toBeNull();
    choose('');
    expect(doc.sentences[0].tokens[0].morphemes[1].morphType).toBeNull();
    await settle(4);
    expect(client.calls.some((c) => c.kind === 'vocabItems.patchMetadata')).toBe(false);
    expect(client.calls.find((c) => c.kind === 'tokens.patchMetadata').args[0]).toBe('m-2');
  });

  it('on a morpheme linked to an untyped entry, sets the morpheme’s own type, not the entry’s', async () => {
    const { doc, client } = mount({ linked: true, entryType: null });
    openOn('m-2');
    choose('suffix');
    await settle(4);
    expect(client.calls.some((c) => c.kind === 'vocabItems.patchMetadata')).toBe(false);
    expect(client.calls.find((c) => c.kind === 'tokens.patchMetadata').args).toEqual([
      'm-2',
      [{ op: 'set', path: ['morphType'], value: 'suffix' }],
    ]);
    expect(doc.sentences[0].tokens[0].morphemes[1].morphType).toBe('suffix');
  });

  it('says nothing of every use on an unlinked morpheme', () => {
    mount();
    openOn('m-1');
    expect(popover().querySelector('.igt-vocab-pop__type-note')).toBeNull();
  });

  it('opens from a morpheme in a project with no lexicon', async () => {
    const { doc } = mount({ lexicon: false });
    // a bare verb, as the other openers are (REV-CLITIC CL-7)
    const opener = host.querySelector('button[data-vocab-opener="m-2"]');
    expect(opener.textContent.trim()).toBe('set type');
    expect(opener.title).toBe('Set morpheme type');
    openOn('m-2');
    expect(popover().querySelector('.igt-vocab-pop__type select')).not.toBeNull();
    choose('enclitic');
    expect(doc.sentences[0].tokens[0].morphemes[1].morphType).toBe('enclitic');
  });
});

describe('the clitic side of "=" (R49)', () => {
  it('sets "=" against an enclitic with a hair space on the host side', () => {
    mount({ linked: true });
    expect(joiner().textContent).toBe(`${HAIR}=`);
    expect(joiner().classList.contains('igt-morph-joiner--right')).toBe(true);
  });

  it('sets "=" against a proclitic with a hair space on the host side', () => {
    mount({ own: { morphType: 'proclitic' } });
    expect(joiner().textContent).toBe(`=${HAIR}`);
    expect(joiner().classList.contains('igt-morph-joiner--left')).toBe(true);
  });

  it('leaves "-" as it is', () => {
    mount();
    expect(joiner().textContent).toBe('-');
    expect(joiner().className).toBe('igt-morph-joiner');
  });
});
