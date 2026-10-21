import { describe, it, expect } from 'vitest';
import {
  isGlossLikeField,
  pairRows,
  pickerFieldOf,
  pickerLexicon,
  senseFills,
} from './pairRows.js';
import { addPrecedent, createTally, SLOT_LINK } from './precedent.js';
import { PRECEDENT_SOURCE, TAGSET_SOURCE, VOCAB_ENTRY_SOURCE } from './glossGuess.js';

// A lexicon of "sell": a headword with no gloss and two senses, and another
// entry spelled the same.
const LEX = {
  id: 'v1',
  name: 'Lexicon',
  items: [
    { id: 'h', form: 'sel', metadata: {} },
    { id: 's1', form: 'sel', metadata: { gloss: 'sell', parent: 'h', senseOrder: 1 } },
    { id: 's2', form: 'sel', metadata: { gloss: 'sold', parent: 'h', senseOrder: 2 } },
    { id: 'o', form: 'sel', metadata: { gloss: 'salt' } },
    { id: 'x', form: 'other', metadata: { gloss: 'another' } },
  ],
};
const lexicons = (...vocabs) => (vocabs.length ? vocabs : [LEX]).map((v) => pickerLexicon(v));

const span = (value, metadata = {}) => ({ value, metadata });
const model = (value, detail) =>
  span(value, { prov: 'inferred', provSource: 'service:m', provDetail: detail });
const morph = ({ link = null, gloss = null } = {}) => ({
  vocabItem: link,
  annotations: gloss ? { Gloss: gloss } : {},
});
const link = (id, prov = 'human') => ({ id, form: 'sel', vocabId: 'v1', prov });

const rowsOf = (args) =>
  pairRows({ field: 'Gloss', form: 'sel', lexicons: lexicons(), ...args }).rows.map((r) => [
    r.itemId,
    r.value,
  ]);

describe('isGlossLikeField and pickerFieldOf', () => {
  it('reads a gloss field by its name, a language left out', () => {
    expect(isGlossLikeField('Gloss')).toBe(true);
    expect(isGlossLikeField('Gloss (pmy)')).toBe(true);
    expect(isGlossLikeField('Morpheme gloss')).toBe(true);
    expect(isGlossLikeField('Glosa')).toBe(true);
    expect(isGlossLikeField('Glose (fr)')).toBe(true);
    expect(isGlossLikeField('POS')).toBe(false);
    expect(isGlossLikeField('Note (gloss)')).toBe(false);
  });

  it('picks the gloss field recording the producer’s entries, else the first', () => {
    const m = {
      annotations: {
        'Gloss (es)': model('vender', { valueLinks: [{ value: 'vender', item: 's1', prob: 1 }] }),
      },
    };
    expect(pickerFieldOf(m, ['POS', 'Gloss (en)', 'Gloss (es)'])).toBe('Gloss (es)');
    expect(pickerFieldOf({ annotations: {} }, ['POS', 'Gloss (en)', 'Gloss (es)'])).toBe(
      'Gloss (en)',
    );
    expect(pickerFieldOf({ annotations: {} }, ['POS'])).toBeNull();
  });

  it('keeps only valueLinks entries that are whole and still exist', () => {
    const gloss = model('sell', {
      valueLinks: [
        { value: 'sell', item: 's1', prob: 0.5 },
        { value: '', item: 's2', prob: 0.4 },
        { value: 'gone', item: 'zz', prob: 0.3 },
        null,
      ],
    });
    const { rows } = pairRows({
      morph: morph({ gloss }),
      field: 'Gloss',
      form: 'sel',
      lexicons: lexicons(),
    });
    expect(rows.filter((r) => r.model).map((r) => [r.itemId, r.value])).toEqual([['s1', 'sell']]);
  });
});

