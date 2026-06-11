import { describe, it, expect } from 'vitest';
import { FLEX_MORPH_TYPES, isValidMorphType, isClitic, morphemeJoiner, joinMorphemes } from './affixMarkers.js';
import { formatPlain } from './igtExport.js';

describe('affix markers', () => {
  it('carries FLEx exact 19-type MoMorphType inventory', () => {
    expect(FLEX_MORPH_TYPES).toHaveLength(19);
    for (const t of ['stem', 'bound root', 'circumfix', 'suffixing interfix', 'enclitic', 'discontiguous phrase']) {
      expect(FLEX_MORPH_TYPES).toContain(t);
    }
    expect(isValidMorphType('proclitic')).toBe(true);
    expect(isValidMorphType(null)).toBe(true); // "no type" is valid
    expect(isValidMorphType('sufix')).toBe(false);
    expect(isValidMorphType('Stem')).toBe(false); // exact names, exact case
  });

  it('classifies every FLEx clitic type', () => {
    for (const t of ['clitic', 'enclitic', 'proclitic']) expect(isClitic(t)).toBe(true);
    for (const t of ['stem', 'root', 'suffix', 'prefix', 'bound stem', null, undefined]) {
      expect(isClitic(t)).toBe(false);
    }
  });

  it('joins with = when either neighbor is a clitic, else -', () => {
    expect(morphemeJoiner('stem', 'suffix')).toBe('-');
    expect(morphemeJoiner('stem', 'enclitic')).toBe('=');
    expect(morphemeJoiner('proclitic', 'stem')).toBe('=');
    expect(morphemeJoiner(undefined, undefined)).toBe('-'); // hand-entered default
  });

  it('joinMorphemes renders a chain', () => {
    expect(joinMorphemes([
      { text: 'руша', morphType: 'stem' },
      { text: 'кай', morphType: 'suffix' },
      { text: 'ни', morphType: 'enclitic' },
    ])).toBe('руша-кай=ни');
  });
});

describe('Copy-as-IGT uses morphType joints', () => {
  it('renders = before clitics on both the form and gloss tiers', () => {
    const span = (v) => ({ value: v });
    const sent = {
      annotations: {},
      tokens: [{
        content: 'рушакайни',
        annotations: {},
        morphemes: [
          { metadata: { form: 'руша', morphType: 'stem' }, annotations: { Gloss: span('girl') } },
          { metadata: { form: 'кай', morphType: 'suffix' }, annotations: { Gloss: span('SBEL') } },
          { metadata: { form: 'ни', morphType: 'enclitic' }, annotations: { Gloss: span('ADD') } },
        ],
      }],
    };
    const out = formatPlain(sent, { morphFields: ['Gloss'], wordFields: [], sentFields: [] });
    expect(out).toBe('руша-кай=ни\ngirl-SBEL=ADD');
  });
});
