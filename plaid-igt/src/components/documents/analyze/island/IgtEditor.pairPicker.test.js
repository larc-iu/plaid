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
function mount({
  hold = false,
  tagset = null,
  analyzed = true,
  fields,
  lexiconFields,
  items = ITEMS,
} = {}) {
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
    lexiconFields,
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

  it('group the lexicon’s senses under their headword in Alt+Down too', async () => {
    mount();
    await settle(4);
    openAlts(cell('ma:m-4:Gloss'));
    const items = [...document.querySelectorAll('.igt-alts__item')];
    const head = items.find((r) => r.classList.contains('is-context'));
    expect(head?.querySelector('.igt-pair__entry').textContent.trim()).toBe('cat1');
    const sense = items.find((r) => r.textContent.includes('jazzman'));
    expect(sense.style.getPropertyValue('--igt-depth')).toBe('1');
  });

  it('open from any field with a Lexicon field, POS included, and from no other', async () => {
    mount({ fields: ['Gloss', 'POS', 'Note'] });
    await settle(4);
    expect(cell('ma:m-2:Gloss').title).toContain('senses and values');
    expect(cell('ma:m-2:POS').title).toContain('senses and values');
    expect(cell('ma:m-2:Note').title).not.toContain('senses');
  });

  it('leave a field named Gloss with no Lexicon field its plain list', async () => {
    mount({ fields: ['Gloss'], lexiconFields: { 'Morpheme:Gloss': null } });
    await settle(4);
    expect(cell('ma:m-2:Gloss').title).not.toContain('senses');
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
    expect(kinds(client)).toEqual(['vocabLinks.patchMetadata', 'batch.submit']);
    expect(morph(doc).vocabItem.prov).toBe('verified');
  });

  it('fills another paired field that is empty from the sense, never one a person wrote', async () => {
    const items = structuredClone(ITEMS);
    Object.assign(items.find((i) => i.id === 'c2').metadata, {
      'gloss (es)': 'jazzista',
      'gloss (fr)': 'jazzeux',
    });
    const { doc } = mount({
      fields: ['Gloss', 'Spanish', 'French', 'Gloss (de)'],
      lexiconFields: {
        'Morpheme:Spanish': 'gloss (es)',
        'Morpheme:French': 'gloss (fr)',
        'Morpheme:Gloss (de)': null,
      },
      items,
    });
    await doc.updateMorphemeSpan('m-2', 'French', 'chat');
    await settle(4);
    openChip('m-2');
    const rows = [...host.querySelectorAll('.igt-vocab-pop__item')];
    click(rows.find((r) => r.querySelector('.igt-pair__value')?.textContent === 'jazzman'));
    await settle(6);
    expect(morph(doc).annotations.Spanish.value).toBe('jazzista');
    expect(morph(doc).annotations.French.value).toBe('chat');
    expect(morph(doc).annotations['Gloss (de)'] ?? null).toBeNull();
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

// The review of the first build (REV14-PAIR, rulings 2026-10-21).
describe('what a pick leaves alone', () => {
  const rowWith = (selector, value, entry) =>
    [...document.querySelectorAll(selector)].find(
      (r) =>
        (r.querySelector('.igt-pair__value')?.textContent.trim() ?? '') === value &&
        (r.querySelector('.igt-pair__entry')?.textContent.replace(/\s+/g, '') ?? '') === entry,
    );

  it('a sense with no value of its own moves the link and leaves the gloss unconfirmed (chip)', async () => {
    const items = structuredClone(ITEMS);
    delete items.find((i) => i.id === 'c2').metadata.gloss;
    const { doc } = mount({ items });
    await settle(4);
    openChip('m-2');
    click(rowWith('.igt-vocab-pop__item', '', 'cat1.2'));
    await settle(6);
    expect(morph(doc).vocabItem.id).toBe('c2');
    expect(morph(doc).annotations.Gloss.value).toBe('feline');
    expect(morph(doc).annotations.Gloss.metadata.provConfirmed).toBeUndefined();
  });

  it('a sense whose value the tagset refuses does the same from Alt+Down', async () => {
    const { doc } = mount({
      tagset: { mode: 'closed', values: [{ value: 'DEF' }, { value: 'PL' }] },
    });
    await settle(4);
    focus(cell('ma:m-2:Gloss'));
    click(rowWith('.igt-alts__item', '', 'cat1.2'));
    await settle(6);
    expect(morph(doc).vocabItem.id).toBe('c2');
    expect(morph(doc).annotations.Gloss.value).toBe('feline');
    expect(morph(doc).annotations.Gloss.metadata.provConfirmed).toBeUndefined();
  });

  it('from the chip, a sense over a gloss a person wrote links and keeps the gloss', async () => {
    const { doc } = mount();
    await settle(4);
    await doc.updateMorphemeSpan('m-4', 'Gloss', 'cat.PL');
    await settle(4);
    openChip('m-4');
    // The row shows the gloss it keeps, the sense's own beside it.
    const row = rowWith('.igt-vocab-pop__item', 'cat.PL', 'cat1.1');
    expect(row.querySelector('.igt-pair__sense').textContent).toBe('feline');
    click(row);
    await settle(6);
    expect(morph(doc, 3).vocabItem.id).toBe('c1');
    expect(morph(doc, 3).annotations.Gloss.value).toBe('cat.PL');
    // From Alt+Down the same pick writes both: the person is choosing the gloss.
    openAlts(cell('ma:m-4:Gloss'));
    expect(rowWith('.igt-alts__item', 'jazzman', 'cat1.2')).toBeTruthy();
  });

  it('a row with no entry shows none, keeps the link and does not confirm it', async () => {
    const { doc, client } = mount();
    await settle(4);
    await doc.updateMorphemeSpan('m-4', 'Gloss', 'tom');
    await settle(4);
    openAlts(cell('ma:m-2:Gloss'));
    const tom = rowWith('.igt-alts__item', 'tom', '');
    expect(tom).toBeTruthy();
    click(tom);
    await settle(6);
    expect(morph(doc).annotations.Gloss.value).toBe('tom');
    expect(morph(doc).vocabItem).toMatchObject({ id: 'c1', prov: 'machine' });
    expect(kinds(client).some((k) => k.startsWith('vocabLinks'))).toBe(false);
  });

  it('from the chip, an accepted pair’s gloss moves with a pick of the other sense', async () => {
    const { doc } = mount();
    await settle(4);
    openChip('m-2');
    key(host.querySelector('.igt-vocab-pop__search'), 'Enter');
    await settle(6);
    expect(morph(doc).annotations.Gloss.metadata.provConfirmed).toBe(true);
    openChip('m-2');
    click(rowWith('.igt-vocab-pop__item', 'jazzman', 'cat1.2'));
    await settle(6);
    expect(morph(doc).vocabItem.id).toBe('c2');
    expect(morph(doc).annotations.Gloss.value).toBe('jazzman');
  });

  it('a row with no entry draws no detail line of the entry it carries', async () => {
    const { doc } = mount();
    await settle(4);
    await doc.updateMorphemeSpan('m-4', 'Gloss', 'tom');
    await settle(4);
    openAlts(cell('ma:m-2:Gloss'));
    expect(
      rowWith('.igt-alts__item', 'tom', '').querySelector('.igt-vocab-pop__detail'),
    ).toBeNull();
  });

  it('a typed gloss leaves the model’s link to the other sense, still unconfirmed (as ruled)', async () => {
    const { doc } = mount();
    await settle(4);
    const el = cell('ma:m-2:Gloss');
    focus(el);
    type(el, 'jazzman');
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    await settle(6);
    expect(morph(doc).annotations.Gloss.value).toBe('jazzman');
    expect(morph(doc).vocabItem).toMatchObject({ id: 'c1', prov: 'machine' });
  });
});

describe('the two doors dress a row alike', () => {
  it('Alt+Down marks the current pair to accept, starts on it, and its tooltip gives no count', async () => {
    mount();
    await settle(4);
    expect(cell('ma:m-2:Gloss').title).toMatch(/to list senses and values$/);
    openAlts(cell('ma:m-2:Gloss'));
    const active = document.querySelector('.igt-alts__item.is-active');
    expect(active.textContent).toContain('feline');
    expect(active.querySelector('.igt-vocab-pop__ok')).not.toBeNull();
  });

  it('Alt+Down starts on the first sense, past a headword shown for its senses', async () => {
    mount();
    await settle(4);
    openAlts(cell('ma:m-4:Gloss'));
    const active = document.querySelector('.igt-alts__item.is-active');
    expect(active.classList.contains('is-context')).toBe(false);
    expect(active.querySelector('.igt-pair__entry').textContent.replace(/\s+/g, '')).toBe('cat1.1');
  });

  it('starts on no row in either door when the first senses read alike', async () => {
    // Two senses told apart by nothing a person sees but their number.
    const ALIKE = [
      { id: 'h', form: 'cat', metadata: { morphType: 'stem' } },
      { id: 'c1', form: 'cat', metadata: { gloss: 'AOR', pos: 'v', parent: 'h', senseOrder: 1 } },
      { id: 'c2', form: 'cat', metadata: { gloss: 'AOR', pos: 'v', parent: 'h', senseOrder: 2 } },
      { id: 't', form: 'the', metadata: { gloss: 'DEF' } },
    ];
    const { client } = mount({ items: ALIKE });
    await settle(4);
    openAlts(cell('ma:m-4:Gloss'));
    expect(document.querySelectorAll('.igt-alts__item.is-active')).toHaveLength(0);
    key(cell('ma:m-4:Gloss'), 'Escape');
    await settle(2);
    openChip('m-4');
    await settle(4);
    expect(document.querySelectorAll('.igt-vocab-pop__item.is-active')).toHaveLength(0);
    // Enter takes nothing; an arrow lands on the first row.
    const before = client.calls.length;
    const search = document.querySelector('.igt-vocab-pop input');
    key(search, 'Enter');
    await settle(4);
    expect(client.calls.slice(before).filter((c) => /batch|vocabLinks|spans/.test(c.kind))).toEqual(
      [],
    );
    key(search, 'ArrowDown');
    await settle(2);
    expect(document.querySelectorAll('.igt-vocab-pop__item.is-active')).toHaveLength(1);
  });

  it('places the chip list at the width its CSS draws, wide enough for “no entry” and “accept”', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(
      `${process.cwd()}/src/components/documents/analyze/island/igt-editor.css`,
      'utf8',
    );
    const rule = (sel) =>
      css.match(new RegExp(`${sel.replace('.', '\\.')} \\{([^}]*)\\}`))?.[1] ?? '';
    const width = Number(rule('.igt-vocab-pop--pairs').match(/width:\s*(\d+)px/)?.[1]);
    expect(width).toBeGreaterThanOrEqual(360);
    mount();
    await settle(4);
    openChip('m-2');
    await settle(4);
    expect(editor._popWidth()).toBe(width);
    expect(rule('.igt-pair__entry')).toMatch(/white-space:\s*nowrap/);
    expect(rule('.igt-vocab-pop__ok')).toMatch(/white-space:\s*nowrap/);
  });

  it('labels a pick in History the same from either door', async () => {
    const { client } = mount();
    await settle(4);
    openChip('m-4');
    click(
      [...host.querySelectorAll('.igt-vocab-pop__item')].find(
        (r) => r.querySelector('.igt-pair__value')?.textContent === 'jazzman',
      ),
    );
    await settle(6);
    const op = client.calls.filter((c) => c.kind === 'beginOperation').at(-1);
    expect(op.args[0]).toMatch(/^Gloss of .*: jazzman$/);
  });

  it('names the vocabulary tabs for where + Create puts a new entry', async () => {
    const { doc } = mount();
    doc.vocabularies.v2 = { id: 'v2', name: 'Loans', items: [], vocabLinks: [] };
    await settle(4);
    openChip('m-2');
    const tab = host.querySelector('button.igt-vocab-pop__vocabtab');
    expect(tab?.title).toBe('Create in “Loans”');
  });
});
