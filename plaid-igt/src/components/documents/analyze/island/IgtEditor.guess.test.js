import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';

// Where a placeholder suggestion came from, as the grid shows it: a lexicon
// entry reached through a link wears a teal wash and names the entry, project
// precedent stays plain and says how often it was seen, and the LINK's own
// provenance decides which of the two the cell offers first.

vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

let host;
let editor;

const ENTRY = { id: 'i-cat', form: 'cat', metadata: { pos: 'N' } };

// "the cat the": w-2 is linked to the entry above, and w-1 already carries a
// POS, so w-3 (the same form) has precedent and no link. `linkProv` is the
// metadata on the LINK, which is what decides how far the entry is trusted.
function mount({ linkProv = null } = {}) {
  const raw = buildRawDoc({
    body: 'the cat the',
    words: [
      { id: 'w-1', begin: 0, end: 3 },
      { id: 'w-2', begin: 4, end: 7 },
      { id: 'w-3', begin: 8, end: 11 },
    ],
  });
  const posLayer = raw.textLayers[0].tokenLayers
    .flatMap((tl) => tl.spanLayers || [])
    .find((sl) => sl.id === 'wsl-0');
  posLayer.spans = [{ id: 's-1', tokens: ['w-1'], value: 'DET' }];

  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const doc = new IgtDocument({
    raw,
    project: { id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {} } },
    vocabularies: {
      v1: {
        id: 'v1',
        name: 'Lexicon',
        items: [ENTRY],
        vocabLinks: [
          {
            id: 'l-1',
            tokens: ['w-2'],
            vocabItem: ENTRY,
            ...(linkProv ? { metadata: linkProv } : {}),
          },
        ],
      },
    },
    client,
    projectId: 'proj-1',
  });
  client.documents.get = async () => doc.raw;
  host = document.createElement('div');
  document.body.appendChild(host);
  editor = new IgtEditor(host, doc, {});
  return doc;
}

const cell = (key) => host.querySelector(`[data-cell-key="${key}"]`);
const cls = (key) => [...cell(key).classList];

beforeEach(() => resetIds());
afterEach(() => {
  editor?.destroy?.();
  host?.remove();
  host = null;
  editor = null;
});

describe('IgtEditor suggestion provenance', () => {
  it('washes an entry-backed suggestion and names the entry it came from', () => {
    mount();
    const c = cell('wa:w-2:POS');
    expect(c.value).toBe('');
    expect(c.placeholder).toBe('N');
    expect(cls('wa:w-2:POS')).toEqual(
      expect.arrayContaining(['igt-field--guess', 'igt-field--guess-entry']),
    );
    expect(c.title).toContain('Guess: N, from the entry “cat”');
    expect(c.title).not.toContain('unconfirmed');
  });

  it('leaves a precedent suggestion unwashed and says how often it was seen', () => {
    mount();
    const c = cell('wa:w-3:POS');
    expect(c.placeholder).toBe('DET');
    expect(cls('wa:w-3:POS')).toContain('igt-field--guess');
    expect(cls('wa:w-3:POS')).not.toContain('igt-field--guess-entry');
    expect(c.title).toContain('Guess: DET, seen 1 time in this project');
  });

  it('marks an unconfirmed auto-link, and keeps the wash', () => {
    mount({ linkProv: { prov: 'inferred', provSource: 'service:x' } });
    const c = cell('wa:w-2:POS');
    expect(c.placeholder).toBe('N');
    // The wash says where it came from either way; the link chip in the same
    // column is what says the link is unconfirmed.
    expect(cls('wa:w-2:POS')).toContain('igt-field--guess-entry');
    expect(c.title).toContain('from the entry “cat”, unconfirmed link');
  });

  it('has no suggestion, and no wash, once the cell is filled', async () => {
    const doc = mount();
    await doc.updateTokenSpan('w-2', 'POS', 'V', {});
    const c = cell('wa:w-2:POS');
    expect(c.value).toBe('V');
    expect(cls('wa:w-2:POS')).not.toContain('igt-field--guess');
    expect(cls('wa:w-2:POS')).not.toContain('igt-field--guess-entry');
  });
});

