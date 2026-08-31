import { describe, it, expect } from 'vitest';
import { buildLiftLexicon, groupEntries, parseFieldName, LIFT_VERSION } from './lift.js';

const parse = (xml) => {
  const dom = new DOMParser().parseFromString(xml, 'text/xml');
  expect(dom.querySelector('parsererror')).toBeNull();
  return dom;
};

const OPTIONS = { langs: { baseline: 'lez', analysis: 'en' } };

const item = (id, form, metadata = {}) => ({ id, form, metadata });

// Two senses of one FLEx entry, a hand-made item, and an affix.
const VOCAB = {
  id: 'v1',
  name: 'Lexicon',
  items: [
    item('i1', 'ktab', {
      gloss: 'book',
      'gloss (ru)': 'книга',
      definition: 'a bound volume',
      pos: 'Noun',
      morphType: 'stem',
      flexEntry: 'E1',
      flexSense: 'S1',
      examples: [{ text: 'ktab kkwa', translation: 'the book is here' }],
    }),
    item('i2', 'ktab', {
      gloss: 'letter',
      pos: 'Noun',
      morphType: 'stem',
      flexEntry: 'E1',
      flexSense: 'S2',
    }),
    item('i3', 'qhen', { gloss: 'to see', pos: 'Verb' }),
    item('i4', 'ar', { gloss: 'PL', morphType: 'suffix', flexEntry: 'E2', flexSense: 'S3' }),
  ],
};

const build = (vocabularies = [VOCAB], extra = {}) =>
  buildLiftLexicon({ vocabularies, options: OPTIONS, rangesHref: 'X.lift-ranges', ...extra });

describe('parseFieldName', () => {
  it('splits a writing-system suffix off the base', () => {
    expect(parseFieldName('gloss')).toEqual({ base: 'gloss', ws: null });
    expect(parseFieldName('gloss (ru)')).toEqual({ base: 'gloss', ws: 'ru' });
    expect(parseFieldName('Note (old) (fr)')).toEqual({ base: 'Note (old)', ws: 'fr' });
    expect(parseFieldName('')).toEqual({ base: '', ws: null });
  });
});

describe('groupEntries', () => {
  it('rejoins items that share a FLEx entry guid and keeps the rest apart', () => {
    const groups = groupEntries([VOCAB]);
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([['i1', 'i2'], ['i3'], ['i4']]);
  });

  it('scopes the guid by vocabulary so two lexicons never collapse', () => {
    const other = { id: 'v2', items: [item('j1', 'ktab', { flexEntry: 'E1' })] };
    expect(groupEntries([VOCAB, other]).length).toBe(4);
  });
});

