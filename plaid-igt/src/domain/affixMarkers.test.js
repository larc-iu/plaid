import { describe, it, expect } from 'vitest';
import {
  decorateWithAffixMarkers,
  readAffixMarkers,
  FLEX_MORPH_TYPES,
  isValidMorphType,
  isClitic,
  morphemeJoiner,
  shownMorphemeJoiner,
  cliticSideOfJoint,
  joinMorphemes,
  cliticSideOfBoundary,
  splitChainText,
} from './affixMarkers.js';
import { formatPlain, joinMorphemeTexts } from './igtExport.js';
import {
  EQUALS_TYPE_KEY,
  typedByEquals,
  equalsBoundaries,
  equalsAfterSplit,
  equalsAfterRemove,
  rereadEquals,
} from './mutations/equalsRule.js';

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

  it('on screen, sets "=" against its clitic with a hair space toward the host (R49)', () => {
    const HAIR = String.fromCodePoint(0x200a);
    expect(shownMorphemeJoiner('proclitic', 'stem')).toBe(`=${HAIR}`);
    expect(shownMorphemeJoiner('stem', 'enclitic')).toBe(`${HAIR}=`);
    expect(shownMorphemeJoiner('clitic', 'stem')).toBe(`=${HAIR}`);
    expect(shownMorphemeJoiner('stem', 'clitic')).toBe(`${HAIR}=`);
    expect(shownMorphemeJoiner('stem', 'suffix')).toBe('-');
    expect(cliticSideOfJoint('stem', 'suffix')).toBeNull();
  });

  it('copied text keeps the plain Leipzig "=" (R49 is on screen only)', () => {
    const chain = [
      { text: 'ni', morphType: 'proclitic' },
      { text: 'house', morphType: 'stem' },
      { text: 'ri', morphType: 'enclitic' },
    ];
    expect(joinMorphemes(chain)).toBe('ni=house=ri');
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

  it('writes no joiner in front of a value that already carries one', () => {
    // A FLEx lexicon whose glosses were written to Leipzig by hand, and the
    // shape CLDF's Gloss column and ELAN's morph tiers use throughout.
    expect(
      joinMorphemes([
        { text: 'long.ago', morphType: 'stem' },
        { text: '-ADV', morphType: 'suffix' },
      ]),
    ).toBe('long.ago-ADV');
    expect(
      joinMorphemes([
        { text: 'front', morphType: 'stem' },
        { text: '=CVB:SEQ.LOC', morphType: 'enclitic' },
      ]),
    ).toBe('front=CVB:SEQ.LOC');
    // The author's own marker stands, even where the types would name another.
    expect(
      joinMorphemes([
        { text: 'a', morphType: 'stem' },
        { text: '-X', morphType: 'enclitic' },
      ]),
    ).toBe('a-X');
    // A marker on the left edge of the boundary counts the same.
    expect(
      joinMorphemes([
        { text: 'ka-', morphType: 'prefix' },
        { text: 'b', morphType: 'stem' },
      ]),
    ).toBe('ka-b');
  });

  it('still writes a joiner around an empty or marker-less piece', () => {
    expect(
      joinMorphemes([
        { text: 'a', morphType: 'stem' },
        { text: '', morphType: 'suffix' },
      ]),
    ).toBe('a-');
    expect(
      joinMorphemes([
        { text: '', morphType: 'stem' },
        { text: '-ADV', morphType: 'suffix' },
      ]),
    ).toBe('-ADV');
  });
});

