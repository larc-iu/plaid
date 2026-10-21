// The pair picker: Alt+Down on a morpheme's gloss and a click on its lexicon
// chip list the same rows, each a sense and a value, and a pick from either
// writes the link and the gloss together, shown before the server answers.
// Typing a gloss changes only the gloss.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildRawDoc,
  makeFakeClient,
  resetIds,
  makeIgtDoc,
  settle,
  mountIsland,
} from '@/domain/test-helpers.js';
import { isPendingId } from '@ui/domain/pendingIds.js';

vi.mock('@/utils/feedback', () => ({
  notifyWarning: vi.fn(),
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

let host;
let editor;

const MACHINE = { prov: 'inferred', provSource: 'service:m' };
// "cat" is a headword with two senses, and "the" an entry of its own.
const ITEMS = [
  { id: 'h', form: 'cat', metadata: { morphType: 'stem' } },
  { id: 'c1', form: 'cat', metadata: { gloss: 'feline', parent: 'h', senseOrder: 1 } },
  { id: 'c2', form: 'cat', metadata: { gloss: 'jazzman', parent: 'h', senseOrder: 2 } },
  { id: 't', form: 'the', metadata: { gloss: 'DEF' } },
];

// "the cat the cat": the first "cat" (m-2) glossed and linked by a model
// that weighed both senses. `hold` keeps every batch until `release()`.
function mount({ hold = false, tagset = null, analyzed = true, fields, items = ITEMS } = {}) {
  const raw = buildRawDoc({
    body: 'the cat the cat',
    words: [
      { id: 'w-1', begin: 0, end: 3 },
      { id: 'w-2', begin: 4, end: 7 },
      { id: 'w-3', begin: 8, end: 11 },
      { id: 'w-4', begin: 12, end: 15 },
    ],
    ...(analyzed ? {} : { morphemes: [] }),
    ...(fields ? { morphFields: fields } : {}),
  });
  const gloss = raw.textLayers[0].tokenLayers[2].spanLayers[0];
  if (analyzed) {
    gloss.spans.push({
      id: 'sp-2',
      tokens: ['m-2'],
      value: 'feline',
      metadata: {
        ...MACHINE,
        provDetail: {
          value: 'feline',
          valueProbs: { feline: 0.6, jazzman: 0.3 },
          valueLinks: [
            { value: 'feline', item: 'c1', prob: 0.6 },
            { value: 'jazzman', item: 'c2', prob: 0.3 },
          ],
        },
      },
    });
  }
  if (tagset) gloss.config.igt.tagset = 'T';
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const lexicon = {
    id: 'v1',
    name: 'Lexicon',
    maintainers: [],
    config: { igt: { fields: { gloss: { inline: true } } } },
  };
  // The popover reads the lexicon again when it opens.
  client.vocabLayers = { get: async () => ({ ...lexicon, items: structuredClone(items) }) };
  let release = () => {};
  if (hold) {
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
  }
  const doc = makeIgtDoc({
    raw,
    project: {
      id: 'proj-1',
      vocabs: [{ id: 'v1' }],
      config: { plaid: {}, igt: tagset ? { tagsets: { T: tagset } } : {} },
    },
    vocabularies: {
      v1: {
        ...lexicon,
        items: structuredClone(items),
        vocabLinks: analyzed
          ? [
              {
                id: 'l-2',
                tokens: ['m-2'],
                vocabItem: { id: 'c1', layer: 'v1', form: 'cat' },
                metadata: MACHINE,
              },
            ]
          : [],
      },
    },
    client,
    user: { id: 'wren@example.com' },
  });
  client.documents.get = async () => doc.raw;
  ({ host, editor } = mountIsland(doc, { canManageVocab: () => true }));
  return { doc, client, release };
}

const cell = (key) => host.querySelector(`[data-cell-key="${key}"]`);
const morph = (doc, w = 1) => doc.sentences[0].tokens[w].morphemes[0];
const kinds = (client) =>
  client.calls.map((c) => c.kind).filter((k) => !/Operation|operationGroups|query/.test(k));
const key = (el, k, init = {}) =>
  el.dispatchEvent(
    new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }),
  );
const click = (el, init = {}) =>
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
const focus = (el) => {
  el.focus();
  el.dispatchEvent(new Event('focus', { bubbles: true }));
};
const type = (el, value) => {
  el.value = value;
  el.setSelectionRange(value.length, value.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

// A list's rows as [value, entry].
const rowsIn = (selector) =>
  [...document.querySelectorAll(selector)].map((r) => [
    r.querySelector('.igt-pair__value')?.textContent.trim(),
    r.querySelector('.igt-pair__entry')?.textContent.replace(/\s+/g, ' ').trim(),
  ]);
const altRows = () => rowsIn('.igt-alts__item');
const chipRows = () => rowsIn('.igt-vocab-pop__item');
const openAlts = (el) => {
  focus(el);
  key(el, 'ArrowDown', { altKey: true });
};
const openChip = (id) => click(host.querySelector(`button[data-vocab-opener="${id}"]`));

beforeEach(() => resetIds());
afterEach(() => {
  editor?.destroy();
  host?.remove();
  editor = null;
  host = null;
});

describe('the two doors', () => {
  it('list the same rows, the current pair first', async () => {
    mount();
    await settle(4);
    openAlts(cell('ma:m-2:Gloss'));
    const fromCell = altRows();
    expect(fromCell[0]).toEqual(['feline', 'cat1.1']);
    expect(fromCell[1]).toEqual(['jazzman', 'cat1.2']);
    key(cell('ma:m-2:Gloss'), 'Escape');
    openChip('m-2');
    expect(chipRows()).toEqual(fromCell);
  });

  it('leave a field that is not a gloss its plain list of values', async () => {
    mount({ fields: ['Gloss', 'POS'] });
    await settle(4);
    expect(cell('ma:m-2:POS').title).not.toContain('senses');
    expect(cell('ma:m-2:Gloss').title).toContain('senses and values');
  });
});

describe('a pick from Alt+Down', () => {
  it('writes the link and the gloss in one batch, shown before the server answers', async () => {
    const { doc, client, release } = mount({ hold: true });
    await settle(4);
    const el = cell('ma:m-2:Gloss');
    openAlts(el);
    key(el, 'ArrowDown');
    key(el, 'Enter');
    await settle(2);
    expect(morph(doc).annotations.Gloss.value).toBe('jazzman');
    expect(morph(doc).vocabItem.id).toBe('c2');
    release();
    await settle(6);
    expect(kinds(client)).toEqual([
      'spans.update',
      'spans.patchMetadata',
      'vocabLinks.delete',
      'vocabLinks.create',
      // The entry's type, cached on the morpheme it is now linked to.
      'tokens.patchMetadata',
      'batch.submit',
    ]);
    // The link adopts the producer's suggestion.
    const link = client.calls.find((c) => c.kind === 'vocabLinks.create');
    expect(link.args[2]).toMatchObject({ provSource: 'service:m', provConfirmed: true });
  });

  it('typing the other sense’s gloss changes the gloss only', async () => {
    const { doc, client } = mount();
    await settle(4);
    const el = cell('ma:m-2:Gloss');
    focus(el);
    type(el, 'jazzman');
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    await settle(6);
    expect(morph(doc).annotations.Gloss.value).toBe('jazzman');
    expect(morph(doc).vocabItem.id).toBe('c1');
    expect(kinds(client).some((k) => k.startsWith('vocabLinks'))).toBe(false);
  });
});

describe('a pick from the chip', () => {
  it('writes the link and the gloss in one batch, shown before the server answers', async () => {
    const { doc, client, release } = mount({ hold: true });
    await settle(4);
    openChip('m-2');
    const search = host.querySelector('.igt-vocab-pop__search');
    // The current pair is where the keyboard starts.
    expect(host.querySelector('.igt-vocab-pop__item.is-active .igt-pair__value').textContent).toBe(
      'feline',
    );
    key(search, 'ArrowDown');
    key(search, 'Enter');
    await settle(2);
    expect(morph(doc).annotations.Gloss.value).toBe('jazzman');
    expect(morph(doc).vocabItem.id).toBe('c2');
    release();
    await settle(6);
    expect(kinds(client).filter((k) => k === 'batch.submit')).toHaveLength(1);
  });

  it('confirms the current pair on Enter, and unlinks from its unlink', async () => {
    const { doc, client } = mount();
    await settle(4);
    openChip('m-2');
    expect(host.querySelector('.igt-vocab-pop__item.is-linked .igt-vocab-pop__ok')).not.toBeNull();
    key(host.querySelector('.igt-vocab-pop__search'), 'Enter');
    await settle(6);
    expect(kinds(client)).toEqual([
      'spans.patchMetadata',
      'vocabLinks.patchMetadata',
      'batch.submit',
    ]);
    expect(morph(doc).vocabItem.prov).toBe('verified');

    openChip('m-2');
    click(host.querySelector('.igt-vocab-pop__item.is-linked .igt-vocab-pop__x'));
    await settle(6);
    expect(morph(doc).vocabItem ?? null).toBeNull();
    expect(morph(doc).annotations.Gloss.value).toBe('feline');
  });

  it('a row found by searching is the person’s own link, not the model’s', async () => {
    const { doc, client } = mount();
    await settle(4);
    openChip('m-2');
    const search = host.querySelector('.igt-vocab-pop__search');
    search.value = 'jazz';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const rows = [...host.querySelectorAll('.igt-vocab-pop__item')];
    click(rows.find((r) => r.querySelector('.igt-pair__value')?.textContent === 'jazzman'));
    await settle(6);
    expect(morph(doc).vocabItem.id).toBe('c2');
    const link = client.calls.find((c) => c.kind === 'vocabLinks.create');
    expect(link.args[2]?.provSource).toBeUndefined();
  });

  it('with no gloss field, lists entries and confirms the current link on Enter', async () => {
    const { doc, client } = mount({ fields: ['Note'] });
    await settle(4);
    openChip('m-2');
    expect(chipRows()[0]).toEqual(['', 'cat1.1']);
    key(host.querySelector('.igt-vocab-pop__search'), 'Enter');
    await settle(6);
    expect(kinds(client)).toEqual(['vocabLinks.patchMetadata']);
    expect(morph(doc).vocabItem.prov).toBe('verified');
  });

  it('fills another gloss field that is empty from the sense, never one a person wrote', async () => {
    const items = structuredClone(ITEMS);
    Object.assign(items.find((i) => i.id === 'c2').metadata, {
      'gloss (es)': 'jazzista',
      'gloss (fr)': 'jazzeux',
    });
    const { doc } = mount({ fields: ['Gloss', 'Gloss (es)', 'Gloss (fr)'], items });
    await doc.updateMorphemeSpan('m-2', 'Gloss (fr)', 'chat');
    await settle(4);
    openChip('m-2');
    const rows = [...host.querySelectorAll('.igt-vocab-pop__item')];
    click(rows.find((r) => r.querySelector('.igt-pair__value')?.textContent === 'jazzman'));
    await settle(6);
    expect(morph(doc).annotations['Gloss (es)'].value).toBe('jazzista');
    expect(morph(doc).annotations['Gloss (fr)'].value).toBe('chat');
  });

  it('takes the other unlinked same-form morphemes along to the entry with “all”', async () => {
    const { doc } = mount();
    await settle(4);
    openChip('m-2');
    const search = host.querySelector('.igt-vocab-pop__search');
    key(search, 'ArrowDown');
    key(search, 'Enter', { shiftKey: true });
    await settle(8);
    expect(morph(doc).vocabItem.id).toBe('c2');
    expect(morph(doc, 3).vocabItem?.id).toBe('c2');
    // The others get the link only.
    expect(morph(doc, 3).annotations.Gloss ?? null).toBeNull();
  });

  it('+ Create makes the entry with the form and leaves the gloss', async () => {
    const { doc, client } = mount();
    await settle(4);
    openChip('m-2');
    click(host.querySelector('.igt-vocab-pop__create'));
    click(host.querySelector('.igt-vocab-pop__create'));
    await settle(6);
    expect(client.calls.some((c) => c.kind === 'vocabItems.create')).toBe(true);
    expect(morph(doc).annotations.Gloss.value).toBe('feline');
  });

  it('on a word nobody has analyzed, gives focus back to the chip of the morpheme it made', async () => {
    const { doc, release } = mount({ hold: true, analyzed: false });
    await settle(4);
    openChip('virtual:w-2');
    const rows = [...host.querySelectorAll('.igt-vocab-pop__item')];
    click(rows.find((r) => r.querySelector('.igt-pair__value')?.textContent === 'jazzman'));
    await settle(2);
    expect(isPendingId(morph(doc).id)).toBe(true);
    expect(morph(doc).annotations.Gloss.value).toBe('jazzman');
    release();
    await settle(8);
    const real = morph(doc).id;
    expect(isPendingId(real)).toBe(false);
    expect(morph(doc).vocabItem.id).toBe('c2');
    expect(document.activeElement?.dataset.vocabOpener).toBe(real);
  });
});

describe('a governed gloss cell', () => {
  const TAGS = { mode: 'closed', values: [{ value: 'DEF' }, { value: 'PL' }] };

  it('opens the pair rows on focus, and hands an unsteered Enter back to the cell', async () => {
    const { doc, client } = mount({ tagset: TAGS });
    await settle(4);
    const el = cell('ma:m-1:Gloss');
    focus(el);
    expect(document.querySelector('.igt-alts .igt-pair')).not.toBeNull();
    // The sense "the" has a gloss the tagset allows: a pair.
    expect(altRows()).toContainEqual(['DEF', 'the']);
    type(el, 'PL');
    key(el, 'Enter');
    await settle(6);
    expect(morph(doc, 0).annotations.Gloss.value).toBe('PL');
    expect(kinds(client).some((k) => k.startsWith('vocabLinks'))).toBe(false);
  });

  it('lists the parts once something is typed, under a tagset that splits values', async () => {
    mount({
      tagset: { mode: 'closed', delimiters: '.', values: [{ value: '1SG' }, { value: 'NOM' }] },
    });
    await settle(4);
    const el = cell('ma:m-1:Gloss');
    focus(el);
    expect(document.querySelector('.igt-alts .igt-pair')).not.toBeNull();
    type(el, '1SG.');
    expect(document.querySelector('.igt-alts .igt-pair')).toBeNull();
    expect([...document.querySelectorAll('.igt-alts__value')].map((n) => n.textContent)).toEqual(
      expect.arrayContaining(['1SG', 'NOM']),
    );
  });

  it('keeps the link of a sense whose gloss the tagset refuses, the value left out', async () => {
    mount({ tagset: TAGS });
    await settle(4);
    focus(cell('ma:m-2:Gloss'));
    // "feline" and "jazzman" are not tags: the senses stay, valueless.
    expect(altRows()).toContainEqual(['', 'cat1.2']);
    expect(altRows().some(([v]) => v === 'jazzman')).toBe(false);
  });
});