describe('buildLiftLexicon', () => {
  it('produces well-formed LIFT 0.13 with one entry per lexeme', () => {
    const { lift, entryCount, senseCount } = build();
    const dom = parse(lift);
    expect(dom.documentElement.tagName).toBe('lift');
    expect(dom.documentElement.getAttribute('version')).toBe(LIFT_VERSION);
    expect(dom.querySelectorAll('entry').length).toBe(3);
    expect(dom.querySelectorAll('sense').length).toBe(4);
    expect(entryCount).toBe(3);
    expect(senseCount).toBe(4);
  });

  it('carries the FLEx guid so a re-import merges instead of duplicating', () => {
    const dom = parse(build().lift);
    const entry = dom.querySelector('entry[guid="E1"]');
    expect(entry).not.toBeNull();
    expect(entry.getAttribute('id')).toBe('ktab_E1');
    expect(entry.querySelectorAll('sense').length).toBe(2);
    expect([...entry.querySelectorAll('sense')].map((s) => s.getAttribute('id'))).toEqual([
      'S1',
      'S2',
    ]);
  });

  it('falls back to the item id when the item never came from FLEx', () => {
    const dom = parse(build().lift);
    const entry = [...dom.querySelectorAll('entry')].find(
      (e) => e.getAttribute('id') === 'qhen_i3',
    );
    expect(entry.hasAttribute('guid')).toBe(false);
    expect(entry.querySelector('sense').getAttribute('id')).toBe('qhen_i3_1');
  });

  it('writes the headword, glosses, definition, category and example', () => {
    const dom = parse(build().lift);
    const entry = dom.querySelector('entry[guid="E1"]');
    expect(entry.querySelector('lexical-unit form').getAttribute('lang')).toBe('lez');
    expect(entry.querySelector('lexical-unit text').textContent).toBe('ktab');
    expect(entry.querySelector('citation')).toBeNull();
    expect(entry.querySelector('trait[name="morph-type"]').getAttribute('value')).toBe('stem');

    const sense = entry.querySelector('sense');
    expect(sense.querySelector('grammatical-info').getAttribute('value')).toBe('Noun');
    const glosses = [...sense.querySelectorAll('gloss')].map((g) => [
      g.getAttribute('lang'),
      g.textContent.trim(),
    ]);
    expect(glosses).toEqual([
      ['en', 'book'],
      ['ru', 'книга'],
    ]);
    expect(sense.querySelector('definition form').getAttribute('lang')).toBe('en');
    expect(sense.querySelector('definition text').textContent).toBe('a bound volume');
    const example = sense.querySelector('example');
    expect(example.querySelector('form').getAttribute('lang')).toBe('lez');
    expect(example.querySelector('translation form').getAttribute('lang')).toBe('en');
    expect(example.querySelector('translation text').textContent).toBe('the book is here');
  });

  it('splits the lexeme form out as the citation when the two differ', () => {
    const dom = parse(
      build([{ id: 'v1', items: [item('i1', 'ktabar', { lexemeForm: 'ktab', gloss: 'books' })] }])
        .lift,
    );
    expect(dom.querySelector('lexical-unit text').textContent).toBe('ktab');
    expect(dom.querySelector('citation text').textContent).toBe('ktabar');
  });

  it('writes the homograph number as the entry order', () => {
    const dom = parse(
      build([{ id: 'v1', items: [item('i1', 'a', { homograph: 2, gloss: 'g' })] }]).lift,
    );
    expect(dom.querySelector('entry').getAttribute('order')).toBe('2');
  });

  it('only emits morph types FLEx knows', () => {
    const dom = parse(
      build([{ id: 'v1', items: [item('i1', 'a', { morphType: 'sesquifix' })] }]).lift,
    );
    expect(dom.querySelector('trait')).toBeNull();
  });

  it('turns leftover metadata into sense fields and declares them in the header', () => {
    const dom = parse(
      build([{ id: 'v1', items: [item('i1', 'a', { gloss: 'g', 'Source Note': 'Ivanov 1997' })] }])
        .lift,
    );
    const field = dom.querySelector('sense field');
    expect(field.getAttribute('type')).toBe('Source Note');
    expect(field.querySelector('text').textContent).toBe('Ivanov 1997');
    expect(dom.querySelector('header fields field').getAttribute('tag')).toBe('Source Note');
  });

  it('skips bookkeeping keys, empty values and non-scalars', () => {
    const dom = parse(build().lift);
    const types = [...dom.querySelectorAll('sense field')].map((f) => f.getAttribute('type'));
    expect(types).toEqual([]);
    const one = parse(
      build([
        {
          id: 'v1',
          items: [item('i1', 'a', { gloss: '', Empty: '', Nested: { k: 1 }, Real: 'x' })],
        },
      ]).lift,
    );
    expect([...one.querySelectorAll('sense field')].map((f) => f.getAttribute('type'))).toEqual([
      'Real',
    ]);
    expect(one.querySelector('gloss')).toBeNull();
  });

  it('keeps one form per language when a suffix collides with the primary', () => {
    const dom = parse(
      build([{ id: 'v1', items: [item('i1', 'a', { 'gloss (en)': 'second', gloss: 'primary' })] }])
        .lift,
    );
    const glosses = [...dom.querySelectorAll('gloss')];
    expect(glosses.length).toBe(1);
    expect(glosses[0].textContent.trim()).toBe('primary');
  });

  it('escapes XML specials', () => {
    const { lift } = build([{ id: 'v1', items: [item('i1', 'a<b', { gloss: 'x & y' })] }]);
    expect(lift).toContain('a&lt;b');
    expect(lift).toContain('x &amp; y');
    expect(parse(lift).querySelector('lexical-unit text').textContent).toBe('a<b');
  });

  it('collects the categories used into a .lift-ranges sidecar', () => {
    const { ranges, lift } = build();
    const dom = parse(ranges);
    expect(dom.documentElement.tagName).toBe('lift-ranges');
    expect(dom.querySelector('range').getAttribute('id')).toBe('grammatical-info');
    expect([...dom.querySelectorAll('range-element')].map((e) => e.getAttribute('id'))).toEqual([
      'Noun',
      'Verb',
    ]);
    expect(parse(lift).querySelector('header ranges range').getAttribute('href')).toBe(
      'X.lift-ranges',
    );
  });

  it('omits the ranges entirely when nothing has a category', () => {
    const { ranges, lift } = build([{ id: 'v1', items: [item('i1', 'a', { gloss: 'g' })] }]);
    expect(ranges).toBeNull();
    expect(parse(lift).querySelector('ranges')).toBeNull();
  });

  it('drops formless items with a warning rather than writing an empty headword', () => {
    const { lift, entryCount, warnings } = build([
      { id: 'v1', items: [item('i1', '', { gloss: 'g' }), item('i2', 'ok', {})] },
    ]);
    expect(entryCount).toBe(1);
    expect(warnings).toEqual(['1 lexicon item has no form and was left out of the .lift file.']);
    expect(parse(lift).querySelectorAll('entry').length).toBe(1);
  });

  it('leaves off a sense when the item says nothing a sense could hold', () => {
    const { lift, entryCount, senseCount } = build([
      { id: 'v1', items: [item('i1', 'bare', {}), item('i2', 'told', { gloss: 'g' })] },
    ]);
    const dom = parse(lift);
    expect(entryCount).toBe(2);
    expect(senseCount).toBe(1);
    expect(dom.querySelectorAll('entry').length).toBe(2);
    expect(dom.querySelectorAll('sense').length).toBe(1);
  });

  it('is well-formed with no vocabularies at all', () => {
    const { lift, entryCount, ranges } = build([]);
    expect(entryCount).toBe(0);
    expect(ranges).toBeNull();
    expect(parse(lift).querySelectorAll('entry').length).toBe(0);
  });

  it('falls back to und/en when the preset has no language tags', () => {
    const { lift } = buildLiftLexicon({
      vocabularies: [{ id: 'v1', items: [item('i1', 'a', { gloss: 'g' })] }],
    });
    const dom = parse(lift);
    expect(dom.querySelector('lexical-unit form').getAttribute('lang')).toBe('und');
    expect(dom.querySelector('gloss').getAttribute('lang')).toBe('en');
  });
});
