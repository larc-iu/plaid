import { describe, it, expect } from 'vitest';
import {
  normalizeVocabFields,
  fieldsToConfig,
  vocabFieldTagset,
  vocabGovernedFields,
  vocabTagsetByField,
} from './vocabFields.js';

const POS = { delimiters: '', mode: 'closed', values: [{ value: 'n' }, { value: 'v' }] };
const config = { igt: { tagsets: { POS: POS } } };

describe('normalizeVocabFields / fieldsToConfig', () => {
  it('carries a field tagset and lang through, and writes them only when set', () => {
    const fields = normalizeVocabFields({
      gloss: { inline: true },
      pos: { inline: true, tagset: 'POS' },
      Plural: { inline: false, lang: 'ru' },
      legacy: true,
    });
    expect(fields.find((f) => f.name === 'pos')).toMatchObject({ tagset: 'POS', lang: null });
    expect(fields.find((f) => f.name === 'Plural')).toMatchObject({ tagset: null, lang: 'ru' });
    expect(fields.find((f) => f.name === 'legacy')).toMatchObject({ inline: true, tagset: null });
    // An unrelated edit (an inline toggle, say) must not erase either key.
    expect(fieldsToConfig(fields)).toEqual({
      morphType: { inline: false },
      gloss: { inline: true },
      pos: { inline: true, tagset: 'POS' },
      Plural: { inline: false, lang: 'ru' },
      legacy: { inline: true },
    });
  });

  it('treats a blank tagset name as none', () => {
    const [, , pos] = normalizeVocabFields({ pos: { inline: true, tagset: '  ' } });
    expect(pos.tagset).toBeNull();
    expect(fieldsToConfig([pos])).toEqual({ pos: { inline: true } });
  });
});

describe('resolving a field tagset', () => {
  it('resolves the vocabulary-level tagset a field names', () => {
    const fields = normalizeVocabFields({ pos: { inline: true, tagset: 'POS' } });
    const pos = fields.find((f) => f.name === 'pos');
    expect(vocabFieldTagset(pos, config)).toMatchObject({ mode: 'closed' });
    expect(
      vocabFieldTagset(
        fields.find((f) => f.name === 'gloss'),
        config,
      ),
    ).toBeNull();
  });

  it('governs nothing on a dangling reference, never an empty closed list', () => {
    const fields = normalizeVocabFields({ pos: { inline: true, tagset: 'Gone' } });
    expect(vocabFieldTagset(fields[2], config)).toBeNull();
    expect(vocabGovernedFields(fields, config)).toEqual([]);
    expect(vocabTagsetByField(fields, config).size).toBe(0);
  });

  it('lists governed fields in the shape TagsetsManager reads', () => {
    const fields = normalizeVocabFields({
      pos: { inline: true, tagset: 'POS' },
      'pos (ru)': { inline: false, tagset: 'POS' },
      gloss: { inline: true },
    });
    const governed = vocabGovernedFields(fields, config);
    expect(governed.map((g) => [g.name, g.field, g.scope, g.tagsetName])).toEqual([
      ['pos', 'POS', 'entry', 'POS'],
      ['pos (ru)', 'Pos (ru)', 'entry', 'POS'],
    ]);
    expect(vocabTagsetByField(fields, config).get('pos')).toEqual(governed[0].tagset);
  });
});
