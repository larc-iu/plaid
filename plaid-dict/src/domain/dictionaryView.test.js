import { describe, it, expect } from 'vitest';
import {
  buildFormPages,
  buildIndex,
  buildSearchIndex,
  indexLetter,
  readDictionary,
  searchPages,
} from './dictionaryView.js';
import { normalizeVocabFields } from '@igt/domain/vocabFields.js';

// An item as the server returns one. `parent` and `senseOrder` are plaid-igt's
// reserved keys; `homograph` orders entries spelled alike.
const item = (id, form, { status, parent, senseOrder, homograph, gloss } = {}) => ({
  id,
  form,
  metadata: {
    ...(status ? { status } : {}),
    ...(parent ? { parent } : {}),
    ...(senseOrder != null ? { senseOrder } : {}),
    ...(homograph != null ? { homograph } : {}),
    ...(gloss ? { gloss } : {}),
  },
});

const pub = (id, form, rest = {}) => item(id, form, { ...rest, status: 'published' });

describe('readDictionary', () => {
  it('keeps an unpublished headword as the spine over a published sense', () => {
    const items = [item('kat', 'kat'), pub('kat1', 'kat', { parent: 'kat' })];
    const { visible, headwords } = readDictionary(items);
    expect([...visible].sort()).toEqual(['kat', 'kat1']);
    expect(headwords.map((h) => h.id)).toEqual(['kat']);
  });

  it('drops a headword with nothing published under it', () => {
    const items = [item('kat', 'kat'), item('kat1', 'kat', { parent: 'kat', status: 'draft' })];
    expect(readDictionary(items).headwords).toEqual([]);
  });

  it('drops an unpublished sense of a published headword', () => {
    const items = [
      pub('kat', 'kat'),
      pub('kat1', 'kat', { parent: 'kat' }),
      item('kat2', 'kat', { parent: 'kat', status: 'draft' }),
    ];
    const { visible } = readDictionary(items);
    expect(visible.has('kat2')).toBe(false);
  });
});

describe('buildFormPages', () => {
  it('puts every headword spelled alike on one page, in homograph order', () => {
    const items = [
      pub('cut', 'kat', { homograph: 2, gloss: 'to cut' }),
      pub('cat', 'kat', { homograph: 1, gloss: 'cat' }),
      pub('dog', 'imbwa'),
    ];
    const pages = buildFormPages(items);
    expect(pages.map((p) => p.form)).toEqual(['imbwa', 'kat']);
    const kat = pages.find((p) => p.form === 'kat');
    expect(kat.headwords.map((h) => h.item.id)).toEqual(['cat', 'cut']);
    expect(kat.headwords.map((h) => h.number)).toEqual(['1', '2']);
  });

  it('nests published senses under their headword, in sense order', () => {
    const items = [
      pub('kat', 'kat', { gloss: 'cat' }),
      pub('lioness', 'kat', { parent: 'kat', senseOrder: 2 }),
      pub('lion', 'kat', { parent: 'kat', senseOrder: 1 }),
    ];
    const [page] = buildFormPages(items);
    const [headword] = page.headwords;
    expect(headword.shown).toBe(true);
    expect(headword.senses.map((s) => s.item.id)).toEqual(['lion', 'lioness']);
    expect(headword.senses.map((s) => s.number)).toEqual(['1.1', '1.2']);
  });

  it('marks an unpublished headword as not shown but keeps it as the heading', () => {
    const items = [item('kat', 'kat'), pub('lion', 'kat', { parent: 'kat' })];
    const [page] = buildFormPages(items);
    expect(page.headwords[0].shown).toBe(false);
    expect(page.headwords[0].senses.map((s) => s.item.id)).toEqual(['lion']);
  });

  it('sorts pages with the collator it is given', () => {
    const items = [pub('a', 'zebra'), pub('b', 'apple'), pub('c', 'Ábaco')];
    const forms = buildFormPages(items, new Intl.Collator('es')).map((p) => p.form);
    expect(forms).toEqual(['Ábaco', 'apple', 'zebra']);
  });
});

