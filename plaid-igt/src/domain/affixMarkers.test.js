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
  splitChainText,
} from './affixMarkers.js';
import { formatPlain, joinMorphemeTexts } from './igtExport.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  cliticSideOfBoundary,
  EQUALS_TYPE_KEY,
  EQUALS_BEFORE_KEY,
  typedByEquals,
  equalsBoundaries,
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
    // only a proclitic before a non-clitic, or an enclitic after one, owns its
    // "=": anything else draws it plain (REV-CLITIC CL-5)
    expect(shownMorphemeJoiner('clitic', 'stem')).toBe('=');
    expect(shownMorphemeJoiner('stem', 'clitic')).toBe('=');
    expect(shownMorphemeJoiner('enclitic', 'suffix')).toBe('=');
    expect(shownMorphemeJoiner('stem', 'proclitic')).toBe('=');
    expect(shownMorphemeJoiner('proclitic', 'enclitic')).toBe('=');
    expect(shownMorphemeJoiner('enclitic', 'enclitic')).toBe('=');
    expect(cliticSideOfJoint('enclitic', 'suffix')).toBeNull();
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

  // A piece of a chain: its own type, the type "=" set (the record), its
  // entry's type, and whether a typed "=" stands before it.
  const piece = (morphType = null, fromEquals = null, entryType = null, before = false) => ({
    metadata: {
      ...(morphType ? { morphType } : {}),
      ...(fromEquals ? { [EQUALS_TYPE_KEY]: fromEquals } : {}),
      ...(before ? { [EQUALS_BEFORE_KEY]: true } : {}),
    },
    entryType,
  });
  const eq = (t, before = false) => piece(t, t, null, before);
  const after = (morphType = null) => piece(morphType, null, null, true);
  const clear = { morphType: null, [EQUALS_TYPE_KEY]: null };

  it('a type counts as set by "=" only while the record names the type it holds', () => {
    expect(typedByEquals(eq('enclitic').metadata)).toBe(true);
    expect(typedByEquals({ morphType: 'enclitic' })).toBe(false);
    // another writer changed the type: the record no longer names it
    expect(typedByEquals({ morphType: 'stem', [EQUALS_TYPE_KEY]: 'enclitic' })).toBe(false);
    // a linked entry's type hides the morpheme's own
    expect(typedByEquals(eq('enclitic').metadata, 'stem')).toBe(false);
  });

  it('equalsBoundaries reads the typed "=" off the morpheme after each, whatever the types', () => {
    expect([...equalsBoundaries([piece(), after()])]).toEqual([0]);
    expect([...equalsBoundaries([piece(), piece(), after(), piece()])]).toEqual([1]);
    // a type alone records no "=", and a key on the first piece stands before nothing
    expect([...equalsBoundaries([piece('proclitic'), piece('enclitic')])]).toEqual([]);
    expect([...equalsBoundaries([after(), piece()])]).toEqual([]);
  });

  it('rereadEquals types the clitic side the rule names now and takes back what it set elsewhere', () => {
    // ni=house, then house split as house-PL: house loses enclitic, ni gets proclitic
    expect(rereadEquals([piece(), eq('enclitic', true), piece()])).toEqual([
      { morphType: 'proclitic', [EQUALS_TYPE_KEY]: 'proclitic' },
      clear,
      null,
    ]);
  });

  it('an interior "=" types nothing but stays, and types again once it is outer', () => {
    expect(rereadEquals([piece(), piece(), after(), piece()])).toEqual([null, null, null, null]);
    expect(rereadEquals([piece(), piece(), after()])).toEqual([
      null,
      null,
      { morphType: 'enclitic', [EQUALS_TYPE_KEY]: 'enclitic' },
    ]);
  });

  it('a blocked "=" stays and types its side once the side is free', () => {
    // the clitic side has a chosen stem: nothing typed, the key stays
    expect(rereadEquals([piece(), after('stem')])).toEqual([null, null]);
    expect(rereadEquals([piece(), after()])).toEqual([
      null,
      { morphType: 'enclitic', [EQUALS_TYPE_KEY]: 'enclitic' },
    ]);
  });

  it('rereadEquals takes away a key left on the first piece', () => {
    expect(rereadEquals([after(), piece()])).toEqual([{ [EQUALS_BEFORE_KEY]: null }, null]);
  });

  it('rereadEquals never sets or clears a type it did not set', () => {
    expect(rereadEquals([piece('stem'), after(), piece()])).toEqual([null, null, null]);
    expect(rereadEquals([piece(), piece('enclitic'), piece()])).toEqual([null, null, null]);
    expect(rereadEquals([piece(), piece(null, null, 'stem', true)])).toEqual([null, null]);
  });

  it('rereadEquals writes nothing when every type already stands', () => {
    expect(rereadEquals([piece(), eq('enclitic', true)])).toEqual([null, null]);
  });

  it('agrees with the Python client on every chain of one to six pieces', () => {
    const table = JSON.parse(
      readFileSync(
        join(
          dirname(fileURLToPath(import.meta.url)),
          '../../../plaid-client-py/tests/clitic_chains.json',
        ),
        'utf8',
      ),
    );
    expect(Object.keys(table)).toHaveLength(63);
    for (const [joints, types] of Object.entries(table)) {
      const pieces = [piece(), ...[...joints].map((j) => (j === '=' ? after() : piece()))];
      expect(
        rereadEquals(pieces).map((c) => c?.morphType ?? null),
        joints,
      ).toEqual(types);
    }
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
