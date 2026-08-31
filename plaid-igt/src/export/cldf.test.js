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

  it('omits the sense rather than writing an empty required Description', () => {
    const { files, warnings } = build({ vocabularies: [vocab] });
    expect(table(files, 'senses.csv').map((s) => s.Entry_ID)).toEqual(['e1', 'e2']);
    expect(warnings.join(' ')).toMatch(/no gloss or definition/);
  });

  it('carries non-core lexicon fields as custom entry columns', () => {
    const { files } = build({ vocabularies: [vocab] });
    expect(table(files, 'entries.csv')[1].Entry_morphType).toBe('stem');
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

  it('reports a tier that is neither bound nor carried as dropped', () => {
    const summary = cldfLossSummary(LAYERS, {
      ...OPTIONS,
      extras: { sentence: [], word: [], morpheme: [], orthographies: [] },
    });
    expect(summary.custom).toEqual([]);
    expect(summary.dropped).toEqual(['POS (word)', 'Translit (orthography)']);
  });
});
