import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import {
  readCldfDataset,
  parseCsv,
  cell,
  list,
  customColumnsOf,
  CldfError,
} from './readDataset.js';

const TERMS = 'http://cldf.clld.org/v1.0/terms.rdf#';

const descriptor = (tables, extra = {}) => ({
  '@context': ['http://www.w3.org/ns/csvw', { '@language': 'en' }],
  'dc:conformsTo': `${TERMS}TextCorpus`,
  'dc:title': 'Test corpus',
  dialect: { commentPrefix: null },
  tables,
  ...extra,
});

const exampleTable = (columns, url = 'examples.csv') => ({
  url,
  'dc:conformsTo': `${TERMS}ExampleTable`,
  tableSchema: { columns },
});

const col = (name, term, extra = {}) => ({
  name,
  ...(term ? { propertyUrl: `${TERMS}${term}` } : {}),
  datatype: 'string',
  ...extra,
});

const zip = (files, prefix = '') =>
  zipSync(Object.fromEntries(Object.entries(files).map(([p, d]) => [`${prefix}${p}`, strToU8(d)])));

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, embedded newlines, CRLF and a BOM', () => {
    const text = '﻿A,B\r\n"say ""hi""","two\nlines"\r\nplain,\r\n';
    expect(parseCsv(text)).toEqual([
      ['A', 'B'],
      ['say "hi"', 'two\nlines'],
      ['plain', ''],
    ]);
  });

  it('accepts a custom delimiter and a missing trailing newline', () => {
    expect(parseCsv('A\tB\nx\ty', '\t')).toEqual([
      ['A', 'B'],
      ['x', 'y'],
    ]);
  });

  it('treats a quote after content as literal, not as an opening quote', () => {
    expect(parseCsv('A\r\n5" pipe\r\n')).toEqual([['A'], ['5" pipe']]);
  });
});

describe('readCldfDataset', () => {
  const files = {
    'cldf-metadata.json': JSON.stringify(
      descriptor([
        exampleTable([
          col('ID', 'id'),
          col('Language_ID', 'languageReference'),
          col('Primary_Text', 'primaryText'),
          col('Analyzed_Word', 'analyzedWord', { separator: '\t', null: [] }),
          col('Gloss', 'gloss', { separator: '\t', null: [] }),
          col('Notes', null),
        ]),
      ]),
    ),
    'examples.csv':
      'ID,Language_ID,Primary_Text,Analyzed_Word,Gloss,Notes\r\n1,spa,perros corren.,perro=s\tcorren,dog=PL\t,hi\r\n',
  };

  it('resolves tables by dc:conformsTo and columns by propertyUrl', () => {
    const ds = readCldfDataset(zip(files));
    expect(ds.module).toBe('TextCorpus');
    expect(ds.title).toBe('Test corpus');
    const ex = ds.components.ExampleTable;
    expect(ex.rows).toHaveLength(1);
    expect(cell(ex, ex.rows[0], 'primaryText')).toBe('perros corren.');
    expect(list(ex, ex.rows[0], 'analyzedWord')).toEqual(['perro=s', 'corren']);
  });

  it('binds by propertyUrl, not by column name', () => {
    const renamed = {
      'cldf-metadata.json': JSON.stringify(
        descriptor([
          exampleTable([
            col('ID', 'id'),
            col('Text', 'primaryText'),
            // A column NAMED Gloss but bound to nothing means nothing.
            col('Gloss', null),
            col('TheGlosses', 'gloss', { separator: '\t', null: [] }),
          ]),
        ]),
      ),
      'examples.csv': 'ID,Text,Gloss,TheGlosses\r\n1,hola,junk,hello\r\n',
    };
    const ex = readCldfDataset(zip(renamed)).components.ExampleTable;
    expect(cell(ex, ex.rows[0], 'primaryText')).toBe('hola');
    expect(list(ex, ex.rows[0], 'gloss')).toEqual(['hello']);
    expect(customColumnsOf(ex)).toEqual(['Gloss']);
  });

  it('honours a declared null list, and keeps empty list items when null is []', () => {
    const ds = readCldfDataset(zip(files));
    const ex = ds.components.ExampleTable;
    // Gloss declares null: [], so the trailing empty item is a real empty slot.
    expect(list(ex, ex.rows[0], 'gloss')).toEqual(['dog=PL', '']);
  });

  it('treats "" as null on a column that does not opt out', () => {
    const withNulls = {
      'cldf-metadata.json': JSON.stringify(
        descriptor([
          exampleTable([col('ID', 'id'), col('Primary_Text', 'primaryText'), col('C', 'comment')]),
        ]),
      ),
      'examples.csv': 'ID,Primary_Text,C\r\n1,hi,\r\n',
    };
    const ex = readCldfDataset(zip(withNulls)).components.ExampleTable;
    expect(cell(ex, ex.rows[0], 'comment')).toBe('');
  });

  it('finds a descriptor nested under a release directory', () => {
    const ds = readCldfDataset(zip(files, 'mydata-1.0/cldf/'));
    expect(ds.baseDir).toBe('mydata-1.0/cldf/');
    expect(ds.components.ExampleTable.rows).toHaveLength(1);
  });

  it('warns about a table whose file is missing rather than failing', () => {
    const partial = {
      'cldf-metadata.json': JSON.stringify(
        descriptor([
          exampleTable([col('ID', 'id'), col('Primary_Text', 'primaryText')]),
          { url: 'gone.csv', 'dc:conformsTo': `${TERMS}LanguageTable`, tableSchema: {} },
        ]),
      ),
      'examples.csv': 'ID,Primary_Text\r\n1,hi\r\n',
    };
    const ds = readCldfDataset(zip(partial));
    expect(ds.warnings.join(' ')).toMatch(/gone\.csv/);
    expect(ds.components.ExampleTable).toBeTruthy();
  });

  it('reads a metadata-free dataset by the standard filenames and columns', () => {
    const bare = {
      'examples.csv':
        'ID,Language_ID,Primary_Text,Analyzed_Word,Gloss\r\n1,spa,perros,perro=s,dog=PL\r\n',
    };
    const ds = readCldfDataset(zip(bare));
    const ex = ds.components.ExampleTable;
    expect(cell(ex, ex.rows[0], 'primaryText')).toBe('perros');
    expect(list(ex, ex.rows[0], 'analyzedWord')).toEqual(['perro=s']);
    expect(ds.warnings.join(' ')).toMatch(/no cldf-metadata\.json/);
  });

  it('rejects an archive with nothing CLDF in it', () => {
    expect(() => readCldfDataset(zip({ 'readme.txt': 'hello' }))).toThrow(CldfError);
    expect(() => readCldfDataset(new Uint8Array([1, 2, 3]))).toThrow(/Not a zip archive/);
  });
});