describe('clitic side of a "=" boundary (R47)', () => {
  it('positional rule: first piece proclitic, last piece enclitic, a two-piece word enclitic', () => {
    expect(cliticSideOfBoundary({ leftIdx: 0, count: 3 })).toBe('left');
    expect(cliticSideOfBoundary({ leftIdx: 1, count: 3 })).toBe('right');
    expect(cliticSideOfBoundary({ leftIdx: 0, count: 2 })).toBe('right');
  });
  it('an interior boundary names no side', () => {
    expect(cliticSideOfBoundary({ leftIdx: 1, count: 4 })).toBeNull();
  });
  it('reads no gloss: a two-piece word is enclitic whatever its glosses say', () => {
    expect(
      cliticSideOfBoundary({ leftIdx: 0, count: 2, leftGloss: 'DET', rightGloss: 'house' }),
    ).toBe('right');
  });

  const piece = (morphType = null, fromEquals = null, entryType = null) => ({
    metadata: {
      ...(morphType ? { morphType } : {}),
      ...(fromEquals ? { [EQUALS_TYPE_KEY]: fromEquals } : {}),
    },
    entryType,
  });
  const eq = (t) => piece(t, t);

  it('a type counts as set by "=" only while the record names the type it holds', () => {
    expect(typedByEquals(eq('enclitic').metadata)).toBe(true);
    expect(typedByEquals({ morphType: 'enclitic' })).toBe(false);
    // another writer changed the type: the record no longer names it
    expect(typedByEquals({ morphType: 'stem', [EQUALS_TYPE_KEY]: 'enclitic' })).toBe(false);
    // a linked entry's type hides the morpheme's own
    expect(typedByEquals(eq('enclitic').metadata, 'stem')).toBe(false);
  });

  it('equalsBoundaries reads the boundaries "=" typed from the types it set', () => {
    expect([...equalsBoundaries([piece(), eq('enclitic')])]).toEqual([0]);
    expect([...equalsBoundaries([eq('proclitic'), piece(), piece()])]).toEqual([0]);
    // a type a person chose, an import gave or an entry carries records no "="
    expect([...equalsBoundaries([piece('proclitic'), piece('enclitic')])]).toEqual([]);
    expect([...equalsBoundaries([piece(), piece(null, null, 'enclitic')])]).toEqual([]);
  });

  it('the boundaries move with a split, a merge and a delete', () => {
    // a=b|c, b split in three with "-" and "=": a=b-x=y|c
    expect([...equalsAfterSplit(new Set([0, 1]), 1, ['-', '='])].sort()).toEqual([0, 2, 3]);
    // merging piece 1 into piece 0 takes the boundary between them
    expect([...equalsAfterRemove(new Set([0, 2]), 1)]).toEqual([1]);
    // deleting the first piece takes the boundary after it
    expect([...equalsAfterRemove(new Set([0, 1]), 0)]).toEqual([0]);
  });

  it('rereadEquals moves a type "=" set to the side the rule names now', () => {
    // ni=house, then house split as house-PL: house loses enclitic, ni gets proclitic
    expect(rereadEquals([piece(), eq('enclitic'), piece()], new Set([0]))).toEqual([
      { morphType: 'proclitic', [EQUALS_TYPE_KEY]: 'proclitic' },
      { morphType: null, [EQUALS_TYPE_KEY]: null },
      null,
    ]);
  });

  it('rereadEquals drops a type "=" set when the boundary becomes interior', () => {
    expect(rereadEquals([piece(), eq('proclitic'), piece(), piece()], new Set([1]))).toEqual([
      null,
      { morphType: null, [EQUALS_TYPE_KEY]: null },
      null,
      null,
    ]);
  });

  it('rereadEquals never sets or clears a type it did not set', () => {
    // a hand-set stem on the clitic side keeps it, and nothing else is typed
    expect(rereadEquals([piece('stem'), piece(), piece()], new Set([0]))).toEqual([
      null,
      null,
      null,
    ]);
    // a hand-set enclitic where the rule names no clitic stays
    expect(rereadEquals([piece(), piece('enclitic'), piece()], new Set())).toEqual([
      null,
      null,
      null,
    ]);
    // an entry's type is never written over
    expect(rereadEquals([piece(), piece(null, null, 'stem')], new Set([0]))).toEqual([null, null]);
  });

  it('rereadEquals writes nothing when every type already stands', () => {
    expect(rereadEquals([piece(), eq('enclitic')], new Set([0]))).toEqual([null, null]);
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
            // As the derived view hands them out: the type each goes by.
            {
              morphType: 'stem',
              metadata: { form: 'руша', morphType: 'stem' },
              annotations: { Gloss: span('girl') },
            },
            {
              morphType: 'suffix',
              metadata: { form: 'кай', morphType: 'suffix' },
              annotations: { Gloss: span('SBEL') },
            },
            {
              morphType: 'enclitic',
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

describe('readAffixMarkers', () => {
  it('undoes decorateWithAffixMarkers for every type', () => {
    for (const type of FLEX_MORPH_TYPES) {
      expect(readAffixMarkers(type, decorateWithAffixMarkers(type, 'ka'))).toEqual({
        form: 'ka',
        morphType: type,
      });
    }
  });

  it('keeps a typed form that lacks its markers as written', () => {
    expect(readAffixMarkers('suffix', 'ar')).toEqual({ form: 'ar', morphType: 'suffix' });
    expect(readAffixMarkers('suffix', '-')).toEqual({ form: '-', morphType: 'suffix' });
    expect(readAffixMarkers('stem', '-ar')).toEqual({ form: '-ar', morphType: 'stem' });
  });

  it('reads the type of an untyped morph off its markers', () => {
    expect(readAffixMarkers(null, '-ar')).toEqual({ form: 'ar', morphType: 'suffix' });
    expect(readAffixMarkers(undefined, 'ka-')).toEqual({ form: 'ka', morphType: 'prefix' });
    expect(readAffixMarkers(null, '-um-')).toEqual({ form: 'um', morphType: 'infix' });
    expect(readAffixMarkers(null, '=ni')).toEqual({ form: 'ni', morphType: 'enclitic' });
    expect(readAffixMarkers(null, 'ni=')).toEqual({ form: 'ni', morphType: 'proclitic' });
    expect(readAffixMarkers('Martian', '-ar')).toEqual({ form: 'ar', morphType: 'suffix' });
  });

  it('leaves an untyped form whole when its markers name no type', () => {
    expect(readAffixMarkers(null, 'perro')).toEqual({ form: 'perro', morphType: null });
    expect(readAffixMarkers(null, 'a-b')).toEqual({ form: 'a-b', morphType: null });
    expect(readAffixMarkers(null, '=a-')).toEqual({ form: '=a-', morphType: null });
    expect(readAffixMarkers(null, '*kwa')).toEqual({ form: '*kwa', morphType: null });
    expect(readAffixMarkers(null, '-')).toEqual({ form: '-', morphType: null });
    expect(readAffixMarkers(null, '')).toEqual({ form: '', morphType: null });
    expect(readAffixMarkers(null, null)).toEqual({ form: null, morphType: null });
  });

  it('matches a type name regardless of case', () => {
    expect(readAffixMarkers('Suffix', '-ar')).toEqual({ form: 'ar', morphType: 'suffix' });
  });
});