describe('indexLetter', () => {
  it('files a form under its first letter, without diacritics', () => {
    expect(indexLetter('kat')).toBe('K');
    expect(indexLetter('Ábaco')).toBe('A');
    expect(indexLetter('ndzi')).toBe('N');
    expect(indexLetter('')).toBe('');
  });

  it('leaves an uncased first character as it stands', () => {
    expect(indexLetter("'ala")).toBe("'");
    expect(indexLetter('3sg')).toBe('3');
    expect(indexLetter('\u2205kap')).toBe('\u2205');
  });

  it('files a superscript letter under the letter, not a bucket of its own', () => {
    expect(indexLetter('\u1d3fkap')).toBe('R');
    expect(indexLetter('\u1d35nkat')).toBe('I');
  });
});

describe('buildIndex', () => {
  it('buckets the pages by letter, in collation order', () => {
    const pages = [{ form: 'apple' }, { form: 'Ábaco' }, { form: 'kat' }];
    expect(buildIndex(pages)).toEqual([
      { letter: 'A', forms: ['apple', 'Ábaco'] },
      { letter: 'K', forms: ['kat'] },
    ]);
  });

  it('is empty for a dictionary with no pages', () => {
    expect(buildIndex([])).toEqual([]);
  });
});

describe('buildSearchIndex / searchPages', () => {
  const fields = normalizeVocabFields({ gloss: { inline: true }, pos: { inline: true } });
  const items = [
    { id: 'water', form: 'madzi', metadata: { status: 'published', gloss: 'water' } },
    { id: 'melon', form: 'bvembe', metadata: { status: 'published', gloss: 'watermelon' } },
    { id: 'head', form: 'nsolo', metadata: { status: 'published' } },
    {
      id: 'sense',
      form: 'nsolo',
      metadata: { status: 'published', parent: 'head', gloss: 'water pot' },
    },
    { id: 'draft', form: 'zzz', metadata: { status: 'draft', gloss: 'water' } },
  ];
  const index = buildSearchIndex(items, fields);
  const pages = buildFormPages(items);

  it('indexes only what is published, in both spellings', () => {
    expect(index.has('draft')).toBe(false);
    expect(index.get('water').text).toContain('madzi');
    expect(index.get('water')).toHaveProperty('folded');
  });

  it('returns every page untouched for a blank query', () => {
    expect(searchPages(pages, '  ', index)).toEqual(pages);
  });

  it('matches a form or a gloss, and finds a hit on a sense', () => {
    expect(searchPages(pages, 'water', index).map((p) => p.form)).toEqual([
      'bvembe',
      'madzi',
      'nsolo',
    ]);
    expect(searchPages(pages, 'madz', index).map((p) => p.form)).toEqual(['madzi']);
  });

  it('puts the forms that start with the query first', () => {
    expect(searchPages(pages, 'b', index).map((p) => p.form)[0]).toBe('bvembe');
  });

  it('finds nothing for a query nothing carries', () => {
    expect(searchPages(pages, 'zzzz', index)).toEqual([]);
  });
});

