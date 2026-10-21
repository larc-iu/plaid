import { describe, it, expect } from 'vitest';
import { lexiconFieldChoices, proposeLexiconField, withLexiconFields } from './lexiconField.js';

const vocab = (fields) => ({ config: { igt: { fields } } });

describe('lexiconFieldChoices', () => {
  it('lists the text fields of every vocabulary once, with the language each records', () => {
    const choices = lexiconFieldChoices([
      vocab({
        gloss: { inline: true, lang: 'pmy' },
        'gloss (en)': { lang: 'en' },
        see: { type: 'item' },
      }),
      vocab({ gloss: { inline: true, lang: 'pmy' }, category: { inline: true } }),
    ]);
    expect(choices).toEqual([
      { key: 'morphType', lang: null },
      { key: 'gloss', lang: 'pmy' },
      { key: 'gloss (en)', lang: 'en' },
      { key: 'category', lang: null },
    ]);
  });

  it('offers the fields a new vocabulary starts with when the project has none', () => {
    expect(lexiconFieldChoices([]).map((c) => c.key)).toEqual([
      'morphType',
      'gloss',
      'pos',
      'definition',
    ]);
  });
});

describe('proposeLexiconField', () => {
  const core = lexiconFieldChoices([]);

  it('proposes the entry field of the same name, across case and separators', () => {
    expect(proposeLexiconField({ name: 'Gloss', scope: 'Morpheme' }, core)).toBe('gloss');
    expect(proposeLexiconField({ name: 'POS', scope: 'Word' }, core)).toBe('pos');
    expect(proposeLexiconField({ name: 'Morph Type', scope: 'Morpheme' }, core)).toBe('morphType');
    expect(proposeLexiconField({ name: 'Part of Speech', scope: 'Word' }, core)).toBeNull();
  });

  it('pairs no sentence field', () => {
    expect(proposeLexiconField({ name: 'Gloss', scope: 'Sentence' }, core)).toBeNull();
  });

  // A FieldWorks import in two analysis languages names the annotation fields
  // "Gloss (pmy)" and "Gloss (en)" but keeps the entry's built-in `gloss`,
  // recording its language in the vocabulary's schema.
  it('proposes the same base name in the same language', () => {
    const choices = lexiconFieldChoices([
      vocab({ gloss: { lang: 'pmy' }, 'gloss (en)': { lang: 'en' } }),
    ]);
    const at = (name, lang = null) =>
      proposeLexiconField({ name, scope: 'Morpheme', lang }, choices);
    expect(at('Gloss (pmy)')).toBe('gloss');
    expect(at('Gloss (en)')).toBe('gloss (en)');
    // What the field records wins over its name.
    expect(at('Gloss (pmy)', 'en')).toBe('gloss (en)');
    expect(at('Gloss (nl)')).toBeNull();
  });
});

describe('withLexiconFields', () => {
  it('keeps a stated Lexicon field, none included, and proposes the rest', () => {
    const core = lexiconFieldChoices([]);
    expect(
      withLexiconFields(
        [
          { name: 'Gloss', scope: 'Morpheme' },
          { name: 'Gloss', scope: 'Word', lexiconField: null },
          { name: 'Meaning', scope: 'Morpheme', lexiconField: 'gloss' },
        ],
        core,
      ).map((f) => f.lexiconField),
    ).toEqual(['gloss', null, 'gloss']);
  });
});
