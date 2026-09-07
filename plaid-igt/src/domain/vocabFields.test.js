import { describe, it, expect } from 'vitest';
import {
  normalizeVocabFields,
  fieldsToConfig,
  vocabFieldTagset,
  vocabGovernedFields,
  vocabTagsetByField,
  fieldBaseName,
  isBuiltInField,
  editableMetadata,
  reservedMetadata,
  fieldLabel,
  groupFieldsForForm,
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

  it('carries type, many and scope through, writing only the non-defaults', () => {
    const fields = normalizeVocabFields({
      gloss: { inline: true, type: 'item', scope: 'entry' },
      variantOf: { inline: false, type: 'item' },
      seeAlso: { inline: false, type: 'item', many: true },
      etymology: { inline: false, scope: 'entry', many: true },
      parent: { inline: false },
    });
    // A core field holds text whatever the config says; `many` needs `item`.
    expect(fields.find((f) => f.name === 'gloss')).toMatchObject({ type: 'text', scope: 'entry' });
    expect(fields.find((f) => f.name === 'variantOf')).toMatchObject({ type: 'item', many: false });
    expect(fields.find((f) => f.name === 'seeAlso')).toMatchObject({ type: 'item', many: true });
    expect(fields.find((f) => f.name === 'etymology')).toMatchObject({ type: 'text', many: false });
    expect(fields.find((f) => f.name === 'parent')).toBeUndefined();
    expect(fieldsToConfig(fields)).toEqual({
      morphType: { inline: false },
      gloss: { inline: true, scope: 'entry' },
      variantOf: { inline: false, type: 'item' },
      seeAlso: { inline: false, type: 'item', many: true },
      etymology: { inline: false, scope: 'entry' },
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

describe('editable and reserved metadata', () => {
  it('keeps structure out of the form draft and carries it over on save', () => {
    const meta = { gloss: 'cat', parent: 'p', senseOrder: 2, examples: [], flexSense: 's' };
    expect(editableMetadata(meta)).toEqual({ gloss: 'cat' });
    expect(reservedMetadata(meta)).toEqual({
      parent: 'p',
      senseOrder: 2,
      examples: [],
      flexSense: 's',
    });
    expect({ ...reservedMetadata(meta), ...editableMetadata({ gloss: 'lion' }) }).toEqual({
      parent: 'p',
      senseOrder: 2,
      examples: [],
      flexSense: 's',
      gloss: 'lion',
    });
  });
});

describe('labels and form groups', () => {
  it('strips a language suffix, and knows the built-in fields in any language', () => {
    expect(fieldBaseName('gloss (ru)')).toBe('gloss');
    expect(fieldBaseName('Parsing Note')).toBe('Parsing Note');
    expect(isBuiltInField('definition (en)')).toBe(true);
    expect(isBuiltInField('lexemeForm')).toBe(true);
    expect(isBuiltInField('Plural')).toBe(false);
  });

  it('labels a field with its language when it carries one and its name does not', () => {
    expect(fieldLabel({ name: 'gloss', lang: 'pt' })).toBe('Gloss (pt)');
    expect(fieldLabel({ name: 'gloss (en)', lang: null })).toBe('Gloss (en)');
    expect(fieldLabel({ name: 'gloss (en)', lang: 'en' })).toBe('Gloss (en)');
    expect(fieldLabel({ name: 'Plural', lang: 'seh' })).toBe('Plural (seh)');
    expect(fieldLabel('morphType')).toBe('Morph Type');
  });

  it('groups the form: built-ins with their variants, then custom, then references', () => {
    const fields = normalizeVocabFields({
      pos: { inline: true },
      'gloss (en)': { inline: false },
      etymology: { inline: false, scope: 'entry' },
      'Parsing Note': { inline: false, lang: 'pt' },
      morphType: { inline: false },
      lexemeForm: { inline: false },
      status: { inline: false, tagset: 'Status' },
      'definition (en)': { inline: false },
      gloss: { inline: true, lang: 'pt' },
      variantOf: { inline: false, type: 'item' },
      definition: { inline: false },
      seeAlso: { inline: false, type: 'item', many: true },
    });
    const g = groupFieldsForForm(fields, { statusField: 'status' });
    expect(g.builtIn.map((f) => f.name)).toEqual([
      'morphType',
      'gloss',
      'gloss (en)',
      'pos',
      'definition',
      'definition (en)',
      'lexemeForm',
    ]);
    expect(g.custom.map((f) => f.name)).toEqual(['etymology', 'Parsing Note']);
    expect(g.refs.map((f) => f.name)).toEqual(['variantOf', 'seeAlso']);
    expect(g.status?.name).toBe('status');
    // Without a status field named, status is an ordinary custom field.
    expect(groupFieldsForForm(fields).custom.map((f) => f.name)).toContain('status');
  });
});
