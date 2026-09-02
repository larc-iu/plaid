import { describe, it, expect } from 'vitest';
import {
  EMPTY_TAGSET,
  normalizeTagset,
  readTagsets,
  readTagsetName,
  resolveTagset,
  fieldsUsingTagset,
  scanValue,
  splitValue,
  partAtCaret,
  replacePartAtCaret,
  tagsetHas,
  tagsetRecord,
  validateValue,
  isValueAllowed,
  isLexicalPart,
  offTagsetParts,
  offTagsetValues,
  seedValueRecords,
} from './tagsets.js';

const leipzig = {
  delimiters: '.:>',
  closed: true,
  values: [
    { value: 'NOM', description: 'nominative' },
    { value: '1SG', description: '1st person singular', color: '#a33' },
    { value: 'PST' },
  ],
};

const projectConfig = { igt: { tagsets: { Leipzig: leipzig, POS: { values: [{ value: 'n' }] } } } };

describe('normalizeTagset', () => {
  it('fills in the defaults', () => {
    expect(normalizeTagset({})).toEqual(EMPTY_TAGSET);
    expect(normalizeTagset(undefined)).toEqual(EMPTY_TAGSET);
  });

  it('keeps free-form keys on a value record', () => {
    const t = normalizeTagset({ values: [{ value: 'NOM', wals: '28A', description: 'nom' }] });
    expect(t.values[0]).toEqual({ value: 'NOM', wals: '28A', description: 'nom' });
  });

  it('trims values, drops the unusable, and keeps the first duplicate', () => {
    const t = normalizeTagset({
      values: [{ value: '  NOM ' }, { value: '' }, {}, { value: 'NOM', description: 'second' }],
    });
    expect(t.values).toEqual([{ value: 'NOM' }]);
  });

  it('only treats closed === true as closed', () => {
    expect(normalizeTagset({ closed: 'yes' }).closed).toBe(false);
    expect(normalizeTagset({ closed: true }).closed).toBe(true);
  });
});

describe('reading config', () => {
  it('reads a project tagset map', () => {
    expect(Object.keys(readTagsets(projectConfig))).toEqual(['Leipzig', 'POS']);
    expect(readTagsets({})).toEqual({});
    expect(readTagsets(undefined)).toEqual({});
  });

  it('reads a field reference', () => {
    expect(readTagsetName({ igt: { tagset: 'Leipzig' } })).toBe('Leipzig');
    expect(readTagsetName({ igt: { scope: 'Word' } })).toBeNull();
    expect(readTagsetName(undefined)).toBeNull();
  });

  it('resolves a field to its tagset', () => {
    const t = resolveTagset({ igt: { tagset: 'Leipzig' } }, projectConfig);
    expect(t.closed).toBe(true);
    expect(t.values).toHaveLength(3);
  });

  it('resolves a DANGLING reference to null, never to a closed empty set', () => {
    // A field pointing at a deleted tagset must govern nothing. Returning an
    // empty closed tagset here would reject every value in the field.
    const t = resolveTagset({ igt: { tagset: 'Gone' } }, projectConfig);
    expect(t).toBeNull();
    expect(isValueAllowed('anything', t)).toBe(true);
  });

  it('lists the fields using a tagset', () => {
    const layerInfo = {
      spanLayers: {
        word: [{ id: 'a', name: 'POS', config: { igt: { tagset: 'POS' } } }],
        morpheme: [
          { id: 'b', name: 'Gloss', config: { igt: { tagset: 'Leipzig' } } },
          { id: 'c', name: 'POS', config: { igt: { tagset: 'POS' } } },
        ],
        sentence: [{ id: 'd', name: 'Translation', config: { igt: {} } }],
      },
    };
    expect(fieldsUsingTagset(layerInfo, 'POS').map((f) => f.id)).toEqual(['a', 'c']);
    expect(fieldsUsingTagset(layerInfo, 'Leipzig')).toHaveLength(1);
    expect(fieldsUsingTagset(layerInfo, 'Nobody')).toEqual([]);
  });
});

describe('scanValue', () => {
  it('returns the whole cell when no delimiters are configured', () => {
    expect(splitValue('1SG.NOM', '')).toEqual(['1SG.NOM']);
  });

  it('splits on any configured delimiter and records which one followed', () => {
    expect(scanValue('1SG.NOM>3PL', '.:>')).toEqual([
      { text: '1SG', begin: 0, end: 3, sep: '.' },
      { text: 'NOM', begin: 4, end: 7, sep: '>' },
      { text: '3PL', begin: 8, end: 11, sep: null },
    ]);
  });

  it('yields empty segments for doubled and trailing delimiters', () => {
    expect(splitValue('1SG..NOM', '.')).toEqual(['1SG', '', 'NOM']);
    expect(splitValue('1SG.', '.')).toEqual(['1SG', '']);
  });

  it('does not split an astral character down the middle', () => {
    // The offsets are UTF-16, so a surrogate pair advances by 2.
    expect(scanValue('a\u{1F600}.b', '.')).toEqual([
      { text: 'a\u{1F600}', begin: 0, end: 3, sep: '.' },
      { text: 'b', begin: 4, end: 5, sep: null },
    ]);
  });

  it('handles an astral delimiter', () => {
    expect(splitValue('a\u{1F600}b', '\u{1F600}')).toEqual(['a', 'b']);
  });
});

