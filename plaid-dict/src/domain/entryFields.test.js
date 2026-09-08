import { describe, it, expect } from 'vitest';
import {
  collectExampleRefs,
  displayForm,
  entryExamples,
  entryRefs,
  entryText,
  firstGloss,
  searchableText,
} from './entryFields.js';
import { normalizeVocabFields } from '@igt/domain/vocabFields.js';

// The Sena demo's shape: a Portuguese primary gloss, an English one named in
// the field, a custom text field, a reference field and the status field.
const fields = normalizeVocabFields({
  pos: { inline: true },
  gloss: { inline: true, lang: 'pt' },
  'gloss (en)': { inline: false },
  definition: { inline: false, lang: 'pt' },
  Plural: { inline: false, lang: 'seh' },
  morphType: { inline: false },
  status: { inline: false, tagset: 'Status' },
  seeAlso: { inline: false, type: 'item', many: true },
});

const item = (metadata, form = 'citatu') => ({ id: 'x', form, metadata });

describe('entryText', () => {
  const text = entryText(
    item({
      pos: 'N',
      gloss: 'quarta-feira',
      'gloss (en)': 'Wednesday',
      definition: 'o terceiro dia',
      Plural: 'pitatu',
      morphType: 'root',
      status: 'published',
      seeAlso: ['other'],
    }),
    fields,
  );

  it('sets the part of speech apart', () => {
    expect(text.pos).toBe('N');
  });

  it('groups the glosses and the definitions by their base name', () => {
    expect(text.glosses.map((g) => g.value)).toEqual(['quarta-feira', 'Wednesday']);
    expect(text.definitions.map((d) => d.value)).toEqual(['o terceiro dia']);
  });

  it('tags a gloss whose language is only in its name', () => {
    expect(text.glosses.map((g) => g.lang)).toEqual(['pt', 'en']);
  });

  it('leaves out status, morphType, and the reference fields', () => {
    const names = [...text.glosses, ...text.definitions, ...text.others].map((e) => e.name);
    expect(names).not.toContain('status');
    expect(names).not.toContain('morphType');
    expect(names).not.toContain('seeAlso');
    expect(text.others.map((o) => o.name)).toEqual(['Plural']);
  });

  it('drops a field the entry left empty', () => {
    const sparse = entryText(item({ gloss: '  ', 'gloss (en)': 'Wednesday' }), fields);
    expect(sparse.glosses.map((g) => g.value)).toEqual(['Wednesday']);
    expect(sparse.pos).toBeNull();
  });
});

describe('displayForm', () => {
  it('writes a bound morph the way FLEx writes one standing alone', () => {
    expect(displayForm(item({ morphType: 'prefix' }, 'ku'))).toBe('ku-');
    expect(displayForm(item({ morphType: 'enclitic' }, 'mbo'))).toBe('=mbo');
    expect(displayForm(item({ morphType: 'root' }, 'citatu'))).toBe('citatu');
    expect(displayForm(item({}, 'citatu'))).toBe('citatu');
  });
});

describe('firstGloss', () => {
  const node = (metadata, senses = []) => ({ item: item(metadata), senses });

  it('takes the first gloss the entry carries when there is no query', () => {
    expect(firstGloss(node({ gloss: 'agua', 'gloss (en)': 'water' }), fields)).toBe('agua');
  });

  it('takes the gloss the query matched', () => {
    expect(firstGloss(node({ gloss: 'agua', 'gloss (en)': 'water' }), fields, 'wat')).toBe('water');
  });

  it('reads a sense when the headword carries no gloss of its own', () => {
    const tree = node({}, [node({ gloss: 'quarta-feira', 'gloss (en)': 'Wednesday' })]);
    expect(firstGloss(tree, fields)).toBe('quarta-feira');
    expect(firstGloss(tree, fields, 'wednes')).toBe('Wednesday');
  });

  it("never lends an unpublished headword's gloss to a result", () => {
    const tree = {
      ...node({ gloss: 'DRAFT do not publish' }, [node({ gloss: 'spear' })]),
      shown: false,
    };
    expect(firstGloss(tree, fields)).toBe('spear');
    expect(firstGloss(tree, fields, 'draft')).toBe('spear');
  });

  it('falls back to a first gloss when nothing matched', () => {
    expect(firstGloss(node({ gloss: 'agua' }), fields, 'zzz')).toBe('agua');
    expect(firstGloss(node({}), fields)).toBeNull();
  });
});

describe('searchableText', () => {
  it('covers the form, the part of speech and every text field, lowercased', () => {
    const text = searchableText(
      item({ pos: 'N', gloss: 'quarta-feira', 'gloss (en)': 'Wednesday', Plural: 'pitatu' }),
      fields,
    );
    expect(text).toContain('citatu');
    expect(text).toContain('wednesday');
    expect(text).toContain('pitatu');
    expect(text).toBe(text.toLowerCase());
  });
});

