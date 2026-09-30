import { describe, it, expect } from 'vitest';
import {
  EMPTY_TAGSET,
  normalizeTagset,
  readTagsets,
  readTagsetName,
  resolveTagset,
  analysisViolations,
  governedFields,
  byTagsetName,
  missingAffixDelimiters,
  scanValue,
  splitValue,
  partAtCaret,
  replacePartAtCaret,
  tagsetHas,
  tagsetRecord,
  sortedValues,
  validateValue,
  isValueAllowed,
  isLexicalPart,
  GLOSS_ABBREVIATIONS,
  lexicalFlags,
  lenientFlags,
  lexicalFlagsOf,
  glossSmallCaps,
  capsAreSmallCaps,
  boundByPieces,
  morphemeGlossReading,
  glossReadingOf,
  entryTagsetFor,
  readingTagset,
  glossMorphemes,
  offTagsetParts,
  offTagsetValues,
  seedValueRecords,
  seedCandidates,
  unreachableValues,
} from './tagsets.js';
import { statusTagset, STATUS_VALUES } from './vocabDictionary.js';

const leipzig = {
  delimiters: '.:>',
  mode: 'closed',
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

  it('never treats whitespace as a delimiter', () => {
    // A box typed as ". : >" would otherwise split "dog house" in two, and
    // the header could not show a space among the delimiters.
    expect(normalizeTagset({ delimiters: ' . : > ' }).delimiters).toBe('.:>');
  });

  it('falls back to suggest for an unrecognised mode', () => {
    expect(normalizeTagset({ mode: 'strict' }).mode).toBe('suggest');
    expect(normalizeTagset({ mode: 'closed' }).mode).toBe('closed');
    expect(normalizeTagset({ mode: 'mixed' }).mode).toBe('mixed');
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
    expect(t.mode).toBe('closed');
    expect(t.values).toHaveLength(3);
  });

  it('resolves a DANGLING reference to null, never to a closed empty set', () => {
    // A field pointing at a deleted tagset must govern nothing. Returning an
    // empty closed tagset here would reject every value in the field.
    const t = resolveTagset({ igt: { tagset: 'Gone' } }, projectConfig);
    expect(t).toBeNull();
    expect(isValueAllowed('anything', t)).toBe(true);
  });
});

describe('governedFields', () => {
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
  const config = {
    igt: {
      tagsets: { Leipzig: leipzig, POS: { values: [{ value: 'n' }] } },
      documentMetadata: [{ name: 'Date' }, { name: 'Genre', tagset: 'POS' }],
    },
  };

  it('covers annotation fields and metadata fields in one list', () => {
    const g = governedFields(layerInfo, config);
    expect(g.map((x) => [x.kind, x.field, x.scope, x.tagsetName])).toEqual([
      ['span', 'POS', 'word', 'POS'],
      ['span', 'Gloss', 'morpheme', 'Leipzig'],
      ['span', 'POS', 'morpheme', 'POS'],
      ['metadata', 'Genre', 'document', 'POS'],
    ]);
  });

  it('gives a metadata field a key but no layer, since it is queried off the document', () => {
    const meta = governedFields(layerInfo, config).find((x) => x.kind === 'metadata');
    expect([meta.key, meta.layerId]).toEqual(['meta:Genre', null]);
  });

  it('leaves out fields with no tagset, and references that no longer resolve', () => {
    const g = governedFields(layerInfo, {
      igt: { tagsets: {}, documentMetadata: [{ name: 'Genre', tagset: 'Gone' }] },
    });
    expect(g).toEqual([]);
  });

  it('groups by tagset name for the callers that want it that way', () => {
    const by = byTagsetName(governedFields(layerInfo, config));
    expect(Object.keys(by).sort()).toEqual(['Leipzig', 'POS']);
    expect(by.POS.map((x) => x.field)).toEqual(['POS', 'POS', 'Genre']);
  });
});