describe('partAtCaret / replacePartAtCaret', () => {
  it('finds the segment the caret sits in', () => {
    expect(partAtCaret('1SG.NOM', 0, '.').text).toBe('1SG');
    expect(partAtCaret('1SG.NOM', 5, '.').text).toBe('NOM');
  });

  it('gives a caret ON a delimiter to the segment it ends', () => {
    // "1SG|.NOM" is still typing 1SG, so completion should offer for that.
    expect(partAtCaret('1SG.NOM', 3, '.').text).toBe('1SG');
  });

  it('clamps a caret past the end', () => {
    expect(partAtCaret('1SG.NOM', 999, '.').text).toBe('NOM');
  });

  it('replaces the segment under the caret and leaves the caret after it', () => {
    expect(replacePartAtCaret('1SG.no', 6, '.', 'NOM')).toEqual({ value: '1SG.NOM', caret: 7 });
    expect(replacePartAtCaret('1sg.NOM', 2, '.', '1SG')).toEqual({ value: '1SG.NOM', caret: 3 });
  });

  it('replaces the whole value when nothing is there yet', () => {
    expect(replacePartAtCaret('', 0, '.', 'NOM')).toEqual({ value: 'NOM', caret: 3 });
  });
});

describe('membership', () => {
  it('is case-sensitive, because case is meaningful in glossing', () => {
    expect(tagsetHas(leipzig, 'NOM')).toBe(true);
    expect(tagsetHas(leipzig, 'nom')).toBe(false);
  });

  it('trims the part before testing', () => {
    expect(tagsetHas(leipzig, '  NOM ')).toBe(true);
  });

  it('returns the record so the picker can show a description', () => {
    expect(tagsetRecord(leipzig, '1SG').description).toBe('1st person singular');
    expect(tagsetRecord(leipzig, 'ABL')).toBeNull();
  });
});

describe('validateValue', () => {
  it('accepts an empty cell: clearing a cell deletes the annotation', () => {
    expect(validateValue('', leipzig)).toEqual([]);
    expect(validateValue('   ', leipzig)).toEqual([]);
  });

  it('accepts a composite value whose every part is in the tagset', () => {
    expect(validateValue('1SG.NOM', leipzig)).toEqual([]);
    expect(validateValue('1SG:NOM>PST', leipzig)).toEqual([]);
  });

  it('reports each unknown part with where it is', () => {
    const v = validateValue('1SG.ABL', leipzig);
    expect(v).toEqual([{ part: 'ABL', begin: 4, end: 7, reason: 'unknown' }]);
  });

  it('reports a stray delimiter as an empty part', () => {
    expect(validateValue('1SG.', leipzig).map((x) => x.reason)).toEqual(['empty']);
    expect(validateValue('1SG..NOM', leipzig).map((x) => x.reason)).toEqual(['empty']);
  });

  it('an OPEN tagset allows new values but still flags a stray delimiter', () => {
    const open = { ...leipzig, closed: false };
    expect(validateValue('1SG.ABL', open)).toEqual([]);
    expect(validateValue('1SG.', open).map((x) => x.reason)).toEqual(['empty']);
  });

  it('governs the whole cell when no delimiters are configured', () => {
    const whole = { delimiters: '', closed: true, values: [{ value: '1SG.NOM' }] };
    expect(isValueAllowed('1SG.NOM', whole)).toBe(true);
    expect(isValueAllowed('1SG', whole)).toBe(false);
  });

  it('governs nothing without a tagset', () => {
    expect(isValueAllowed('whatever', null)).toBe(true);
  });
});

describe('offTagsetParts / seedValueRecords', () => {
  const attested = [
    ['1SG.NOM', 10],
    ['1SG.ABL', 4],
    ['ERG', 7],
    ['ABL', 1],
  ];

  it('pools counts per unknown part, most frequent first', () => {
    expect(offTagsetParts(attested, leipzig)).toEqual([
      { part: 'ERG', count: 7 },
      { part: 'ABL', count: 5 },
    ]);
  });

  it('reports nothing when everything attested is in the tagset', () => {
    expect(offTagsetParts([['1SG.NOM', 3]], leipzig)).toEqual([]);
  });

  it('ignores empty parts: a stray delimiter is not a tag to seed', () => {
    expect(offTagsetParts([['1SG.', 9]], leipzig)).toEqual([]);
  });

  it('turns the unknowns into value records for the seed button', () => {
    expect(seedValueRecords(attested, leipzig)).toEqual([{ value: 'ERG' }, { value: 'ABL' }]);
  });

  it('finds every attested value when the tagset is empty, which is the seed case', () => {
    const fresh = { delimiters: '.', closed: false, values: [] };
    // 1SG pools 10+4, NOM 10, ERG 7, ABL 4+1.
    expect(seedValueRecords(attested, fresh).map((r) => r.value)).toEqual([
      '1SG',
      'NOM',
      'ERG',
      'ABL',
    ]);
  });
});

