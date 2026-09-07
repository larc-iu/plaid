import { describe, it, expect } from 'vitest';
import { displayForm, entryText, firstGloss, searchableText } from './entryFields.js';
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