describe('missingAffixDelimiters', () => {
  const mixed = (delimiters) => ({ delimiters, mode: 'mixed', values: [] });

  it('flags the silent gap: dog-PL passes whole when - is not a delimiter', () => {
    expect(missingAffixDelimiters(mixed('.'), true)).toEqual(['-', '=']);
    expect(missingAffixDelimiters(mixed('.-'), true)).toEqual(['=']);
    expect(missingAffixDelimiters(mixed('.-='), true)).toEqual([]);
  });

  it('says nothing when no word-scope field uses the tagset', () => {
    expect(missingAffixDelimiters(mixed('.'), false)).toEqual([]);
  });

  it('says nothing under closed, where the same value is loudly rejected instead', () => {
    expect(missingAffixDelimiters({ ...mixed('.'), mode: 'closed' }, true)).toEqual([]);
  });

  it('warns loudest for a whole-cell tagset, where nothing is ever checked', () => {
    // This used to be exempted on the reasoning that a tagset with no
    // delimiters "has no parts to miss". Backwards: with no delimiters every
    // composite value is one part, so dog-PL passes on the lowercase in dog
    // and PL is never looked up at all.
    expect(missingAffixDelimiters(mixed(''), true)).toEqual(['-', '=']);
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

describe('sortedValues', () => {
  it('reads like a list of abbreviations: numbers in order, case ignored', () => {
    const t = { values: ['dog', 'NOM', '2SG', '10', '1SG', 'ABL'].map((value) => ({ value })) };
    expect(sortedValues(t).map((v) => v.value)).toEqual(['1SG', '2SG', '10', 'ABL', 'dog', 'NOM']);
  });

  it('gives two values differing only in case a fixed order', () => {
    const t = { values: [{ value: 'nom' }, { value: 'NOM' }] };
    expect(sortedValues(t).map((v) => v.value)).toEqual(['NOM', 'nom']);
  });

  it('leaves the stored order alone', () => {
    const t = { values: [{ value: 'PL' }, { value: 'ABL' }] };
    sortedValues(t);
    expect(t.values.map((v) => v.value)).toEqual(['PL', 'ABL']);
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
    const open = { ...leipzig, mode: 'suggest' };
    expect(validateValue('1SG.ABL', open)).toEqual([]);
    expect(validateValue('1SG.', open).map((x) => x.reason)).toEqual(['empty']);
  });

  it('governs the whole cell when no delimiters are configured', () => {
    const whole = { delimiters: '', mode: 'closed', values: [{ value: '1SG.NOM' }] };
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
    const fresh = { delimiters: '.', mode: 'suggest', values: [] };
    // 1SG pools 10+4, NOM 10, ERG 7, ABL 4+1.
    expect(seedValueRecords(attested, fresh).map((r) => r.value)).toEqual([
      '1SG',
      'NOM',
      'ERG',
      'ABL',
    ]);
  });
});

describe('seedCandidates', () => {
  const fresh = { delimiters: '.', mode: 'suggest', values: [] };
  const attested = [
    ['dog.PL', 5],
    ['run.PST', 2],
    ['NOM', 1],
  ];

  it('keeps lexical glosses apart from grammatical tags', () => {
    // A glossed project has many more stems than tags. Seeding them all into
    // a Leipzig tagset made a 1,700-value word list.
    expect(seedCandidates(attested, fresh)).toEqual({
      tags: [{ value: 'PL' }, { value: 'PST' }, { value: 'NOM' }],
      lexical: [{ value: 'dog' }, { value: 'run' }],
    });
  });

  it('has no lexical bucket under mixed, where those are accepted unlisted', () => {
    expect(seedCandidates(attested, { ...fresh, mode: 'mixed' })).toEqual({
      tags: [{ value: 'PL' }, { value: 'PST' }, { value: 'NOM' }],
      lexical: [],
    });
  });

  it('files a lowercase POS inventory as lexical, which is why the split is offered, not imposed', () => {
    const pos = { delimiters: '', mode: 'closed', values: [] };
    expect(
      seedCandidates(
        [
          ['n', 9],
          ['v', 4],
        ],
        pos,
      ),
    ).toEqual({
      tags: [],
      lexical: [{ value: 'n' }, { value: 'v' }],
    });
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
    const open = { ...leipzig, mode: 'suggest' };
    expect(offTagsetValues(attested, open).map((r) => r.value)).toEqual(['1SG.']);
  });
});

describe("mode 'mixed'", () => {
  // A Leipzig gloss tagset: grammatical tags listed, lexical glosses let through.
  const gloss = {
    delimiters: '.',
    mode: 'mixed',
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

  it('lets a stem in a script without capitals through', () => {
    // A Hindi or Japanese stem cannot be written in capitals, so it cannot be
    // carrying the mark of a tag. Under "has a lowercase letter" every such
    // stem was refused, and mixed mode was closed mode for those glossers.
    expect(validateValue('कुत्ता.PL', gloss)).toEqual([]);
    expect(validateValue('犬.PL', gloss)).toEqual([]);
    expect(validateValue('कुत्ता.ABL', gloss).map((x) => x.part)).toEqual(['ABL']);
  });

  it('still requires a bare number to be listed', () => {
    expect(validateValue('3.PL', gloss).map((x) => x.part)).toEqual(['3']);
  });

  it('treats "I" as grammatical, so it has to be listed', () => {
    // The case that defies a meaning-based rule. A capitalised gloss with no
    // lowercase letter reads as grammatical, and the fix is one tagset entry.
    expect(isValueAllowed('I', gloss)).toBe(false);
    expect(isValueAllowed('I', { ...gloss, values: [...gloss.values, { value: 'I' }] })).toBe(true);
  });

  it('is its own mode, so a lowercase POS tagset can still be strictly closed', () => {
    // n / v / adj are lowercase tags. If mixed were the default, a closed POS
    // tagset would accept literally anything.
    const pos = { delimiters: '', mode: 'closed', values: [{ value: 'n' }] };
    expect(normalizeTagset({}).mode).toBe('suggest');
    expect(isValueAllowed('n', pos)).toBe(true);
    expect(isValueAllowed('banana', pos)).toBe(false);
  });

  it('is moot under suggest, which already allows everything', () => {
    const open = { ...gloss, mode: 'suggest' };
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

describe('lexicalFlags: the lenient reading and its fall-back', () => {
  const flags = (value) => lexicalFlags(glossMorphemes(value)).flat();

  it('reads a known abbreviation in lower case as grammatical beside a tag in its morpheme', () => {
    expect(flags('sbj:3.pfv-go')).toEqual([false, false, false, true]);
    expect(flags('go.3SG.pfv')).toEqual([true, false, false]);
  });

  it('reads a person and number as grammatical in either case', () => {
    expect(isLexicalPart('3sg')).toBe(false);
    expect(flags('go.3sg.ipfv')).toEqual([true, false, false]);
  });

  it('never reads a part as grammatical because another morpheme is', () => {
    expect(flags('3SG-pfv')).toEqual([false, true]);
    expect(flags('lay.pfv')).toEqual([true, true]);
  });

  it('knows only upper-case abbreviations, so an exact match is never a word', () => {
    expect([...GLOSS_ABBREVIATIONS].every((a) => a === a.toUpperCase())).toBe(true);
    expect(GLOSS_ABBREVIATIONS.has('PFV')).toBe(true);
  });

  it('keeps a single letter lexical beside a tag', () => {
    expect(flags('a.3SG')).toEqual([true, false]);
  });

  it('falls back to the case rule when the lenient reading leaves no lexical part', () => {
    expect(flags('pass.PST')).toEqual([true, false]);
    expect(flags('top.PL')).toEqual([true, false]);
    expect(flags('sbj:3.pfv')).toEqual([true, false, true]);
  });

  it('reads parts cut any way by the reading of their whole value', () => {
    const flagsOf = (value, delimiters) => lexicalFlagsOf(value, scanValue(value, delimiters));
    expect(flagsOf('go.3SG.pfv-sbj:3', '.:-')).toEqual([true, false, false, false, false]);
    // An empty part is not a part, and never lexical.
    expect(flagsOf('go..pfv.3', '.')).toEqual([true, false, false, false]);
    // A tagset that does not split on "-": pfv is still beside 3SG.
    expect(flagsOf('go-3SG.pfv', '.')).toEqual([true, false]);
    // A tagset that splits finer than a gloss is cut: PL is a tag.
    expect(flagsOf('go+PL', '+')).toEqual([true, false]);
  });
});

describe('the lenient reading in tagset checks', () => {
  const gloss = { delimiters: '.:-', mode: 'mixed', values: [{ value: 'PL' }, { value: '3' }] };

  it('holds a lower-case abbreviation beside a tag to the list', () => {
    expect(validateValue('go.3.pfv', gloss).map((v) => v.part)).toEqual(['pfv']);
    expect(offTagsetParts([['go.3.pfv', 2]], gloss)).toEqual([{ part: 'pfv', count: 2 }]);
  });

  it('lets a word that spells an abbreviation through when nothing else is lexical', () => {
    expect(validateValue('pass.PL', gloss)).toEqual([]);
  });

  it('files a lower-case abbreviation read as grammatical with the tags when seeding', () => {
    const fresh = { delimiters: '.', mode: 'suggest', values: [] };
    expect(seedCandidates([['go.3.pfv', 1]], fresh)).toEqual({
      tags: [{ value: '3' }, { value: 'pfv' }],
      lexical: [{ value: 'go' }],
    });
  });
});

describe('the unit a gloss is read in', () => {
  const flags = (value) => lenientFlags(glossMorphemes(value)).flat();
  const mixed = { delimiters: '.:-=', mode: 'mixed', values: [{ value: 'PST' }, { value: '3' }] };
  const word = (...ms) => ms.map(([morphType, form, gloss]) => ({ morphType, form, gloss }));

  it('reads an affix gloss with no fall-back', () => {
    expect(flags('sbj:3.pfv')).toEqual([false, false, false]);
    expect(flags('pass.PST')).toEqual([false, false]);
    expect(flags('go.3SG.pfv')).toEqual([true, false, false]);
  });

  it('holds a suffix cell to the list where a stem cell falls back', () => {
    const suffix = word(['stem', 'pa', 'pass.PST'], ['suffix', 'ti', 'sbj:3.pfv']);
    const affix = readingTagset(mixed, morphemeGlossReading(suffix, 1));
    expect(validateValue('sbj:3.pfv', affix).map((v) => v.part)).toEqual(['sbj', 'pfv']);
    expect(
      validateValue('pass.PST', readingTagset(mixed, morphemeGlossReading(suffix, 0))),
    ).toEqual([]);
    // With no morph type beside it, a value is a stem's gloss.
    expect(validateValue('sbj:3.pfv', mixed)).toEqual([]);
  });

  it("reads a clitic's and a zero morph's gloss as an affix's", () => {
    const w = word(['stem', 'pa', 'pass'], ['enclitic', 'ka', 'sbj:3'], [null, '∅', 'top.PST']);
    expect(morphemeGlossReading(w, 1)).toEqual({ bound: true, beside: [] });
    expect(morphemeGlossReading(w, 2)).toEqual({ bound: true, beside: [] });
  });

  it("reads a stem's gloss with the word's other stems, so one lexical stem ends the fall-back", () => {
    const w = word(['stem', 'pa', 'pass.PST'], ['root', 'go', 'go'], ['suffix', 's', 'PL']);
    expect(morphemeGlossReading(w, 0)).toEqual({ bound: false, beside: ['go'] });
    const stem = readingTagset(mixed, morphemeGlossReading(w, 0));
    expect(validateValue('pass.PST', stem).map((v) => v.part)).toEqual(['pass']);
  });

  it('reads a joined gloss by its pieces', () => {
    const value = 'pass.PST-sbj:3.pfv=and';
    const bound = boundByPieces([
      { text: 'pass.PST', bound: false },
      { text: 'sbj:3.pfv', bound: true },
      { text: 'and', bound: true },
    ]);
    expect(lexicalFlagsOf(value, scanValue(value, '.:-='), { bound })).toEqual([
      true,
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it('checks a morpheme in an analysis as its cell reads it', () => {
    const tagsetFor = (scope) => (scope === 'morpheme' ? mixed : null);
    const analysis = {
      word: { fields: {} },
      morphemes: [
        { form: 'pa', morphType: 'stem', fields: { Gloss: 'pass.PST' } },
        { form: 'ti', morphType: 'suffix', fields: { Gloss: 'sbj:3.pfv' } },
      ],
    };
    expect(analysisViolations(analysis, tagsetFor).map((v) => v.value)).toEqual(['sbj:3.pfv']);
  });
});

describe('a value known only by its own morph type', () => {
  const mixed = { delimiters: '.:-=', mode: 'mixed', values: [{ value: 'PST' }, { value: '3' }] };
  const suffix = glossReadingOf('suffix', 'ti');

  it("reads an affix's, a clitic's and a zero morph's gloss as the grid does", () => {
    expect(suffix).toEqual({ bound: true, beside: [] });
    expect(glossReadingOf('enclitic', 'ka')).toEqual({ bound: true, beside: [] });
    expect(glossReadingOf(null, '∅')).toEqual({ bound: true, beside: [] });
    expect(glossReadingOf('stem', '')).toEqual({ bound: true, beside: [] });
  });

  it("reads a stem's, an untyped morpheme's and a formless morpheme's alone", () => {
    expect(glossReadingOf('stem', 'pa')).toBeUndefined();
    expect(glossReadingOf(null, 'pa')).toBeUndefined();
    expect(glossReadingOf('root', null)).toBeUndefined();
    expect(glossReadingOf(undefined)).toBeUndefined();
  });

  it("counts only a suffix's occurrences of a value a stem's pass", () => {
    const attested = [
      ['sbj:3.pfv', 9],
      ['sbj:3.pfv', 4, suffix],
      ['pass.PST', 2, suffix],
    ];
    expect(offTagsetValues(attested, mixed)).toEqual([
      {
        value: 'sbj:3.pfv',
        count: 4,
        violations: [
          { part: 'sbj', begin: 0, end: 3, reason: 'unknown' },
          { part: 'pfv', begin: 6, end: 9, reason: 'unknown' },
        ],
      },
      {
        value: 'pass.PST',
        count: 2,
        violations: [{ part: 'pass', begin: 0, end: 4, reason: 'unknown' }],
      },
    ]);
  });

  it('merges one value failing under two readings into one row', () => {
    const closedish = { ...mixed, values: [{ value: 'PST' }] };
    expect(
      offTagsetValues(
        [
          ['sbj:3.pfv', 9],
          ['sbj:3.pfv', 4, suffix],
        ],
        closedish,
      ),
    ).toEqual([
      {
        value: 'sbj:3.pfv',
        count: 13,
        violations: [
          { part: 'sbj', begin: 0, end: 3, reason: 'unknown' },
          { part: '3', begin: 4, end: 5, reason: 'unknown' },
          { part: 'pfv', begin: 6, end: 9, reason: 'unknown' },
        ],
      },
    ]);
  });

  it("files a suffix's lower-case abbreviations with the tags when seeding", () => {
    const fresh = { delimiters: '.:', mode: 'suggest', values: [] };
    expect(seedCandidates([['sbj:3.pfv', 1, suffix]], fresh)).toEqual({
      tags: [{ value: '3' }, { value: 'pfv' }, { value: 'sbj' }],
      lexical: [],
    });
    expect(seedCandidates([['sbj:3.pfv', 1]], fresh)).toEqual({
      tags: [{ value: '3' }],
      lexical: [{ value: 'pfv' }, { value: 'sbj' }],
    });
    expect(offTagsetParts([['sbj:3.pfv', 2, suffix]], { ...fresh, mode: 'mixed' })).toEqual([
      { part: '3', count: 2 },
      { part: 'pfv', count: 2 },
      { part: 'sbj', count: 2 },
    ]);
  });
});

describe('entryTagsetFor', () => {
  const mixed = { delimiters: '.:', mode: 'mixed', values: [{ value: '3' }] };
  const tagsetFor = (name) => (name === 'gloss' ? mixed : null);

  it("reads a suffix entry's gloss with no fall-back and a stem's alone", () => {
    const suffix = entryTagsetFor(tagsetFor, 'suffix', 'ti');
    expect(validateValue('sbj:3.pfv', suffix('gloss')).map((v) => v.part)).toEqual(['sbj', 'pfv']);
    expect(validateValue('sbj:3.pfv', entryTagsetFor(tagsetFor, 'stem', 'sa')('gloss'))).toEqual(
      [],
    );
    expect(suffix('pos')).toBeNull();
  });

  it('reads an untyped entry, or one with no form yet, as a stem', () => {
    expect(validateValue('sbj:3.pfv', entryTagsetFor(tagsetFor, null, 'ka')('gloss'))).toEqual([]);
    expect(validateValue('sbj:3.pfv', entryTagsetFor(tagsetFor, null, '')('gloss'))).toEqual([]);
    expect(
      validateValue('sbj:3.pfv', entryTagsetFor(tagsetFor, null, '∅')('gloss')).length,
    ).toBeGreaterThan(0);
  });
});

describe('unreachableValues', () => {
  it('flags a value holding one of its own delimiters', () => {
    // "1SG.NOM" in a tagset that splits on "." is scanned as two parts, so the
    // list would hold a value it rejects.
    const t = { delimiters: '.', mode: 'closed', values: [{ value: '1SG.NOM' }, { value: 'PL' }] };
    expect(unreachableValues(t).map((v) => v.value)).toEqual(['1SG.NOM']);
    expect(isValueAllowed('1SG.NOM', t)).toBe(false);
  });

  it('says nothing for a whole-cell tagset, where the value is never split', () => {
    const t = { delimiters: '', mode: 'closed', values: [{ value: '1SG.NOM' }] };
    expect(unreachableValues(t)).toEqual([]);
    expect(isValueAllowed('1SG.NOM', t)).toBe(true);
  });
});

describe('analysisViolations', () => {
  const tagsetFor = (scope, field) => (scope === 'morpheme' && field === 'Gloss' ? leipzig : null);

  it('finds an off-tagset gloss anywhere in the analysis', () => {
    // Re-analyze spreads one analysis to every occurrence, so this is asked of
    // the analysis before any of it is written.
    const bad = {
      word: { fields: { POS: 'anything' } },
      morphemes: [{ fields: { Gloss: '1SG' } }, { fields: { Gloss: 'ABL' } }],
    };
    expect(analysisViolations(bad, tagsetFor)).toEqual([
      {
        scope: 'morpheme',
        field: 'Gloss',
        value: 'ABL',
        violations: [{ part: 'ABL', begin: 0, end: 3, reason: 'unknown' }],
      },
    ]);
  });

  it('passes a clean analysis, and one with no governed fields at all', () => {
    expect(
      analysisViolations({ morphemes: [{ fields: { Gloss: '1SG.NOM' } }] }, tagsetFor),
    ).toEqual([]);
    expect(analysisViolations({ word: { fields: { POS: 'n' } } }, () => null)).toEqual([]);
  });

  it('tolerates a bare or empty analysis', () => {
    expect(analysisViolations(null, tagsetFor)).toEqual([]);
    expect(analysisViolations({}, tagsetFor)).toEqual([]);
  });
});

describe('sortedValues', () => {
  it('sorts a hand-made inventory, and keeps an ordered one as written', () => {
    // Status is draft, reviewed, published: a workflow. Alphabetical listed it
    // draft, published, reviewed, which reads as one that goes backwards.
    const made = { values: [{ value: 'PL' }, { value: 'ERG' }, { value: 'ABS' }] };
    expect(sortedValues(made).map((v) => v.value)).toEqual(['ABS', 'ERG', 'PL']);
    expect(sortedValues(statusTagset()).map((v) => v.value)).toEqual(STATUS_VALUES);
    expect(STATUS_VALUES).toEqual(['draft', 'reviewed', 'published']);
  });
});

describe('glossSmallCaps and capsAreSmallCaps', () => {
  const sc = (value, reading) =>
    glossSmallCaps(value, reading)
      .filter((p) => p.smallCaps)
      .map((p) => p.text);

  it('sets each grammatical part in small caps and keeps the rest of the text', () => {
    expect(sc('1SG.NOM')).toEqual(['1SG', 'NOM']);
    expect(
      glossSmallCaps('go-PST')
        .map((p) => p.text)
        .join(''),
    ).toBe('go-PST');
    expect(sc('go-PST')).toEqual(['PST']);
  });

  it('never sets a part without a letter', () => {
    expect(sc('3-PL')).toEqual(['PL']);
  });

  it('reads an affix gloss with no fall-back, as the Analyze cell does', () => {
    expect(sc('obj:3', { bound: true, beside: [] })).toEqual(['obj']);
  });

  it('draws capitals as small caps only when every capital is a tag', () => {
    expect(capsAreSmallCaps('TOP')).toBe(true);
    expect(capsAreSmallCaps('AGR:1A', { bound: true, beside: [] })).toBe(true);
    // Nothing to draw: no capital at all.
    expect(capsAreSmallCaps('potato')).toBe(false);
    expect(capsAreSmallCaps('')).toBe(false);
    // A capitalised word beside a tag: c2sc would shrink its capital too.
    expect(capsAreSmallCaps('John-PL')).toBe(false);
  });
});
