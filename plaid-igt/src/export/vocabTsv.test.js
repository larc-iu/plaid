import { describe, it, expect } from 'vitest';
import { serializeVocabTsv, tsvCell } from './vocabTsv.js';

describe('tsvCell', () => {
  it('collapses tabs and newlines to a space', () => {
    expect(tsvCell('a\tb\r\nc')).toBe('a b c');
    expect(tsvCell(null)).toBe('');
    expect(tsvCell(0)).toBe('0');
  });
});

describe('serializeVocabTsv', () => {
  it('leaves out the Number column when nothing is actually numbered', () => {
    // Every vocabulary has a numbering, but a lexicon with no senses and no
    // two entries spelled alike numbers nothing, and an empty column is noise.
    const items = [
      { id: 'a', form: 'perro', metadata: { gloss: 'dog' } },
      { id: 'b', form: 'gato', metadata: { gloss: 'cat' } },
    ];
    const numbers = new Map([
      ['a', ''],
      ['b', ''],
    ]);
    expect(serializeVocabTsv({ items, fieldNames: ['gloss'], numbers })).toBe(
      'Form\tgloss\nperro\tdog\ngato\tcat\n',
    );
    // One numbered entry earns the column for the whole file.
    const some = new Map([
      ['a', '1'],
      ['b', ''],
    ]);
    expect(serializeVocabTsv({ items, fieldNames: ['gloss'], numbers: some })).toBe(
      'Form\tNumber\tgloss\nperro\t1\tdog\ngato\t\tcat\n',
    );
  });

  const items = [
    { id: 'a', form: 'perro', metadata: { gloss: 'dog', pos: 'N' } },
    { id: 'b', form: 'gato\tmontés', metadata: { gloss: 'wildcat' } },
  ];

  it('emits header + rows with usage counts', () => {
    const out = serializeVocabTsv({ items, fieldNames: ['gloss', 'pos'], usageCounts: { a: 3 } });
    expect(out.split('\n')).toEqual([
      'Form\tgloss\tpos\tUses',
      'perro\tdog\tN\t3',
      'gato montés\twildcat\t\t0',
      '',
    ]);
  });

  it('omits the Uses column without usageCounts', () => {
    const out = serializeVocabTsv({ items, fieldNames: ['gloss'] });
    expect(out.split('\n')[0]).toBe('Form\tgloss');
  });

  it('uses fieldLabels for the header while reading metadata by fieldNames', () => {
    const out = serializeVocabTsv({ items, fieldNames: ['gloss'], fieldLabels: ['Gloss'] });
    expect(out.split('\n').slice(0, 2)).toEqual(['Form\tGloss', 'perro\tdog']);
  });
});

describe('serializeVocabTsv — a dictionary', () => {
  const items = [
    { id: 'h', form: 'a', metadata: { gloss: 'one' } },
    { id: 's', form: 'a', metadata: { gloss: 'two', parent: 'h', senseOrder: 1 } },
    { id: 'r', form: 'run', metadata: { gloss: 'run', variantOf: 'h', seeAlso: ['s', 'h'] } },
  ];
  const numbers = new Map([
    ['h', '1'],
    ['s', '1.1'],
    ['r', ''],
  ]);

  it('adds the number and names referenced entries instead of ids', () => {
    const out = serializeVocabTsv({
      items,
      fieldNames: ['gloss', 'variantOf', 'seeAlso'],
      numbers,
      refFields: ['variantOf', 'seeAlso'],
    });
    expect(out.split('\n')).toEqual([
      'Form\tNumber\tgloss\tvariantOf\tseeAlso',
      'a\t1\tone\t\t',
      'a\t1.1\ttwo\t\t',
      'run\t\trun\ta 1\ta 1.1; a 1',
      '',
    ]);
  });
});
