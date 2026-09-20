import { describe, it, expect } from 'vitest';
import {
  buildCldfDataset,
  defaultCldfOptions,
  cldfLossSummary,
  languageId,
  toCsv,
  BASELINE,
} from './cldf.js';
import { makeFixtureDoc, makeAlignmentToken } from './testFixtures.js';
import { splitAnalyzed } from '../import/align.js';

const LAYERS = {
  orthographies: ['Translit'],
  wordFields: ['POS'],
  morphFields: ['Gloss'],
  sentFields: ['Translation', 'Note'],
  hasMorphemes: true,
};

const LANGUAGES = {
  object: {
    name: 'Spanish',
    glottocode: 'stan1288',
    iso639P3: 'spa',
    latitude: 40.4,
    longitude: -3.7,
  },
  meta: {
    name: 'English',
    glottocode: 'stan1293',
    iso639P3: 'eng',
    latitude: null,
    longitude: null,
  },
};

const OPTIONS = {
  glossField: 'Gloss',
  glossScope: 'morpheme',
  translationField: 'Translation',
  commentField: 'Note',
  primaryText: BASELINE,
  extras: { sentence: [], word: ['POS'], morpheme: [], orthographies: ['Translit'] },
  speakers: true,
  dictionary: true,
};

const build = (over = {}) =>
  buildCldfDataset({
    project: { name: 'Fieldwork' },
    languages: LANGUAGES,
    documents: [{ igtDoc: makeFixtureDoc() }],
    options: OPTIONS,
    ...over,
  });

