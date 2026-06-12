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
