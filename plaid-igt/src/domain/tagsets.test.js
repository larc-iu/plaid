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
  offTagsetParts,
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