describe('offTagsetValues', () => {
  const attested = [
    ['1SG.NOM', 10],
    ['1SG.ABL', 4],
    ['ERG', 7],
    ['1SG.', 2],
  ];

  it('lists the values that fail, worst first, with why', () => {
    expect(offTagsetValues(attested, leipzig)).toEqual([
      {
        value: 'ERG',
        count: 7,
        violations: [{ part: 'ERG', begin: 0, end: 3, reason: 'unknown' }],
      },
      {
        value: '1SG.ABL',
        count: 4,
        violations: [{ part: 'ABL', begin: 4, end: 7, reason: 'unknown' }],
      },
      { value: '1SG.', count: 2, violations: [{ part: '', begin: 4, end: 4, reason: 'empty' }] },
    ]);
  });

  it('says nothing about the values that pass', () => {
    expect(offTagsetValues([['1SG.NOM', 10]], leipzig)).toEqual([]);
  });

  it('an OPEN tagset only fails on a stray delimiter', () => {
    const open = { ...leipzig, closed: false };
    expect(offTagsetValues(attested, open).map((r) => r.value)).toEqual(['1SG.']);
  });
});

describe('allowLexical', () => {
  // A Leipzig gloss tagset: grammatical tags listed, lexical glosses let through.
  const gloss = {
    delimiters: '.',
    closed: true,
    allowLexical: true,
    values: [{ value: 'PL' }, { value: '1SG' }],
  };

  it('lets a stem gloss through, which is what makes a closed gloss tagset usable', () => {
    // Every morpheme has its own cell, so a stem's cell holds `dog`. Without
    // this, closing a gloss tagset would reject every stem in the project.
    expect(isValueAllowed('dog', gloss)).toBe(true);
    expect(isValueAllowed('run.PL', gloss)).toBe(true);
  });

  it('still requires grammatical tags to be listed', () => {
    expect(isValueAllowed('ERG', gloss)).toBe(false);
    expect(validateValue('dog.ERG', gloss)).toEqual([
      { part: 'ERG', begin: 4, end: 7, reason: 'unknown' },
    ]);
  });

  it('treats "I" as grammatical, so it has to be listed', () => {
    // The case that defies a meaning-based rule. A capitalised gloss with no
    // lowercase letter reads as grammatical, and the fix is one tagset entry.
    expect(isValueAllowed('I', gloss)).toBe(false);
    expect(isValueAllowed('I', { ...gloss, values: [...gloss.values, { value: 'I' }] })).toBe(true);
  });

  it('is off by default, so a lowercase POS tagset still enforces', () => {
    // n / v / adj are lowercase tags. If this defaulted on, a closed POS tagset
    // would accept literally anything.
    const pos = { delimiters: '', closed: true, allowLexical: false, values: [{ value: 'n' }] };
    expect(normalizeTagset({ closed: true }).allowLexical).toBe(false);
    expect(isValueAllowed('n', pos)).toBe(true);
    expect(isValueAllowed('banana', pos)).toBe(false);
  });

  it('does nothing on an open tagset, which already allows everything', () => {
    const open = { ...gloss, closed: false };
    expect(isValueAllowed('ERG', open)).toBe(true);
  });

  it('does not seed lexical glosses into the tagset', () => {
    // `dog` is a gloss, not a member of the grammatical inventory. Seeding it
    // would turn the tagset into a word list.
    const attested = [
      ['dog.PL', 5],
      ['run.ERG', 3],
    ];
    expect(offTagsetParts(attested, gloss)).toEqual([{ part: 'ERG', count: 3 }]);
  });
});

describe('isLexicalPart', () => {
  it('reads the Leipzig casing convention, not meaning', () => {
    expect(isLexicalPart('dog')).toBe(true);
    expect(isLexicalPart('walk about')).toBe(true);
    expect(isLexicalPart('PL')).toBe(false);
    expect(isLexicalPart('1SG')).toBe(false);
    expect(isLexicalPart('I')).toBe(false);
    expect(isLexicalPart('')).toBe(false);
  });

  it('counts a mixed-case gloss as lexical, so a typo is not a hard block', () => {
    expect(isLexicalPart('Dog')).toBe(true);
  });
});
