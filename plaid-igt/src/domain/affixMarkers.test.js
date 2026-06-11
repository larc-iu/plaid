import { describe, it, expect } from 'vitest';
import { isClitic, morphemeJoiner, joinMorphemes } from './affixMarkers.js';
import { formatPlain } from './igtExport.js';

describe('affix markers', () => {
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