describe('pairRows', () => {
  it('lists the producer’s pairs by probability after the current row', () => {
    const gloss = model('sell', {
      valueLinks: [
        { value: 'sell', item: 's1', prob: 0.4 },
        { value: 'sold', item: 's2', prob: 0.5 },
      ],
      valueProbs: { sell: 0.4, sold: 0.5, sale: 0.1 },
    });
    const { rows } = pairRows({
      morph: morph({ link: link('s1', 'machine'), gloss }),
      field: 'Gloss',
      form: 'sel',
      lexicons: lexicons(),
    });
    expect(rows.slice(0, 4).map((r) => [r.itemId, r.value, r.prob])).toEqual([
      ['s1', 'sell', 0.4],
      ['s2', 'sold', 0.5],
      // A value with no entry of its own keeps the current link.
      ['s1', 'sale', 0.1],
      // Then the lexicon: the tree of the linked entry.
      ['h', '', null],
    ]);
    expect(rows[0].current).toBe(true);
    expect(rows[0].model).toBe(true);
    expect(rows[1]).toMatchObject({ source: 'service:m', linkSource: 'service:m' });
    expect(rows[1].linkChange).toBe(true);
    expect(rows[2]).toMatchObject({ linkSource: null, linkChange: false, valueChange: true });
  });

  it('turns an alternative whose entry is gone into a value that keeps the link', () => {
    const gloss = model('sell', {
      valueLinks: [{ value: 'sold', item: 'gone', prob: 0.3 }],
      valueProbs: { sold: 0.3 },
    });
    const rows = rowsOf({ morph: morph({ gloss }) });
    expect(rows).toContainEqual([null, 'sold']);
    expect(rows.some(([id]) => id === 'gone')).toBe(false);
  });

  it('gives a value with no entry the current link, merging with the current row', () => {
    const tally = createTally();
    addPrecedent(tally, 'morpheme', 'sel', 'Gloss', 'sell');
    addPrecedent(tally, 'morpheme', 'sel', 'Gloss', 'sell');
    addPrecedent(tally, 'morpheme', 'sel', 'Gloss', 'trade');
    const { rows } = pairRows({
      morph: morph({ link: link('s1'), gloss: span('sell') }),
      field: 'Gloss',
      form: 'sel',
      precedent: tally,
      lexicons: lexicons(),
    });
    expect(rows[0]).toMatchObject({ itemId: 's1', value: 'sell', current: true, count: 2 });
    const trade = rows.find((r) => r.value === 'trade');
    expect(trade).toMatchObject({ itemId: 's1', count: 1, source: PRECEDENT_SOURCE });
    // On an unlinked morpheme the same value names no entry.
    const unlinked = rowsOf({ morph: morph(), precedent: tally });
    expect(unlinked.slice(0, 2)).toEqual([
      [null, 'sell'],
      [null, 'trade'],
    ]);
  });

  it('names an entry only where a source does: a carried link is not the row’s', () => {
    const tally = createTally();
    addPrecedent(tally, 'morpheme', 'sel', 'Gloss', 'trade');
    const { rows } = pairRows({
      morph: morph({ link: link('s1', 'machine'), gloss: span('sell') }),
      field: 'Gloss',
      form: 'sel',
      precedent: tally,
      lexicons: lexicons(),
      tagset: { mode: 'suggest', values: [{ value: 'PL' }] },
    });
    const by = (v) => rows.find((r) => r.value === v);
    expect(by('sell')).toMatchObject({ current: true, named: true });
    expect(by('trade')).toMatchObject({ named: false, linkChange: false });
    expect(by('PL')).toMatchObject({ named: false, linkChange: false });
    expect(rows.find((r) => r.itemId === 's2')).toMatchObject({ named: true, linkChange: true });
  });

  it('from the chip, keeps a value a person wrote on every sense, showing the sense’s own', () => {
    const args = {
      morph: morph({ gloss: span('cat.PL') }),
      field: 'Gloss',
      form: 'sel',
      lexicons: lexicons(),
    };
    const chip = pairRows({ ...args, keepPersonValue: true }).rows;
    expect(chip.find((r) => r.itemId === 's1')).toMatchObject({
      value: 'cat.PL',
      senseValue: 'sell',
      valueChange: false,
    });
    // A machine value nobody confirmed is not kept, and Alt+Down never keeps.
    expect(pairRows(args).rows.find((r) => r.itemId === 's1').value).toBe('sell');
    const machine = pairRows({
      ...args,
      morph: morph({ gloss: model('cat.PL', {}) }),
      keepPersonValue: true,
    }).rows;
    expect(machine.find((r) => r.itemId === 's1').value).toBe('sell');
  });

  it('puts the senses an enforcing tagset leaves valueless after its values', () => {
    const pairs = rowsOf({ morph: morph(), tagset: { mode: 'closed', values: [{ value: 'PL' }] } });
    expect(pairs[0]).toEqual([null, 'PL']);
    expect(pairs.slice(1).every(([id, v]) => id && v === '')).toBe(true);
  });

  it('keeps two senses with one gloss apart, and one sense with two glosses', () => {
    const lex = {
      ...LEX,
      items: [...LEX.items, { id: 's3', form: 'sel', metadata: { gloss: 'sell', parent: 'h' } }],
    };
    const gloss = model('sell', {
      valueLinks: [
        { value: 'sell', item: 's1', prob: 0.4 },
        { value: 'sell', item: 's3', prob: 0.2 },
        { value: 'sold', item: 's1', prob: 0.1 },
      ],
    });
    const { rows } = pairRows({
      morph: morph({ gloss }),
      field: 'Gloss',
      form: 'sel',
      lexicons: lexicons(lex),
    });
    const pairs = rows.map((r) => [r.itemId, r.value]);
    expect(pairs).toContainEqual(['s1', 'sell']);
    expect(pairs).toContainEqual(['s3', 'sell']);
    expect(pairs).toContainEqual(['s1', 'sold']);
    // Merged with the lexicon's own row for the sense: one row, model tag kept.
    expect(rows.filter((r) => r.itemId === 's1' && r.value === 'sell')).toHaveLength(1);
    expect(rows.find((r) => r.itemId === 's1' && r.value === 'sell').model).toBe(true);
  });

  it('ranks a person’s link’s own sense above project values, a machine link’s not', () => {
    const tally = createTally();
    for (let i = 0; i < 5; i++) addPrecedent(tally, 'morpheme', 'sel', 'Gloss', 'trade');
    const order = (prov) =>
      rowsOf({ morph: morph({ link: link('s2', prov) }), precedent: tally }).slice(0, 3);
    expect(order('human')).toEqual([
      ['s2', ''],
      ['s2', 'sold'],
      ['s2', 'trade'],
    ]);
    expect(order('machine')).toEqual([
      ['s2', ''],
      ['s2', 'trade'],
      ['h', ''],
    ]);
  });

  it('lists the lexicon as trees: the linked entry’s, the earlier links’, the same form’s', () => {
    const tally = createTally();
    addPrecedent(tally, 'morpheme', 'sel', SLOT_LINK, 'x');
    const { rows } = pairRows({
      morph: morph({ link: link('o') }),
      field: 'Gloss',
      form: 'sel',
      precedent: tally,
      lexicons: lexicons(),
    });
    expect(rows.map((r) => [r.itemId, r.value, r.depth, r.context])).toEqual([
      ['o', '', 0, false], // current: linked, no gloss yet
      ['o', 'salt', 0, false],
      ['x', 'another', 0, false],
      ['h', '', 0, true], // a headword with senses and no gloss, for context
      ['s1', 'sell', 1, false],
      ['s2', 'sold', 1, false],
    ]);
    expect(rows.find((r) => r.itemId === 'o' && r.value === 'salt').source).toBe(
      VOCAB_ENTRY_SOURCE,
    );
  });

  it('pairs a sense with the entry field its language names', () => {
    const lex = {
      id: 'v1',
      name: 'L',
      items: [{ id: 'e', form: 'sel', metadata: { gloss: 'sell', 'gloss (es)': 'vender' } }],
    };
    const { rows } = pairRows({
      morph: morph(),
      field: 'Gloss (es)',
      form: 'sel',
      lexicons: lexicons(lex),
    });
    expect(rows.map((r) => [r.itemId, r.value])).toEqual([['e', 'vender']]);
    // A field no entry answers for gives link-only rows.
    const pos = pairRows({ morph: morph(), field: 'Note', form: 'sel', lexicons: lexicons(lex) });
    expect(pos.rows.map((r) => [r.itemId, r.value])).toEqual([['e', '']]);
  });

  it('under an enforcing tagset keeps the entry of a pair whose value it refuses', () => {
    const tagset = {
      mode: 'closed',
      values: [{ value: 'SELL', description: 'to sell' }, { value: 'PL' }],
    };
    const gloss = model('', { valueLinks: [{ value: 'sold', item: 's2', prob: 0.6 }] });
    const tally = createTally();
    addPrecedent(tally, 'morpheme', 'sel', 'Gloss', 'nope');
    const { rows } = pairRows({
      morph: morph({ gloss }),
      field: 'Gloss',
      form: 'sel',
      precedent: tally,
      lexicons: lexicons(),
      tagset,
    });
    const pairs = rows.map((r) => [r.itemId, r.value]);
    expect(pairs[0]).toEqual(['s2', '']);
    expect(pairs).not.toContainEqual([null, 'nope']);
    expect(pairs).not.toContainEqual(['s1', 'sell']);
    expect(pairs).toContainEqual(['s1', '']);
    expect(rows.find((r) => r.value === 'SELL')).toMatchObject({
      itemId: null,
      description: 'to sell',
      source: TAGSET_SOURCE,
    });
  });

  it('drops a one-off lexical value under a mixed tagset, keeping the lexicon’s', () => {
    const tagset = { mode: 'mixed', values: [{ value: 'PL' }] };
    const tally = createTally();
    addPrecedent(tally, 'morpheme', 'sel', 'Gloss', 'typo');
    addPrecedent(tally, 'morpheme', 'sel', 'Gloss', 'trade');
    addPrecedent(tally, 'morpheme', 'sel', 'Gloss', 'trade');
    const pairs = rowsOf({ morph: morph(), precedent: tally, tagset });
    expect(pairs).not.toContainEqual([null, 'typo']);
    expect(pairs).toContainEqual([null, 'trade']);
    expect(pairs).toContainEqual(['s1', 'sell']);
  });

  it('draws on every vocabulary, naming each row’s', () => {
    const other = {
      id: 'v2',
      name: 'Loans',
      items: [{ id: 'l', form: 'sel', metadata: { gloss: 'cell' } }],
    };
    const { rows } = pairRows({
      morph: morph(),
      field: 'Gloss',
      form: 'sel',
      lexicons: lexicons(LEX, other),
    });
    expect(rows.find((r) => r.itemId === 'l')).toMatchObject({ vocabName: 'Loans', value: 'cell' });
    expect(rows.find((r) => r.itemId === 's1')).toMatchObject({ vocabName: 'Lexicon', sub: '1.1' });
  });

  it('caps the list and counts what it left out', () => {
    const many = {
      id: 'v1',
      name: 'L',
      items: Array.from({ length: 40 }, (_, i) => ({
        id: `e${i}`,
        form: 'sel',
        metadata: { gloss: `g${i}` },
      })),
    };
    const { rows, more } = pairRows({
      morph: morph(),
      field: 'Gloss',
      form: 'sel',
      lexicons: lexicons(many),
      cap: 30,
    });
    expect(rows).toHaveLength(30);
    expect(more).toBe(10);
  });

  it('a search lists the lexicon’s matches and the values it begins', () => {
    const tally = createTally();
    addPrecedent(tally, 'morpheme', 'sel', 'Gloss', 'another way');
    addPrecedent(tally, 'morpheme', 'sel', 'Gloss', 'trade');
    const pairs = rowsOf({ morph: morph(), precedent: tally, search: 'anoth' });
    expect(pairs).toEqual([
      [null, 'another way'],
      ['x', 'another'],
    ]);
  });

  it('gives link-only rows with no picker field', () => {
    const { rows } = pairRows({ morph: morph(), field: null, form: 'other', lexicons: lexicons() });
    expect(rows.map((r) => [r.itemId, r.value])).toEqual([['x', '']]);
  });
});