// Link state lives on the CHIP beneath a morpheme, never on the morpheme's own
// fill. The fill used to say "linked" too, which duplicated the chip in a much
// louder channel and washed whole rows; a link is a value and wears the value
// channels, exactly as a gloss does.
describe('a morpheme carries no fill of its own', () => {
  const A = { id: 'i-a', form: 'a', metadata: { morphType: 'prefix' } };
  const ROA = { id: 'i-roa', form: 'roa', metadata: { morphType: 'stem' } };

  async function mountMorphs({ linkAffix, linkStem }) {
    const raw = buildRawDoc({
      body: 'aroa',
      words: [{ id: 'w-1', begin: 0, end: 4 }],
      morphemes: [
        {
          id: 'm-1',
          begin: 0,
          end: 4,
          precedence: 1,
          metadata: { form: 'a', morphType: 'prefix' },
        },
        {
          id: 'm-2',
          begin: 0,
          end: 4,
          precedence: 2,
          metadata: { form: 'roa', morphType: 'stem' },
        },
      ],
    });
    const links = [];
    if (linkAffix) links.push({ id: 'l-a', tokens: ['m-1'], vocabItem: A });
    if (linkStem) links.push({ id: 'l-r', tokens: ['m-2'], vocabItem: ROA });
    const client = makeFakeClient();
    client.query = async () => ({ results: [] });
    const doc = new IgtDocument({
      raw,
      project: { id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {} } },
      vocabularies: { v1: { id: 'v1', name: 'Lexicon', items: [A, ROA], vocabLinks: links } },
      client,
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    editor = new IgtEditor(host, doc);
    await new Promise((r) => setTimeout(r, 0));
    return host;
  }

  it('never tints a morpheme, linked or not', async () => {
    for (const opts of [
      { linkAffix: true, linkStem: true },
      { linkAffix: true, linkStem: false },
      { linkAffix: false, linkStem: false },
    ]) {
      const root = await mountMorphs(opts);
      const classes = [...root.querySelectorAll('.igt-morph-form')].flatMap((el) => [
        ...el.classList,
      ]);
      expect(classes.filter((c) => c.startsWith('igt-morph-form--'))).toEqual([]);
      root.remove();
    }
  });

  it('shows a chip for each linked morpheme and none for an unlinked one', async () => {
    const both = await mountMorphs({ linkAffix: true, linkStem: true });
    expect(both.querySelectorAll('.igt-vocab__hint')).toHaveLength(2);
    both.remove();
    const one = await mountMorphs({ linkAffix: true, linkStem: false });
    expect(one.querySelectorAll('.igt-vocab__hint')).toHaveLength(1);
    one.remove();
    const none = await mountMorphs({ linkAffix: false, linkStem: false });
    expect(none.querySelectorAll('.igt-vocab__hint')).toHaveLength(0);
  });
});

// A confirmed auto-made link renders like a hand-made one. The mark it used to
// carry was on 216,318 links against 68 made by hand, so it distinguished
// nothing and was imperceptible at 10px besides. Cells keep theirs, where the
// ratio is the other way round.
describe('link chip provenance at rest', () => {
  const chipClasses = async (linkProv) => {
    mount({ linkProv });
    await new Promise((r) => setTimeout(r, 0));
    const chip = host.querySelector('.igt-vocab__hint');
    return [...chip.classList];
  };

  it('marks a link nobody has checked', async () => {
    expect(await chipClasses({ prov: 'inferred', provSource: 'rule:x' })).toContain(
      'igt-vocab__hint--machine',
    );
  });

  it('leaves a confirmed one plain, like a link a person made', async () => {
    const confirmed = await chipClasses({
      prov: 'inferred',
      provSource: 'rule:x',
      provConfirmed: true,
    });
    const byHand = await chipClasses(null);
    expect(confirmed).not.toContain('igt-vocab__hint--verified');
    expect(confirmed).not.toContain('igt-vocab__hint--machine');
    expect(confirmed).toEqual(byHand);
  });
});
