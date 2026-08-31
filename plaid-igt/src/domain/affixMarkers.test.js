import { describe, it, expect } from 'vitest';
import {
  decorateWithAffixMarkers,
  FLEX_MORPH_TYPES,
  isValidMorphType,
  isClitic,
  morphemeJoiner,
  joinMorphemes,
  cliticSideOfBoundary,
  cliticTypesForChain,
  splitChainText,
} from './affixMarkers.js';
import { formatPlain, joinMorphemeTexts } from './igtExport.js';

describe('affix markers', () => {
  it('carries FLEx exact 19-type MoMorphType inventory', () => {
    expect(FLEX_MORPH_TYPES).toHaveLength(19);
    for (const t of [
      'stem',
      'bound root',
      'circumfix',
      'suffixing interfix',
      'enclitic',
      'discontiguous phrase',
    ]) {
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
    expect(
      joinMorphemes([
        { text: 'руша', morphType: 'stem' },
        { text: 'кай', morphType: 'suffix' },
        { text: 'ни', morphType: 'enclitic' },
      ]),
    ).toBe('руша-кай=ни');
  });
});

describe('clitic side of a "=" boundary', () => {
  it('positional rule: left edge → proclitic, right edge → enclitic', () => {
    expect(cliticSideOfBoundary({ leftIdx: 0, count: 3 })).toBe('left');
    expect(cliticSideOfBoundary({ leftIdx: 1, count: 3 })).toBe('right');
  });
  it('two-morpheme word: gloss case decides, else enclitic', () => {
    expect(cliticSideOfBoundary({ leftIdx: 0, count: 2 })).toBe('right');
    expect(
      cliticSideOfBoundary({ leftIdx: 0, count: 2, leftGloss: 'DET', rightGloss: 'house' }),
    ).toBe('left');
    expect(
      cliticSideOfBoundary({ leftIdx: 0, count: 2, leftGloss: 'house', rightGloss: 'DET' }),
    ).toBe('right');
    // both caps / both lexical: no signal → default
    expect(cliticSideOfBoundary({ leftIdx: 0, count: 2, leftGloss: 'A', rightGloss: 'B' })).toBe(
      'right',
    );
  });
  it('interior boundary: gloss case or untyped', () => {
    expect(cliticSideOfBoundary({ leftIdx: 1, count: 4 })).toBeNull();
    expect(cliticSideOfBoundary({ leftIdx: 1, count: 4, leftGloss: 'go', rightGloss: '3SG' })).toBe(
      'right',
    );
  });
  it('cliticTypesForChain stamps only untyped pieces, per boundary', () => {
    // word "a=b-c" written as one chain
    expect(
      cliticTypesForChain({
        joiners: ['=', '-'],
        startIdx: 0,
        count: 3,
        types: [null, null, null],
      }),
    ).toEqual(['proclitic', null, null]);
    // chain replacing the 2nd morpheme of a 4-morpheme word: "x" | "b=c" | "y"
    expect(
      cliticTypesForChain({ joiners: ['='], startIdx: 1, count: 4, types: [null, null] }),
    ).toEqual([null, null]);
    // right edge, existing type on the left piece is left alone
    expect(
      cliticTypesForChain({ joiners: ['='], startIdx: 1, count: 3, types: ['stem', null] }),
    ).toEqual(['stem', 'enclitic']);
    // never overwrites
    expect(
      cliticTypesForChain({ joiners: ['='], startIdx: 0, count: 2, types: [null, 'suffix'] }),
    ).toEqual([null, 'suffix']);
  });
  it('splitChainText keeps joiners and drops empty pieces', () => {
    expect(splitChainText('a-b=c')).toEqual({ segments: ['a', 'b', 'c'], joiners: ['-', '='] });
    expect(splitChainText('-a--b= ')).toEqual({ segments: ['a', 'b'], joiners: ['-'] });
    expect(splitChainText(' x ')).toEqual({ segments: ['x'], joiners: [] });
    expect(splitChainText('')).toEqual({ segments: [], joiners: [] });
  });
});

describe('joinMorphemeTexts prefers the effective (entry) type', () => {
  it('uses morpheme.morphType over metadata.morphType', () => {
    const ms = [
      { metadata: { form: 'a', morphType: 'stem' }, morphType: 'stem' },
      { metadata: { form: 'b', morphType: 'suffix' }, morphType: 'enclitic' },
    ];
    expect(joinMorphemeTexts(ms, ['a', 'b'])).toBe('a=b');
  });
});

describe('Copy-as-IGT uses morphType joints', () => {
  it('renders = before clitics on both the form and gloss tiers', () => {
    const span = (v) => ({ value: v });
    const sent = {
      annotations: {},
      tokens: [
        {
          content: 'рушакайни',
          annotations: {},
          morphemes: [
            { metadata: { form: 'руша', morphType: 'stem' }, annotations: { Gloss: span('girl') } },
            {
              metadata: { form: 'кай', morphType: 'suffix' },
              annotations: { Gloss: span('SBEL') },
            },
            {
              metadata: { form: 'ни', morphType: 'enclitic' },
              annotations: { Gloss: span('ADD') },
            },
          ],
        },
      ],
    };
    const out = formatPlain(sent, { morphFields: ['Gloss'], wordFields: [], sentFields: [] });
    expect(out).toBe('руша-кай=ни\ngirl-SBEL=ADD');
  });
});

describe('decorateWithAffixMarkers', () => {
  it('writes each bound type the way FLEx writes it standing alone', () => {
    expect(decorateWithAffixMarkers('suffix', 'ar')).toBe('-ar');
    expect(decorateWithAffixMarkers('prefix', 'ka')).toBe('ka-');
    expect(decorateWithAffixMarkers('infix', 'um')).toBe('-um-');
    expect(decorateWithAffixMarkers('enclitic', 'ni')).toBe('=ni');
    expect(decorateWithAffixMarkers('proclitic', 'ni')).toBe('ni=');
    expect(decorateWithAffixMarkers('bound stem', 'kwa')).toBe('*kwa');
    expect(decorateWithAffixMarkers('suprafix', 'H')).toBe('~H~');
  });

  it('leaves free forms, unknown types and empty forms alone', () => {
    expect(decorateWithAffixMarkers('stem', 'perro')).toBe('perro');
    expect(decorateWithAffixMarkers('phrase', 'a b')).toBe('a b');
    expect(decorateWithAffixMarkers('martian', 'x')).toBe('x');
    expect(decorateWithAffixMarkers(null, 'x')).toBe('x');
    expect(decorateWithAffixMarkers('suffix', '')).toBe('');
    expect(decorateWithAffixMarkers('suffix', null)).toBe(null);
  });
});