describe('entryRefs', () => {
  const scoped = normalizeVocabFields({
    gloss: { inline: true },
    variantOf: { inline: false, type: 'item', scope: 'entry' },
    seeAlso: { inline: false, type: 'item', many: true },
  });
  const resolve = (id) => (id === 'gone' ? null : { id, form: id, number: '1' });

  it('reads a single reference and a many one', () => {
    const refs = entryRefs(item({ variantOf: 'head', seeAlso: ['one', 'two'] }), scoped, resolve);
    expect(refs.map((r) => r.name)).toEqual(['variantOf', 'seeAlso']);
    expect(refs[1].targets.map((t) => t.id)).toEqual(['one', 'two']);
  });

  it('drops a target the dictionary does not show, and the field with its last one', () => {
    const refs = entryRefs(item({ seeAlso: ['one', 'gone'] }), scoped, resolve);
    expect(refs[0].targets.map((t) => t.id)).toEqual(['one']);
    expect(entryRefs(item({ seeAlso: ['gone'] }), scoped, resolve)).toEqual([]);
  });

  // A headword-scope field is OFFERED on headwords; a sense that carries one
  // anyway (the user's call) still shows it, and one that does not has none.
  it('shows a headword-scope reference on a sense only when the sense holds one', () => {
    const holds = item({ parent: 'head', variantOf: 'head', seeAlso: ['one'] });
    expect(entryRefs(holds, scoped, resolve).map((r) => r.name)).toEqual(['variantOf', 'seeAlso']);
    const bare = item({ parent: 'head', seeAlso: ['one'] });
    expect(entryRefs(bare, scoped, resolve).map((r) => r.name)).toEqual(['seeAlso']);
  });
});

describe('entryExamples', () => {
  const imported = { text: 'kugwa bola', translation: 'jogar bola' };
  const promoted = { document: 'd1', token: 't1' };
  const sentences = new Map([
    [
      'd1/t1',
      {
        text: 'Ndine.',
        lines: [
          { name: 'Translation', value: 'It is me.' },
          { name: 'Note', value: 'said in greeting' },
        ],
      },
    ],
  ]);

  it('takes an imported example as it stands, its translation unnamed', () => {
    expect(entryExamples(item({ examples: [imported] }))).toEqual([
      { text: 'kugwa bola', lines: [{ name: null, value: 'jogar bola' }] },
    ]);
  });

  it('shows every layer of a promoted one when the dictionary has not chosen', () => {
    expect(entryExamples(item({ examples: [promoted] }), sentences)).toEqual([
      { text: 'Ndine.', lines: sentences.get('d1/t1').lines, document: 'd1' },
    ]);
  });

  it('shows the chosen layers, in the order they were chosen', () => {
    const [example] = entryExamples(item({ examples: [promoted] }), sentences, [
      'Note',
      'Translation',
    ]);
    expect(example.lines.map((l) => l.name)).toEqual(['Note', 'Translation']);
  });

  it('leaves out a layer that was not chosen, and one nothing chose', () => {
    const [example] = entryExamples(item({ examples: [promoted] }), sentences, ['Translation']);
    expect(example.lines.map((l) => l.name)).toEqual(['Translation']);
    expect(entryExamples(item({ examples: [promoted] }), sentences, [])[0].lines).toEqual([]);
    expect(entryExamples(item({ examples: [promoted] }), sentences, ['Nothing'])[0].lines).toEqual(
      [],
    );
  });

  it('never filters out an imported translation, which named no layer', () => {
    expect(
      entryExamples(item({ examples: [imported] }), sentences, ['Translation'])[0].lines,
    ).toEqual([{ name: null, value: 'jogar bola' }]);
    expect(entryExamples(item({ examples: [imported] }), sentences, [])[0].lines).toEqual([
      { name: null, value: 'jogar bola' },
    ]);
  });

  it('shows nothing for a promoted one whose sentence could not be read', () => {
    expect(entryExamples(item({ examples: [promoted] }), new Map())).toEqual([]);
    expect(entryExamples(item({ examples: [promoted] }), null)).toEqual([]);
    expect(entryExamples(item({}))).toEqual([]);
  });
});

describe('collectExampleRefs', () => {
  it('gathers the references on a headword and every sense under it', () => {
    const node = (metadata, senses = []) => ({ item: item(metadata), senses });
    const tree = node({ examples: [{ document: 'd1', token: 't1' }, { text: 'no ref' }] }, [
      node({ examples: [{ document: 'd2', token: 't2' }] }, [
        node({ examples: [{ document: 'd1', token: 't3' }] }),
      ]),
    ]);
    expect(collectExampleRefs(tree).map((r) => `${r.document}/${r.token}`)).toEqual([
      'd1/t1',
      'd2/t2',
      'd1/t3',
    ]);
  });
});
