import { describe, it, expect } from 'vitest';
import {
  buildLiftLexicon,
  collectExampleRefs,
  groupEntries,
  parseFieldName,
  LIFT_VERSION,
} from './lift.js';
import { exampleKey } from '../domain/vocabDictionary.js';

const parse = (xml) => {
  const dom = new DOMParser().parseFromString(xml, 'text/xml');
  expect(dom.querySelector('parsererror')).toBeNull();
  return dom;
};

const OPTIONS = { langs: { baseline: 'lez', analysis: 'en' } };

const item = (id, form, metadata = {}) => ({ id, form, metadata });

// A headword with a sense under it (both once FLEx senses of one entry), a
// hand-made item, and an affix. The tree, not the FLEx guids, is the structure.
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
      parent: 'i1',
      senseOrder: 1,
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
  it('makes an entry of every headword with its senses under it', () => {
    const groups = groupEntries([VOCAB]);
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([['i1', 'i2'], ['i3'], ['i4']]);
    expect(groups[0].head.id).toBe('i1');
    expect(groups[0].senses.map((n) => n.item.id)).toEqual(['i2']);
  });

  it('ignores a shared FLEx guid: items only join through the tree', () => {
    const other = {
      id: 'v2',
      items: [item('j1', 'ktab', { flexEntry: 'E1' }), item('j2', 'ktab', { flexEntry: 'E1' })],
    };
    expect(groupEntries([VOCAB, other]).length).toBe(5);
  });

  it('nests a sense of a sense as a subsense', () => {
    const vocab = {
      id: 'v3',
      items: [
        item('h', 'kat', { gloss: 'cat' }),
        item('s', 'kat', { gloss: 'lion', parent: 'h', senseOrder: 1 }),
        item('ss', 'kat', { gloss: 'lioness', parent: 's', senseOrder: 1 }),
      ],
    };
    const dom = parse(build([vocab]).lift);
    const entry = dom.querySelector('entry');
    expect(entry.querySelectorAll(':scope > sense').length).toBe(2);
    const lion = [...entry.querySelectorAll(':scope > sense')].find((s) =>
      /lion/.test(s.textContent),
    );
    expect(lion.querySelector('subsense')).not.toBeNull();
    expect(lion.querySelector('subsense gloss text').textContent).toBe('lioness');
    expect(build([vocab]).senseCount).toBe(3);
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
    expect(entry.getAttribute('id')).toBe('ktab_i1');
    expect(entry.querySelectorAll('sense').length).toBe(2);
    expect([...entry.querySelectorAll('sense')].map((s) => s.getAttribute('id'))).toEqual([
      'S1',
      'S2',
    ]);
  });

  it('gives every entry its own id, even when they came from one FLEx entry', () => {
    // Imported without Lexicography Mode, each FLEx sense is its own entry and
    // they all carry the same guid. Sharing an id would make the file invalid.
    const { lift } = build([
      {
        id: 'v1',
        items: [
          item('a', 'kat', { gloss: 'cat', flexEntry: 'E1', flexSense: 'S1' }),
          item('b', 'kat', { gloss: 'lion', flexEntry: 'E1', flexSense: 'S2' }),
        ],
      },
    ]);
    const ids = [...parse(lift).querySelectorAll('entry')].map((e) => e.getAttribute('id'));
    expect(ids).toEqual(['kat_a', 'kat_b']);
    expect(new Set(ids).size).toBe(2);
    // The guid, which is what a FLEx re-import merges on, is untouched.
    expect([...parse(lift).querySelectorAll('entry')].map((e) => e.getAttribute('guid'))).toEqual([
      'E1',
      'E1',
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

  it('groups a field written in several writing systems into one <field>', () => {
    const dom = parse(
      build([
        {
          id: 'v1',
          items: [item('i1', 'a', { Comment: 'checked', 'Comment (ru)': 'проверено' })],
        },
      ]).lift,
    );
    const fields = [...dom.querySelectorAll('sense field')];
    expect(fields.length).toBe(1);
    expect(fields[0].getAttribute('type')).toBe('Comment');
    expect([...fields[0].querySelectorAll('form')].map((f) => f.getAttribute('lang'))).toEqual([
      'en',
      'ru',
    ]);
  });

  it('tags a single-writing-system field with the language the vocabulary records', () => {
    const dom = parse(
      build([
        {
          id: 'v1',
          config: { igt: { fields: { Plural: { lang: 'seh' }, Note: {} } } },
          items: [item('i1', 'a', { Plural: 'mabvi', Note: 'checked' })],
        },
      ]).lift,
    );
    const langOf = (type) =>
      dom.querySelector(`sense field[type="${type}"] form`).getAttribute('lang');
    // FLEx pins each custom field to one writing system, so "Plural" is
    // vernacular even though its value is a bare string.
    expect(langOf('Plural')).toBe('seh');
    expect(langOf('Note')).toBe('en');
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

  it('writes a promoted example from the sentence it points into', () => {
    const vocab = {
      id: 'v1',
      items: [
        item('i1', 'ktab', {
          gloss: 'book',
          examples: [
            { document: 'd1', token: 't1' },
            { text: 'ktab kkwa', translation: 'the book is here' },
          ],
        }),
      ],
    };
    const { lift } = build([vocab], {
      exampleTexts: new Map([
        [exampleKey('d1', 't1'), { text: 'am ktab', translation: 'that book' }],
      ]),
    });
    const examples = [...parse(lift).querySelectorAll('example')];
    // Both kinds, in the order the entry holds them.
    expect(examples.map((e) => e.querySelector('form text').textContent)).toEqual([
      'am ktab',
      'ktab kkwa',
    ]);
    expect(examples[0].querySelector('translation text').textContent).toBe('that book');
    expect(examples[0].querySelector('form').getAttribute('lang')).toBe('lez');
  });

  it('leaves out an example whose sentence could not be read, and says how many', () => {
    const vocab = {
      id: 'v1',
      items: [item('i1', 'ktab', { gloss: 'book', examples: [{ document: 'd1', token: 'gone' }] })],
    };
    const { lift, warnings } = build([vocab], { exampleTexts: new Map() });
    expect(parse(lift).querySelector('example')).toBeNull();
    expect(warnings).toEqual([
      '1 example could not be read from the document it points into and was left out of the .lift file.',
    ]);
  });

  it('collects every promoted reference once', () => {
    const refs = collectExampleRefs([
      {
        id: 'v1',
        items: [
          item('i1', 'a', {
            examples: [{ document: 'd1', token: 't1' }, { text: 'imported' }],
          }),
          item('i2', 'b', {
            examples: [
              { document: 'd1', token: 't1' },
              { document: 'd2', token: 't9' },
            ],
          }),
        ],
      },
    ]);
    expect(refs).toEqual([
      { document: 'd1', token: 't1' },
      { document: 'd2', token: 't9' },
    ]);
  });

  it('writes a reference field as a relation, and declares its type', () => {
    const vocab = {
      id: 'v1',
      config: { igt: { fields: { gloss: {}, variantOf: { type: 'item', many: true } } } },
      items: [
        item('h', 'kat', { gloss: 'cat' }),
        item('s', 'kat', { gloss: 'lion', parent: 'h', senseOrder: 1 }),
        item('v', 'katt', { gloss: 'cat', variantOf: ['h', 's', 'gone'] }),
      ],
    };
    const { lift, ranges } = build([vocab]);
    const dom = parse(lift);
    const relations = [...dom.querySelectorAll('relation')];
    // A headword is referred to by its entry id, a sense by its sense id, and
    // a reference to nothing is left out.
    expect(relations.map((r) => r.getAttribute('ref'))).toEqual(['kat_h', 'kat_h_2']);
    expect(relations.every((r) => r.getAttribute('type') === 'variantOf')).toBe(true);
    // The ids it points at are the ones the file actually wrote.
    expect(dom.querySelector('entry').getAttribute('id')).toBe('kat_h');
    expect([...dom.querySelectorAll('sense')].map((x) => x.getAttribute('id'))).toContain(
      'kat_h_2',
    );
    // And the relation type is declared as a range, not left to be guessed.
    const rangeDom = parse(ranges);
    expect([...rangeDom.querySelectorAll('range')].map((r) => r.getAttribute('id'))).toContain(
      'lexical-relation',
    );
    expect(
      rangeDom.querySelector('range[id="lexical-relation"] range-element').getAttribute('id'),
    ).toBe('variantOf');
    // Never as a field: an id is not text.
    expect(dom.querySelector('field[type="variantOf"]')).toBeNull();
  });

  it('writes a headword-only reference on the entry, not inside a sense', () => {
    const vocab = {
      id: 'v1',
      config: {
        igt: {
          fields: {
            gloss: {},
            variantOf: { type: 'item', many: true, scope: 'entry' },
            seeAlso: { type: 'item' },
          },
        },
      },
      items: [
        item('h', 'kat', { gloss: 'cat' }),
        item('s', 'kat', { gloss: 'lion', parent: 'h', senseOrder: 1, seeAlso: 'v' }),
        item('v', 'katt', { gloss: 'cat', variantOf: ['h'] }),
      ],
    };
    const dom = parse(build([vocab]).lift);
    const entries = [...dom.querySelectorAll('entry')];
    const variant = entries.find((e) => e.getAttribute('id') === 'katt_v');
    expect(variant.querySelector(':scope > relation').getAttribute('ref')).toBe('kat_h');
    expect(variant.querySelector('sense relation')).toBeNull();
    // A sense-scoped one stays with the sense that holds it.
    const main = entries.find((e) => e.getAttribute('id') === 'kat_h');
    expect(main.querySelector(':scope > relation')).toBeNull();
    expect(main.querySelector('sense relation').getAttribute('type')).toBe('seeAlso');
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

describe('a headword that stands over senses', () => {
  const FIELDS = { igt: { dictionary: true, fields: { Note: { inline: false } } } };
  const container = (extra = {}) => [
    {
      id: 'v1',
      config: FIELDS,
      items: [
        item('h', 'perro', { Note: 'from the field', flexEntry: 'E1', ...extra }),
        item('s1', 'perro', { gloss: 'dog', parent: 'h', senseOrder: 1, Note: 'from the field' }),
        item('s2', 'perro', { gloss: 'scoundrel', parent: 'h', senseOrder: 2 }),
      ],
    },
  ];

  it('is not written as a sense of its own, and its fields go on the entry', () => {
    const { lift, senseCount } = build(container());
    const doc = parse(lift);
    expect(senseCount).toBe(2);
    expect([...doc.querySelectorAll('entry > sense')].length).toBe(2);
    expect([...doc.querySelectorAll('entry > sense gloss text')].map((t) => t.textContent)).toEqual(
      ['dog', 'scoundrel'],
    );
    // The headword's own field is the entry's, not a gloss-less first sense.
    const field = doc.querySelector('entry > field[type="Note"]');
    expect(field).not.toBeNull();
    expect(field.textContent.trim()).toBe('from the field');
  });

  it('counts an unresolvable example once, not twice', () => {
    // headIsASense used to decide by RENDERING the head's examples, and
    // examplesXml counts an unreadable reference as a side effect.
    const { warnings } = build(
      [
        {
          id: 'v1',
          config: FIELDS,
          items: [
            item('h', 'perro', {
              examples: [
                { document: 'd1', token: 't1' },
                { document: 'gone', token: 'nope' },
              ],
            }),
            item('s1', 'perro', { gloss: 'dog', parent: 'h', senseOrder: 1 }),
            item('s2', 'perro', { gloss: 'scoundrel', parent: 'h', senseOrder: 2 }),
          ],
        },
      ],
      { exampleTexts: new Map([['d1/t1', { text: 'el perro corre' }]]) },
    );
    const unresolved = warnings.filter((w) => /could not be read/.test(w));
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]).toMatch(/^1 example/);
  });

  it('stays out of the senses when its only example is unreadable', () => {
    // The example counts as data but renders to nothing, so deciding by the
    // raw list puts a gloss-less sense in front of every real one.
    const { lift, senseCount, warnings } = build(
      [
        {
          id: 'v1',
          config: FIELDS,
          items: [
            item('h', 'perro', {
              Note: 'from the field',
              examples: [{ document: 'gone', token: 'x' }],
            }),
            item('s1', 'perro', { gloss: 'dog', parent: 'h', senseOrder: 1 }),
            item('s2', 'perro', { gloss: 'scoundrel', parent: 'h', senseOrder: 2 }),
          ],
        },
      ],
      { exampleTexts: new Map() },
    );
    expect(senseCount).toBe(2);
    const doc = parse(lift);
    expect([...doc.querySelectorAll('entry > sense')].length).toBe(2);
    expect(doc.querySelector('entry > field[type="Note"]')).not.toBeNull();
    // Dropped rather than exported, so it is still reported, exactly once.
    expect(warnings.filter((w) => /could not be read/.test(w))).toHaveLength(1);
  });

  it('is written as the first sense when it has a meaning of its own', () => {
    const { lift, senseCount } = build(container({ gloss: 'dog (generally)' }));
    expect(senseCount).toBe(3);
    expect(
      [...parse(lift).querySelectorAll('entry > sense gloss text')].map((t) => t.textContent),
    ).toEqual(['dog (generally)', 'dog', 'scoundrel']);
  });
});

describe('relations', () => {
  it('never names an entry or a sense the file does not contain', () => {
    const { lift } = build([
      {
        id: 'v1',
        config: { igt: { dictionary: true, fields: { seeAlso: { type: 'item', many: true } } } },
        items: [
          item('a', 'a', { gloss: 'a', seeAlso: ['formless', 'empty', 'gone'] }),
          item('formless', '', { gloss: 'no form' }),
          // A sense with nothing but its place: written only because a
          // reference names it.
          item('empty', 'empty', { parent: 'a', senseOrder: 1 }),
        ],
      },
    ]);
    const doc = parse(lift);
    const ids = new Set(
      [...doc.querySelectorAll('entry, sense, subsense')].map((el) => el.getAttribute('id')),
    );
    const refs = [...doc.querySelectorAll('relation')].map((r) => r.getAttribute('ref'));
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ids.has(ref)).toBe(true);
  });
});