/** Parse a CSV file back into [header, ...rows] of cell arrays. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const fileNamed = (files, path) => files.find((f) => f.path === path);
const table = (files, path) => {
  const rows = parseCsv(fileNamed(files, path).data);
  const header = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
};
const metadata = (files) => JSON.parse(fileNamed(files, 'cldf-metadata.json').data);
const tableSpec = (files, url) => metadata(files).tables.find((t) => t.url === url);
const columnNamed = (files, url, name) =>
  tableSpec(files, url).tableSchema.columns.find((c) => c.name === name);

describe('toCsv', () => {
  it('quotes only cells that need it, and doubles inner quotes', () => {
    expect(
      toCsv(
        ['A', 'B'],
        [
          ['plain', 'has,comma'],
          ['say "hi"', 'two\nlines'],
        ],
      ),
    ).toBe('A,B\r\nplain,"has,comma"\r\n"say ""hi""","two\nlines"\r\n');
  });
});

describe('languageId', () => {
  it('prefers the glottocode, then ISO, then the name', () => {
    expect(languageId({ glottocode: 'lezg1247', iso639P3: 'lez', name: 'Lezgian' })).toBe(
      'lezg1247',
    );
    expect(languageId({ iso639P3: 'lez', name: 'Lezgian' })).toBe('lez');
    expect(languageId({ name: 'Tok Pisin' })).toBe('Tok-Pisin');
  });

  it('falls back when the language is empty or unusable', () => {
    expect(languageId({}, 'object')).toBe('object');
    expect(languageId({ name: '???' }, 'object')).toBe('object');
  });
});

describe('buildCldfDataset — examples', () => {
  it('writes one example row per sentence with the aligned interlinear lines', () => {
    const { files } = build();
    const [row] = table(files, 'examples.csv');
    expect(row.ID).toBe('1-1');
    expect(row.Language_ID).toBe('stan1288');
    expect(row.Primary_Text).toBe('perros corren.');
    // Morpheme joints come from the shared joiner, so the enclitic gets "=".
    expect(row.Analyzed_Word).toBe('perro=s\tcorren');
    expect(row.Gloss).toBe('dog=PL\t');
    expect(row.Translated_Text).toBe('The dogs run.');
    expect(row.Meta_Language_ID).toBe('stan1293');
    expect(row.Contribution_ID).toBe('1');
    expect(row.Position).toBe('1');
  });

  it('keeps Analyzed_Word and Gloss the same length', () => {
    const { files } = build();
    const [row] = table(files, 'examples.csv');
    expect(row.Gloss.split('\t')).toHaveLength(row.Analyzed_Word.split('\t').length);
  });

  it('writes one marker where the gloss already carries its own', () => {
    // Glosses written to Leipzig by hand ("=PL") reach us from CLDF, from ELAN
    // morph tiers and from FLEx lexicons that decorate their sense glosses.
    // A joiner in front of one would be the second, and since CLDF alignment
    // is positional, the row would claim MORPHEME_ALIGNED while our own
    // importer split the gloss into more pieces than the word.
    const doc = makeFixtureDoc();
    doc.sortedSentences[0].tokens[0].morphemes[1].annotations.Gloss = { value: '=PL' };
    const { files } = build({ documents: [{ igtDoc: doc }] });
    const [row] = table(files, 'examples.csv');
    expect(row.Gloss.split('\t')[0]).toBe('dog=PL');
    expect(row.LGR_Conformance).toBe('MORPHEME_ALIGNED');
    expect(splitAnalyzed(row.Gloss.split('\t')[0])).toHaveLength(
      splitAnalyzed(row.Analyzed_Word.split('\t')[0]).length,
    );
  });

  it('reports MORPHEME_ALIGNED only when every segmented word is fully glossed', () => {
    const { files } = build();
    expect(table(files, 'examples.csv')[0].LGR_Conformance).toBe('MORPHEME_ALIGNED');

    // Blank one morpheme's gloss: the joint in the word line now has no
    // counterpart in the gloss line.
    const doc = makeFixtureDoc();
    doc.sortedSentences[0].tokens[0].morphemes[1].annotations.Gloss = { value: '' };
    const partial = build({ documents: [{ igtDoc: doc }] });
    expect(table(partial.files, 'examples.csv')[0].LGR_Conformance).toBe('WORD_ALIGNED');
  });

  it('falls back to the token content for words with no morphemes', () => {
    const { files } = build();
    expect(table(files, 'examples.csv')[0].Analyzed_Word.split('\t')[1]).toBe('corren');
  });

  it('leaves the partition separator out of Primary_Text', () => {
    // The sentence layer partitions the text, so a sentence span runs to the
    // start of the next one and carries the newline between them.
    const doc = makeFixtureDoc();
    doc.sortedSentences[0].pieces = [
      ...doc.sortedSentences[0].pieces,
      { type: 'gap', content: '\n', isToken: false },
    ];
    const { files } = build({ documents: [{ igtDoc: doc }] });
    expect(table(files, 'examples.csv')[0].Primary_Text).toBe('perros corren.');
  });

  it('can take Primary_Text from an orthography instead of the baseline', () => {
    const { files } = build({ options: { ...OPTIONS, primaryText: 'Translit' } });
    expect(table(files, 'examples.csv')[0].Primary_Text).toBe('perros-translit');
  });

  it('numbers examples and contributions per document', () => {
    const { files } = build({
      documents: [{ igtDoc: makeFixtureDoc() }, { igtDoc: makeFixtureDoc() }],
    });
    expect(table(files, 'examples.csv').map((r) => r.ID)).toEqual(['1-1', '2-1']);
    expect(table(files, 'contributions.csv').map((r) => r.ID)).toEqual(['1', '2']);
  });
});

describe('buildCldfDataset — custom columns', () => {
  it('carries selected extra tiers as tab-aligned custom columns', () => {
    const { files } = build();
    const [row] = table(files, 'examples.csv');
    expect(row.Word_POS).toBe('NOUN\tVERB');
    expect(row.Orthography_Translit).toBe('perros-translit\t');
    // Same length as Analyzed_Word, so the alignment survives.
    expect(row.Word_POS.split('\t')).toHaveLength(row.Analyzed_Word.split('\t').length);
  });

  it('gives custom columns no propertyUrl, so readers ignore them', () => {
    const { files } = build();
    expect(columnNamed(files, 'examples.csv', 'Word_POS').propertyUrl).toBeUndefined();
    expect(columnNamed(files, 'examples.csv', 'Gloss').propertyUrl).toBe(
      'http://cldf.clld.org/v1.0/terms.rdf#gloss',
    );
  });

  it('writes a name CSVW accepts, with the field’s own name beside it', () => {
    const doc = makeFixtureDoc();
    doc.sortedSentences[0].annotations['Free translation'] = { value: 'The dogs bark.' };
    const { files } = build({
      documents: [{ igtDoc: doc }],
      options: { ...OPTIONS, extras: { ...OPTIONS.extras, sentence: ['Free translation'] } },
    });
    // A space is not in CSVW's `name` production, so it goes out
    // percent-encoded and the name a person reads goes in `titles`.
    const column = columnNamed(files, 'examples.csv', 'Sentence_Free%20translation');
    expect(column).toBeDefined();
    expect(column.titles).toBe('Sentence_Free translation');
    const [row] = table(files, 'examples.csv');
    expect(row['Sentence_Free%20translation']).toBe('The dogs bark.');
    // Every column name in every table is one CSVW allows.
    const allowed = /^([A-Za-z0-9!$&'()*+,;=:@_~]|%[0-9A-F]{2})+$/;
    for (const file of files.filter((f) => f.path.endsWith('metadata.json'))) {
      for (const t of JSON.parse(file.data).tables) {
        for (const c of t.tableSchema.columns) {
          expect(c.name, `${t.url} ${c.name}`).toMatch(allowed);
          expect(c.name.startsWith('_')).toBe(false);
        }
      }
    }
  });

  it('drops tiers that are not selected as extras', () => {
    const { files } = build({
      options: { ...OPTIONS, extras: { sentence: [], word: [], morpheme: [], orthographies: [] } },
    });
    const header = Object.keys(table(files, 'examples.csv')[0]);
    expect(header).not.toContain('Word_POS');
    expect(header).not.toContain('Orthography_Translit');
  });

  it('omits optional columns that are empty in every row', () => {
    const doc = makeFixtureDoc();
    doc.sortedSentences[0].annotations.Translation = { value: '' };
    const { files } = build({ documents: [{ igtDoc: doc }] });
    const header = Object.keys(table(files, 'examples.csv')[0]);
    expect(header).not.toContain('Translated_Text');
    expect(header).toContain('Primary_Text');
  });

  it('carries document metadata onto the contribution row', () => {
    const { files } = build();
    const [row] = table(files, 'contributions.csv');
    expect(row.Name).toBe('Test & Doc');
    expect(row.Source).toBe('Field notes');
    expect(row.Genre).toBe('narrative');
    expect(row.Plaid_ID).toBe('d1');
  });

  it('records the speaker when the alignment layer names one', () => {
    const doc = makeFixtureDoc({
      alignmentTokens: [{ ...makeAlignmentToken('a1', 0, 14, 0, 2), metadata: { speaker: 'MJ' } }],
    });
    const { files } = build({ documents: [{ igtDoc: doc }] });
    expect(table(files, 'examples.csv')[0].Speaker).toBe('MJ');
  });
});

describe('buildCldfDataset — languages', () => {
  it('writes a LanguageTable row per distinct language', () => {
    const { files } = build();
    const rows = table(files, 'languages.csv');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      ID: 'stan1288',
      Name: 'Spanish',
      Glottocode: 'stan1288',
      ISO639P3code: 'spa',
      Latitude: '40.4',
      Longitude: '-3.7',
    });
  });

  it('collapses to one row when the object and meta language are the same', () => {
    const { files } = build({ languages: { object: LANGUAGES.object, meta: LANGUAGES.object } });
    const rows = table(files, 'languages.csv');
    expect(rows).toHaveLength(1);
    expect(table(files, 'examples.csv')[0].Meta_Language_ID).toBe('stan1288');
  });

  it('warns, but still exports, when the object language has no code', () => {
    const { files, warnings } = build({
      languages: { object: { name: 'Unknown' }, meta: LANGUAGES.meta },
    });
    expect(warnings.join(' ')).toMatch(/no Glottocode or ISO 639-3/);
    expect(table(files, 'examples.csv')[0].Language_ID).toBe('Unknown');
  });

  it('warns when a translation has no meta language to attribute it to', () => {
    const { files, warnings } = build({ languages: { object: LANGUAGES.object, meta: {} } });
    expect(warnings.join(' ')).toMatch(/No meta language/);
    expect(Object.keys(table(files, 'examples.csv')[0])).not.toContain('Meta_Language_ID');
  });
});

describe('buildCldfDataset — dictionary', () => {
  const vocab = {
    id: 'v1',
    name: 'Lexicon',
    config: { igt: { fields: { gloss: {}, pos: {}, definition: {}, morphType: {} } } },
    items: [
      { id: 'i1', form: 'perro', metadata: { gloss: 'dog', pos: 'N', definition: 'a canine' } },
      { id: 'i2', form: 'correr', metadata: { gloss: 'run', morphType: 'stem' } },
      { id: 'i3', form: 'xyz', metadata: {} },
    ],
  };

  it('turns vocabulary items into entries and senses', () => {
    const { files } = build({ vocabularies: [vocab] });
    const entries = table(files, 'entries.csv');
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      ID: 'e1',
      Language_ID: 'stan1288',
      Headword: 'perro',
      Part_Of_Speech: 'N',
      Vocabulary: 'Lexicon',
    });
    const senses = table(files, 'senses.csv');
    expect(senses).toHaveLength(2);
    expect(senses[0]).toMatchObject({ ID: 's1', Entry_ID: 'e1', Description: 'dog' });
    expect(senses[0].Definition).toBe('a canine');
  });

  it('writes a definition-only sense with its definition in both columns', () => {
    const { files } = build({
      vocabularies: [
        {
          ...vocab,
          items: [
            { id: 'd', form: 'x', metadata: { pos: 'N' } },
            { id: 'ds', form: 'x', metadata: { parent: 'd', definition: 'only a definition' } },
          ],
        },
      ],
    });
    const senses = table(files, 'senses.csv');
    expect(senses).toHaveLength(1);
    expect(senses[0]).toMatchObject({
      Description: 'only a definition',
      Definition: 'only a definition',
    });
  });

  it('omits the sense rather than writing an empty required Description', () => {
    const { files, warnings } = build({ vocabularies: [vocab] });
    expect(table(files, 'senses.csv').map((s) => s.Entry_ID)).toEqual(['e1', 'e2']);
    expect(warnings.join(' ')).toMatch(/no gloss or definition/);
  });

  it('writes a headword as one entry with its senses, and its own gloss first', () => {
    const dict = {
      ...vocab,
      items: [
        { id: 'h', form: 'kat', metadata: { gloss: 'cat' } },
        { id: 's1', form: 'kat', metadata: { gloss: 'lion', parent: 'h', senseOrder: 1 } },
        { id: 's1a', form: 'kat', metadata: { gloss: 'lioness', parent: 's1', senseOrder: 1 } },
        { id: 'c', form: 'run', metadata: { etymology: 'x' } },
        { id: 'cs', form: 'run', metadata: { gloss: 'run', parent: 'c', senseOrder: 1 } },
      ],
    };
    const { files, warnings } = build({ vocabularies: [dict] });
    expect(table(files, 'entries.csv').map((e) => e.Headword)).toEqual(['kat', 'run']);
    expect(table(files, 'senses.csv').map((s) => [s.Entry_ID, s.Description])).toEqual([
      ['e1', 'cat'],
      ['e1', 'lion'],
      ['e1', 'lioness'],
      ['e2', 'run'],
    ]);
    expect(warnings.join(' ')).not.toMatch(/no gloss/);
  });

  it('carries non-core lexicon fields as custom entry columns', () => {
    const { files } = build({ vocabularies: [vocab] });
    expect(table(files, 'entries.csv')[1].Entry_morphType).toBe('stem');
  });

  it('writes the morph type of a vocabulary made without field settings', () => {
    const { files } = build({ vocabularies: [{ ...vocab, config: {} }] });
    expect(table(files, 'entries.csv')[1].Entry_morphType).toBe('stem');
  });

  it('points a sense at the example rows its promoted examples became', () => {
    const dict = {
      ...vocab,
      config: { igt: { fields: { gloss: {} } } },
      items: [
        {
          id: 'i1',
          form: 'perro',
          metadata: {
            gloss: 'dog',
            examples: [
              { document: 'd1', token: 'm1' },
              { document: 'elsewhere', token: 'x' },
            ],
          },
        },
      ],
    };
    const { files } = build({ vocabularies: [dict] });
    const senses = table(files, 'senses.csv');
    // The morpheme's own sentence, once; the example outside this export has
    // no row to name.
    expect(senses[0].Example_IDs).toBe('1-1');
    expect(table(files, 'examples.csv')[0].ID).toBe('1-1');
    const senseTable = metadata(files).tables.find((t) => t.url === 'senses.csv');
    expect(senseTable.tableSchema.foreignKeys).toContainEqual({
      columnReference: 'Example_IDs',
      reference: { resource: 'examples.csv', columnReference: 'ID' },
    });
  });

  it('writes a reference field as the entry it points at, never as an id', () => {
    const dict = {
      id: 'v1',
      name: 'Lexicon',
      config: {
        igt: { fields: { gloss: {}, variantOf: { type: 'item', many: true } } },
      },
      items: [
        { id: 'i1', form: 'perro', metadata: { gloss: 'dog' } },
        { id: 'i2', form: 'perra', metadata: { gloss: 'dog (f)', variantOf: ['i1'] } },
      ],
    };
    const { files } = build({ vocabularies: [dict] });
    const entries = table(files, 'entries.csv');
    expect(entries[1].Entry_variantOf).toBe('perro');
    expect(entries[0].Entry_variantOf).toBe('');
  });

  it("carries a sense's own part of speech and fields, and a headword's only once", () => {
    const dict = {
      id: 'v1',
      name: 'Lexicon',
      config: { igt: { fields: { gloss: {}, pos: {}, register: {} } } },
      items: [
        { id: 'h', form: 'kat', metadata: { gloss: 'cat', pos: 'N', register: 'plain' } },
        {
          id: 's',
          form: 'kat',
          metadata: { gloss: 'lion', pos: 'N.aug', register: 'formal', parent: 'h' },
        },
      ],
    };
    const { files } = build({ vocabularies: [dict] });
    const senses = table(files, 'senses.csv');
    expect(senses.map((x) => [x.Description, x.Part_Of_Speech, x.Sense_register])).toEqual([
      // The headword's own row leaves them to the entry row.
      ['cat', '', ''],
      ['lion', 'N.aug', 'formal'],
    ]);
    expect(table(files, 'entries.csv')[0]).toMatchObject({
      Part_Of_Speech: 'N',
      Entry_register: 'plain',
    });
  });

  it('adds no sense columns to a vocabulary that has no senses', () => {
    const { files } = build({ vocabularies: [vocab] });
    const header = Object.keys(table(files, 'senses.csv')[0]);
    expect(header.filter((h) => h.startsWith('Sense_'))).toEqual([]);
    expect(header).not.toContain('Part_Of_Speech');
  });

  it('skips the dictionary entirely when the option is off', () => {
    const { files } = build({ vocabularies: [vocab], options: { ...OPTIONS, dictionary: false } });
    expect(fileNamed(files, 'entries.csv')).toBeUndefined();
    expect(fileNamed(files, 'senses.csv')).toBeUndefined();
  });
});

describe('buildCldfDataset — metadata descriptor', () => {
  it('declares a TextCorpus with the tables it actually wrote', () => {
    const { files } = build();
    const md = metadata(files);
    expect(md['dc:conformsTo']).toBe('http://cldf.clld.org/v1.0/terms.rdf#TextCorpus');
    expect(md['dc:title']).toBe('Fieldwork');
    expect(md.tables.map((t) => t.url).sort()).toEqual([
      'contributions.csv',
      'examples.csv',
      'languages.csv',
    ]);
  });

  it('binds the standard columns to ontology terms', () => {
    const { files } = build();
    const byName = Object.fromEntries(
      tableSpec(files, 'examples.csv').tableSchema.columns.map((c) => [c.name, c]),
    );
    expect(byName.Primary_Text.propertyUrl).toBe('http://cldf.clld.org/v1.0/terms.rdf#primaryText');
    expect(byName.Analyzed_Word.separator).toBe('\t');
    expect(byName.Position.datatype).toBe('integer');
    expect(byName.ID.required).toBe(true);
    expect(tableSpec(files, 'examples.csv')['dc:conformsTo']).toBe(
      'http://cldf.clld.org/v1.0/terms.rdf#ExampleTable',
    );
  });

  it('declares that no string means null in the aligned list columns', () => {
    // A column's `null` defaults to "", so an empty item in a tab-separated
    // list would parse back as a missing value and break the alignment
    // (pycldf's Example.igt raises on it). An unglossed word is a present,
    // empty slot, not a missing one.
    const { files } = build();
    expect(columnNamed(files, 'examples.csv', 'Gloss').null).toEqual([]);
    expect(columnNamed(files, 'examples.csv', 'Word_POS').null).toEqual([]);
    // Scalar columns keep the default, where empty does mean absent.
    expect(columnNamed(files, 'examples.csv', 'Primary_Text').null).toBeUndefined();
  });

  it('declares foreign keys only for columns it kept', () => {
    const { files } = build();
    const fks = tableSpec(files, 'examples.csv').tableSchema.foreignKeys;
    expect(fks).toContainEqual({
      columnReference: 'Contribution_ID',
      reference: { resource: 'contributions.csv', columnReference: 'ID' },
    });

    const noMeta = build({ languages: { object: LANGUAGES.object, meta: {} } });
    const metaFk = tableSpec(noMeta.files, 'examples.csv').tableSchema.foreignKeys.find(
      (f) => f.columnReference === 'Meta_Language_ID',
    );
    expect(metaFk).toBeUndefined();
  });

  it('every CSV header matches its declared schema', () => {
    const { files } = build({
      vocabularies: [
        {
          id: 'v1',
          name: 'Lexicon',
          config: {},
          items: [{ id: 'i1', form: 'a', metadata: { gloss: 'b' } }],
        },
      ],
      documents: [{ igtDoc: makeFixtureDoc(), mediaFile: 'media/a.wav', mediaType: 'audio/wav' }],
    });
    for (const t of metadata(files).tables) {
      const header = parseCsv(fileNamed(files, t.url).data)[0];
      expect(header).toEqual(t.tableSchema.columns.map((c) => c.name));
    }
  });

  it('writes a MediaTable when documents carry media', () => {
    const { files } = build({
      documents: [{ igtDoc: makeFixtureDoc(), mediaFile: 'media/a.wav', mediaType: 'audio/wav' }],
    });
    expect(table(files, 'media.csv')[0]).toMatchObject({
      Media_Type: 'audio/wav',
      Download_URL: 'media/a.wav',
      Contribution_ID: '1',
    });
  });
});

describe('defaultCldfOptions', () => {
  it('binds gloss, translation and comment by name and keeps the rest as extras', () => {
    const o = defaultCldfOptions(LAYERS);
    expect(o).toMatchObject({
      glossField: 'Gloss',
      glossScope: 'morpheme',
      translationField: 'Translation',
      commentField: 'Note',
      primaryText: BASELINE,
    });
    expect(o.extras).toEqual({
      sentence: [],
      word: ['POS'],
      morpheme: [],
      orthographies: ['Translit'],
    });
  });

  it('falls back to a word-scoped gloss when the project has no morpheme layer', () => {
    const o = defaultCldfOptions({ ...LAYERS, morphFields: [], wordFields: ['Gloss', 'POS'] });
    expect(o).toMatchObject({ glossField: 'Gloss', glossScope: 'word' });
    expect(o.extras.word).toEqual(['POS']);
  });

  it('keeps a word Gloss when a morpheme Gloss of the same name is bound', () => {
    // What the setup wizard actually builds: the same field name at two scopes.
    // A flat name set treated the word Gloss as already bound and dropped it
    // from extras.word too, so 668 values left the export in silence.
    const o = defaultCldfOptions({ ...LAYERS, wordFields: ['Gloss', 'POS'] });
    expect(o).toMatchObject({ glossField: 'Gloss', glossScope: 'morpheme' });
    expect(o.extras.word).toEqual(['Gloss', 'POS']);
    expect(o.extras.morpheme).toEqual([]);
  });

  it('survives a project with no annotation layers at all', () => {
    const o = defaultCldfOptions({});
    expect(o.glossField).toBeNull();
    expect(o.extras.sentence).toEqual([]);
  });
});

describe('cldfLossSummary', () => {
  it('sorts every tier into mapped, custom, or dropped', () => {
    const summary = cldfLossSummary(LAYERS, OPTIONS);
    expect(summary.mapped).toEqual([
      'Gloss → Gloss',
      'Translation → Translated_Text',
      'Note → Comment',
    ]);
    expect(summary.custom).toEqual(['POS (word)', 'Translit (orthography)']);
    expect(summary.dropped).toEqual([]);
  });

  it('can see a word Gloss that shares its name with the bound morpheme Gloss', () => {
    const layers = { ...LAYERS, wordFields: ['Gloss', 'POS'] };
    // Carried: it belongs in `custom`, named with its scope.
    expect(
      cldfLossSummary(layers, { ...OPTIONS, extras: { ...OPTIONS.extras, word: ['Gloss', 'POS'] } })
        .custom,
    ).toContain('Gloss (word)');
    // Not carried: it must show up as dropped rather than vanish from both
    // buckets, which is what made the panel report "Dropped (0)" over a loss.
    expect(
      cldfLossSummary(layers, {
        ...OPTIONS,
        extras: { sentence: [], word: [], morpheme: [], orthographies: [] },
      }).dropped,
    ).toContain('Gloss (word)');
  });

  it('names what the format cannot carry, whatever the preset says', () => {
    // A round trip came back with 1,062 vocabulary links and 1,062 provenance
    // marks gone, and nothing on screen had said they would be. No option can
    // turn these back on, so they are reported separately from the per-field
    // buckets rather than left to be found by diffing an import.
    const summary = cldfLossSummary(LAYERS, OPTIONS);
    expect(summary.inherent.join(' ')).toMatch(/vocabulary links/i);
    expect(summary.inherent.join(' ')).toMatch(/provenance/i);
    expect(summary.inherent.join(' ')).toMatch(/unanalyzed/i);
    // It does not depend on the preset.
    expect(cldfLossSummary(LAYERS, { ...OPTIONS, glossField: null }).inherent).toEqual(
      summary.inherent,
    );
  });

  it('reports a tier that is neither bound nor carried as dropped', () => {
    const summary = cldfLossSummary(LAYERS, {
      ...OPTIONS,
      extras: { sentence: [], word: [], morpheme: [], orthographies: [] },
    });
    expect(summary.custom).toEqual([]);
    expect(summary.dropped).toEqual(['POS (word)', 'Translit (orthography)']);
  });
});