describe('senseFills', () => {
  const item = { id: 's1', metadata: { gloss: 'sell', 'gloss (es)': 'vender' } };
  const lexicon = pickerLexicon(LEX);
  const info = () => ({ fieldLang: null, tagset: null });

  it('fills an empty field and a machine value nobody confirmed, never a person’s', () => {
    const m = {
      annotations: {
        'Gloss (es)': span('vendido', { prov: 'inferred', provSource: 'service:m' }),
        'Gloss (fr)': span('vendre'),
      },
    };
    expect(
      senseFills({
        morph: m,
        item: { ...item, metadata: { ...item.metadata, 'gloss (fr)': 'vente' } },
        lexicon,
        fields: ['Gloss (es)', 'Gloss (fr)'],
        fieldInfo: info,
      }),
    ).toEqual([{ field: 'Gloss (es)', value: 'vender' }]);
    expect(
      senseFills({
        morph: { annotations: {} },
        item,
        lexicon,
        fields: ['Gloss (es)'],
        fieldInfo: info,
      }),
    ).toEqual([{ field: 'Gloss (es)', value: 'vender' }]);
  });

  it('skips a value the field’s tagset refuses, and a sense with none', () => {
    const closed = () => ({ tagset: { mode: 'closed', values: [{ value: 'SELL' }] } });
    expect(
      senseFills({
        morph: { annotations: {} },
        item,
        lexicon,
        fields: ['Gloss (es)'],
        fieldInfo: closed,
      }),
    ).toEqual([]);
    expect(
      senseFills({
        morph: { annotations: {} },
        item,
        lexicon,
        fields: ['Gloss (de)'],
        fieldInfo: info,
      }),
    ).toEqual([]);
  });
});