// The reported failure, in the language it was found in. A lexicographer typed
// `oko` the way a speaker without a Yoruba keyboard would, got nothing, and
// said that was the moment they decided not to show the dictionary to a
// community.
describe('searchPages and the marks a keyboard cannot make', () => {
  const fields = normalizeVocabFields({ gloss: { inline: true } });
  const items = [
    { id: 'husband', form: 'ọkọ', metadata: { status: 'published', gloss: 'husband' } },
    { id: 'farm', form: 'oko', metadata: { status: 'published', gloss: 'farm' } },
    { id: 'child', form: 'ọmọ', metadata: { status: 'published', gloss: 'child' } },
    { id: 'money', form: 'owó', metadata: { status: 'published', gloss: 'money' } },
  ];
  const index = buildSearchIndex(items, fields);
  const pages = buildFormPages(items);
  const found = (q) => searchPages(pages, q, index).map((p) => p.form);

  it('finds a marked headword from an unmarked query', () => {
    expect(found('oko')).toContain('ọkọ');
  });

  it('takes a query that carries marks at its word', () => {
    // ọkọ and oko are different words. Someone who typed the marks asked for
    // one of them, and typing the marks is the only signal of that there is.
    expect(found('ọkọ')).toEqual(['ọkọ']);
    expect(found('ọmọ')).toEqual(['ọmọ']);
  });

  it('ranks the form spelled as typed above the one that only folds to it', () => {
    // Both match `oko`; the unmarked headword is what was literally asked for.
    expect(found('oko')[0]).toBe('oko');
  });

  it('folds a mark in a gloss too, not only in a form', () => {
    const withAccent = [
      { id: 'x', form: 'abc', metadata: { status: 'published', gloss: 'jalapeño' } },
    ];
    const idx = buildSearchIndex(withAccent, fields);
    const pgs = buildFormPages(withAccent);
    expect(searchPages(pgs, 'jalapeno', idx).map((p) => p.form)).toEqual(['abc']);
  });

  it('leaves a letter with no decomposition alone', () => {
    // NFKD does not take the stroke off an l, so `l` must not find `ł`.
    const polish = [{ id: 'p', form: 'łuk', metadata: { status: 'published', gloss: 'bow' } }];
    const idx = buildSearchIndex(polish, fields);
    const pgs = buildFormPages(polish);
    expect(searchPages(pgs, 'luk', idx)).toEqual([]);
    expect(searchPages(pgs, 'łuk', idx).map((p) => p.form)).toEqual(['łuk']);
  });
});

// The nineteen headwords of the Yoruba dictionary the finding came from, four
// of which differ from each other only in their marks.
describe('searchPages over a real tone-marked dictionary', () => {
  const fields = normalizeVocabFields({ gloss: { inline: true } });
  const FORMS = [
    'igba',
    'igbá',
    'ilé',
    'jẹ',
    'lọ',
    'omi',
    'owó',
    'pupa',
    'ìgbà',
    'ìgbá',
    'ìwé',
    'ẹja',
    'ọkọ',
    'ọkọ̀',
    'ọkọ́',
    'ọmọ',
    'ọwọ́',
    'ọ̀kọ̀',
    'ọ̀wọ̀',
  ];
  const items = FORMS.map((form, i) => ({
    id: `i${i}`,
    form,
    metadata: { status: 'published', gloss: 'x' },
  }));
  const index = buildSearchIndex(items, fields);
  const pages = buildFormPages(items);
  const find = (q) => searchPages(pages, q, index).map((p) => p.form);

  it('reaches every marked spelling from a bare one', () => {
    expect(find('oko')).toEqual(['ọkọ', 'ọkọ́', 'ọkọ̀', 'ọ̀kọ̀']);
    expect(find('owo')).toEqual(['owó', 'ọwọ́', 'ọ̀wọ̀']);
    expect(find('eja')).toEqual(['ẹja']);
  });

  it('puts the form spelled exactly as typed first', () => {
    // igba, igbá, ìgbà and ìgbá are four words that fold together.
    expect(find('igba')).toEqual(['igba', 'igbá', 'ìgbá', 'ìgbà']);
  });

  it('narrows to one word when the marks are typed', () => {
    expect(find('ìgbà')).toEqual(['ìgbà']);
    expect(find('ọ̀kọ̀')).toEqual(['ọ̀kọ̀']);
  });

  it('still extends a marked query the way any substring search does', () => {
    // Not a folding effect: `ọkọ́` literally starts with `ọkọ`, exactly as
    // `igb` reaches `igba`. Marks make a query precise, not anchored.
    expect(find('ọkọ')).toEqual(['ọkọ', 'ọkọ́', 'ọkọ̀']);
  });
});
