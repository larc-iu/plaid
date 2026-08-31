import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { readCldfDataset } from './readDataset.js';
import {
  buildCldfDocuments,
  deriveImportOptions,
  customColumnChoices,
  splitAnalyzed,
  surfaceOf,
  alignWords,
} from './buildDocuments.js';
import { buildCldfDataset } from '../../export/cldf.js';
import { makeFixtureDoc } from '../../export/testFixtures.js';

const TERMS = 'http://cldf.clld.org/v1.0/terms.rdf#';
const col = (name, term, extra = {}) => ({
  name,
  ...(term ? { propertyUrl: `${TERMS}${term}` } : {}),
  datatype: 'string',
  ...extra,
});
const listCol = (name, term) => col(name, term, { separator: '\t', null: [] });

/** A one-table TextCorpus dataset from a CSV body. */
function dataset(csv, columns, extraTables = [], extraFiles = {}) {
  const files = {
    'cldf-metadata.json': JSON.stringify({
      '@context': ['http://www.w3.org/ns/csvw', { '@language': 'en' }],
      'dc:conformsTo': `${TERMS}TextCorpus`,
      'dc:title': 'Test',
      tables: [
        { url: 'examples.csv', 'dc:conformsTo': `${TERMS}ExampleTable`, tableSchema: { columns } },
        ...extraTables,
      ],
    }),
    'examples.csv': csv,
    ...extraFiles,
  };
  return readCldfDataset(
    zipSync(Object.fromEntries(Object.entries(files).map(([p, d]) => [p, strToU8(d)]))),
  );
}

const BASIC_COLUMNS = [
  col('ID', 'id'),
  col('Language_ID', 'languageReference'),
  col('Primary_Text', 'primaryText'),
  listCol('Analyzed_Word', 'analyzedWord'),
  listCol('Gloss', 'gloss'),
  col('Translated_Text', 'translatedText'),
];

describe('splitAnalyzed / surfaceOf', () => {
  it('splits on both Leipzig joints and remembers which one preceded each piece', () => {
    expect(splitAnalyzed('perro=s')).toEqual([
      { form: 'perro', before: null },
      { form: 's', before: '=' },
    ]);
    expect(splitAnalyzed('un-break-able').map((p) => p.form)).toEqual(['un', 'break', 'able']);
  });

  it('treats an unsegmented word as one piece, and never returns nothing', () => {
    expect(splitAnalyzed('corren')).toEqual([{ form: 'corren', before: null }]);
    expect(splitAnalyzed('')).toEqual([{ form: '', before: null }]);
  });

  it('recovers the surface form by dropping the joints', () => {
    expect(surfaceOf('perro=s')).toBe('perros');
    expect(surfaceOf('un-break-able')).toBe('unbreakable');
  });
});

describe('alignWords', () => {
  const align = (body, forms) => alignWords(body, 0, body.length, forms);

  it('finds each word in order and returns its offsets', () => {
    const { spans, warnings } = align('perros corren.', ['perro=s', 'corren']);
    expect(spans).toEqual([
      { beginU16: 0, endU16: 6 },
      { beginU16: 7, endU16: 13 },
    ]);
    expect(warnings).toEqual([]);
  });

  it('prefers a verbatim match, so a real hyphen in the text wins', () => {
    // "well-known" is one word in the text AND has a morpheme joint.
    const { spans } = align('a well-known fact', ['a', 'well-known', 'fact']);
    expect(spans[1]).toEqual({ beginU16: 2, endU16: 12 });
  });

  it('falls back to the joint-stripped surface when the text is unsegmented', () => {
    const { spans } = align('unbreakable', ['un-break-able']);
    expect(spans[0]).toEqual({ beginU16: 0, endU16: 11 });
  });

  it('matches case-insensitively', () => {
    const { spans } = align('За что', ['за', 'что']);
    expect(spans[0]).toEqual({ beginU16: 0, endU16: 2 });
  });

  it('searches forward past text the analysis skipped', () => {
    const { spans, warnings } = align('¡Hola amigo!', ['Hola', 'amigo']);
    expect(spans[0]).toEqual({ beginU16: 1, endU16: 5 });
    expect(warnings).toEqual([]);
  });

  it('reports a word it cannot find and keeps going', () => {
    const { spans, warnings } = align('perros corren', ['perros', 'ladran', 'corren']);
    expect(spans[1]).toBeNull();
    expect(spans[2]).toEqual({ beginU16: 7, endU16: 13 });
    expect(warnings).toEqual(['could not align "ladran"']);
  });

  it('never matches past the end of its sentence', () => {
    const body = 'uno dos\ntres';
    const { spans, warnings } = alignWords(body, 0, 7, ['uno', 'tres']);
    expect(spans[1]).toBeNull();
    expect(warnings).toHaveLength(1);
  });
});

describe('buildCldfDocuments', () => {
  const csv =
    'ID,Language_ID,Primary_Text,Analyzed_Word,Gloss,Translated_Text\r\n' +
    '1,spa,perros corren.,perro=s\tcorren,dog=PL\t,The dogs run.\r\n' +
    '2,spa,gatos duermen.,gato=s\tduermen,cat=PL\tsleep,The cats sleep.\r\n';

  it('makes one document whose sentences tile the body exactly', () => {
    const { documents } = buildCldfDocuments(dataset(csv, BASIC_COLUMNS));
    expect(documents).toHaveLength(1);
    const doc = documents[0];
    expect(doc.body).toBe('perros corren.\ngatos duermen.');
    expect(doc.sentences.map((s) => [s.begin, s.end])).toEqual([
      [0, 15],
      [15, 29],
    ]);
  });

  it('builds words with morphemes split on the joints', () => {
    const { documents } = buildCldfDocuments(dataset(csv, BASIC_COLUMNS));
    const [perros, corren] = documents[0].words;
    expect([perros.begin, perros.end]).toEqual([0, 6]);
    expect(perros.morphemes.map((m) => m.form)).toEqual(['perro', 's']);
    expect(perros.morphemes.map((m) => m.fields.Gloss)).toEqual(['dog', 'PL']);
    expect(corren.morphemes).toHaveLength(1);
    expect(corren.morphemes[0].form).toBe('corren');
  });

  it('infers a clitic type from "=" and nothing at all from "-"', () => {
    const { documents } = buildCldfDocuments(
      dataset(
        'ID,Primary_Text,Analyzed_Word,Gloss\r\n1,perros unbreakable,perro=s\tun-break-able,dog=PL\tNEG-break-ABIL\r\n',
        BASIC_COLUMNS,
      ),
    );
    const [clitic, affixed] = documents[0].words;
    expect(clitic.morphemes.map((m) => m.morphType)).toEqual([null, 'enclitic']);
    // "-" says a boundary exists but not what is on either side.
    expect(affixed.morphemes.map((m) => m.morphType)).toEqual([null, null, null]);
  });

  it('puts the translation on the sentence', () => {
    const { documents } = buildCldfDocuments(dataset(csv, BASIC_COLUMNS));
    expect(documents[0].sentences[0].fields).toEqual({ Translation: 'The dogs run.' });
  });

  it('keeps a gloss that does not segment like its word, and warns', () => {
    const { documents } = buildCldfDocuments(
      dataset('ID,Primary_Text,Analyzed_Word,Gloss\r\n1,perros,perro=s,dogs\r\n', BASIC_COLUMNS),
      { glossScope: 'Morpheme' },
    );
    const [word] = documents[0].words;
    expect(word.fields.Gloss).toBe('dogs');
    expect(word.morphemes.every((m) => !m.fields.Gloss)).toBe(true);
    expect(documents[0].warnings.join(' ')).toMatch(/does not segment/);
  });

  it('synthesizes a baseline when there is no Primary_Text, and says so', () => {
    const { documents, warnings } = buildCldfDocuments(
      dataset(
        'ID,Primary_Text,Analyzed_Word,Gloss\r\n1,,perro=s\tcorren,dog=PL\t\r\n',
        BASIC_COLUMNS,
      ),
    );
    expect(documents[0].body).toBe('perros corren');
    expect(warnings.join(' ')).toMatch(/no Primary_Text/);
  });

  it('skips an example with neither text nor words', () => {
    const { documents } = buildCldfDocuments(
      dataset('ID,Primary_Text,Analyzed_Word,Gloss\r\n1,,,\r\n2,hola,hola,hi\r\n', BASIC_COLUMNS),
    );
    expect(documents[0].sentences).toHaveLength(1);
    expect(documents[0].warnings.join(' ')).toMatch(/no text/);
  });
});

describe('buildCldfDocuments — grouping and ordering', () => {
  const contribTable = {
    url: 'contributions.csv',
    'dc:conformsTo': `${TERMS}ContributionTable`,
    tableSchema: {
      columns: [col('ID', 'id'), col('Name', 'name'), col('Description', 'description')],
    },
  };
  const columns = [
    ...BASIC_COLUMNS,
    col('Contribution_ID', 'contributionReference'),
    col('Position', 'position'),
  ];

  it('splits into one document per contribution, named and ordered by the table', () => {
    const ds = dataset(
      'ID,Primary_Text,Analyzed_Word,Gloss,Contribution_ID,Position\r\n' +
        'b2,second,second,two,B,2\r\n' +
        'a1,first,first,one,A,1\r\n' +
        'b1,zeroth,zeroth,zero,B,1\r\n',
      columns,
      [contribTable],
      { 'contributions.csv': 'ID,Name,Description\r\nA,Alpha,A story\r\nB,Beta,\r\n' },
    );
    const { documents } = buildCldfDocuments(ds);
    expect(documents.map((d) => d.name)).toEqual(['Beta', 'Alpha']);
    // Position, not file order, decides the sequence within a text.
    expect(documents[0].body).toBe('zeroth\nsecond');
    expect(documents[1].metadata).toEqual({ Description: 'A story' });
  });

  it('falls back to file order when Position is absent', () => {
    const ds = dataset(
      'ID,Primary_Text,Analyzed_Word,Gloss\r\nb,beta,beta,b\r\na,alpha,alpha,a\r\n',
      BASIC_COLUMNS,
    );
    expect(buildCldfDocuments(ds).documents[0].body).toBe('beta\nalpha');
  });
});

describe('buildCldfDocuments — languages and lexicon', () => {
  const langTable = {
    url: 'languages.csv',
    'dc:conformsTo': `${TERMS}LanguageTable`,
    tableSchema: {
      columns: [
        col('ID', 'id'),
        col('Name', 'name'),
        col('Glottocode', 'glottocode'),
        col('ISO639P3code', 'iso639P3code'),
      ],
    },
  };

  it('adopts the dataset language as the project object language', () => {
    const ds = dataset(
      'ID,Language_ID,Primary_Text,Analyzed_Word,Gloss,Translated_Text\r\n1,spa,hola,hola,hi,hello\r\n',
      BASIC_COLUMNS,
      [langTable],
      { 'languages.csv': 'ID,Name,Glottocode,ISO639P3code\r\nspa,Spanish,stan1288,spa\r\n' },
    );
    const { languages } = buildCldfDocuments(ds);
    expect(languages.object).toMatchObject({ name: 'Spanish', glottocode: 'stan1288' });
  });

  it('sets no language when the dataset covers several, and warns', () => {
    const ds = dataset(
      'ID,Language_ID,Primary_Text,Analyzed_Word,Gloss\r\n1,spa,hola,hola,hi\r\n2,eng,hi,hi,hi\r\n',
      BASIC_COLUMNS,
      [langTable],
      { 'languages.csv': 'ID,Name,Glottocode,ISO639P3code\r\nspa,Spanish,,\r\neng,English,,\r\n' },
    );
    const { languages, warnings } = buildCldfDocuments(ds);
    expect(languages.object).toBeNull();
    expect(warnings.join(' ')).toMatch(/2 object languages/);
  });

  it('turns entries and senses into lexicon items, folding extra senses into a definition', () => {
    const ds = dataset(
      'ID,Primary_Text,Analyzed_Word,Gloss\r\n1,hola,hola,hi\r\n',
      BASIC_COLUMNS,
      [
        {
          url: 'entries.csv',
          'dc:conformsTo': `${TERMS}EntryTable`,
          tableSchema: {
            columns: [
              col('ID', 'id'),
              col('Headword', 'headword'),
              col('Part_Of_Speech', 'partOfSpeech'),
            ],
          },
        },
        {
          url: 'senses.csv',
          'dc:conformsTo': `${TERMS}SenseTable`,
          tableSchema: {
            columns: [
              col('ID', 'id'),
              col('Entry_ID', 'entryReference'),
              col('Description', 'description'),
            ],
          },
        },
      ],
      {
        'entries.csv': 'ID,Headword,Part_Of_Speech\r\ne1,perro,N\r\n',
        'senses.csv': 'ID,Entry_ID,Description\r\ns1,e1,dog\r\ns2,e1,hound\r\n',
      },
    );
    const { lexicon } = buildCldfDocuments(ds);
    expect(lexicon).toEqual([
      { id: 'e1', form: 'perro', metadata: { pos: 'N', gloss: 'dog', definition: 'hound' } },
    ]);
  });
});

describe('deriveImportOptions', () => {
  it('reads morpheme scope off the data when forms and glosses segment alike', () => {
    const ds = dataset(
      'ID,Primary_Text,Analyzed_Word,Gloss\r\n1,perros,perro=s,dog=PL\r\n',
      BASIC_COLUMNS,
    );
    expect(deriveImportOptions(ds).glossScope).toBe('Morpheme');
  });

  it('stays at word scope for an unsegmented dataset', () => {
    const ds = dataset(
      'ID,Primary_Text,Analyzed_Word,Gloss\r\n1,dogs run,dogs\trun,dog\trun\r\n',
      BASIC_COLUMNS,
    );
    expect(deriveImportOptions(ds).glossScope).toBe('Word');
  });

  it('believes LGR_Conformance when the dataset states it', () => {
    const ds = dataset(
      'ID,Primary_Text,Analyzed_Word,Gloss,LGR_Conformance\r\n1,ab,ab,x,MORPHEME_ALIGNED\r\n',
      [...BASIC_COLUMNS, col('LGR_Conformance', 'lgrConformance')],
    );
    expect(deriveImportOptions(ds).glossScope).toBe('Morpheme');
  });

  it('recognizes our own exporter’s prefixes and leaves foreign columns off', () => {
    const ds = dataset(
      'ID,Primary_Text,Analyzed_Word,Gloss,Word_POS,Sentence_Note,Orthography_IPA,Whatever,Plaid_ID\r\n' +
        '1,ab,ab,x,N,note,ipa,junk,xyz\r\n',
      [
        ...BASIC_COLUMNS,
        listCol('Word_POS', null),
        col('Sentence_Note', null),
        listCol('Orthography_IPA', null),
        col('Whatever', null),
        col('Plaid_ID', null),
      ],
    );
    const { customColumns } = deriveImportOptions(ds);
    expect(customColumns.Word_POS).toEqual({ scope: 'Word', name: 'POS' });
    expect(customColumns.Sentence_Note).toEqual({ scope: 'Sentence', name: 'Note' });
    expect(customColumns.Orthography_IPA).toEqual({ scope: 'Orthography', name: 'IPA' });
    expect(customColumns.Whatever).toMatchObject({ enabled: false });
    // Bookkeeping columns are never offered.
    expect(customColumns.Plaid_ID).toBeUndefined();
    expect(customColumnChoices(ds).find((c) => c.name === 'Word_POS').canBePerWord).toBe(true);
    expect(customColumnChoices(ds).find((c) => c.name === 'Whatever').canBePerWord).toBe(false);
  });
});

describe('round trip through the exporter', () => {
  // The strongest check available: export a real IgtDocument, read the bytes
  // back through the importer, and compare what came out with what went in.
  const exported = () =>
    buildCldfDataset({
      project: { name: 'Fieldwork' },
      languages: {
        object: { name: 'Spanish', glottocode: 'stan1288', iso639P3: 'spa' },
        meta: { name: 'English', glottocode: 'stan1293', iso639P3: 'eng' },
      },
      documents: [{ igtDoc: makeFixtureDoc() }],
      vocabularies: [
        {
          id: 'v1',
          name: 'Lexicon',
          config: { igt: { fields: { gloss: {}, pos: {} } } },
          items: [{ id: 'i1', form: 'perro', metadata: { gloss: 'dog', pos: 'N' } }],
        },
      ],
      options: {
        glossField: 'Gloss',
        glossScope: 'morpheme',
        translationField: 'Translation',
        commentField: 'Note',
        extras: { sentence: [], word: ['POS'], morpheme: [], orthographies: ['Translit'] },
        speakers: false,
        dictionary: true,
      },
    });

  const reimport = () => {
    const { files } = exported();
    const zipped = zipSync(Object.fromEntries(files.map((f) => [f.path, strToU8(f.data)])));
    return buildCldfDocuments(readCldfDataset(zipped));
  };

  it('recovers the baseline, the words and their offsets', () => {
    const { documents } = reimport();
    expect(documents).toHaveLength(1);
    expect(documents[0].name).toBe('Test & Doc');
    expect(documents[0].body).toBe('perros corren.');
    expect(documents[0].words.map((w) => [w.begin, w.end])).toEqual([
      [0, 6],
      [7, 13],
    ]);
  });

  it('recovers the morpheme segmentation, glosses and clitic type', () => {
    const { documents } = reimport();
    const [perros] = documents[0].words;
    expect(perros.morphemes.map((m) => m.form)).toEqual(['perro', 's']);
    expect(perros.morphemes.map((m) => m.fields.Gloss)).toEqual(['dog', 'PL']);
    expect(perros.morphemes.map((m) => m.morphType)).toEqual([null, 'enclitic']);
  });

  it('recovers the sentence translation, the word field and the orthography', () => {
    const { documents } = reimport();
    expect(documents[0].sentences[0].fields.Translation).toBe('The dogs run.');
    expect(documents[0].words[0].fields.POS).toBe('NOUN');
    expect(documents[0].words[0].fields['orthog:Translit']).toBe('perros-translit');
  });

  it('recovers the language identity, the lexicon and the document metadata', () => {
    const { languages, lexicon, documents } = reimport();
    expect(languages.object).toMatchObject({ name: 'Spanish', glottocode: 'stan1288' });
    expect(languages.meta).toMatchObject({ name: 'English' });
    expect(lexicon[0]).toMatchObject({ form: 'perro', metadata: { gloss: 'dog', pos: 'N' } });
    expect(documents[0].metadata).toMatchObject({ Source: 'Field notes', Genre: 'narrative' });
  });

  it('derives a schema matching the fields the export actually carried', () => {
    const { schema } = reimport();
    expect(schema.fields).toEqual(
      expect.arrayContaining([
        { name: 'Translation', scope: 'Sentence' },
        { name: 'Gloss', scope: 'Morpheme' },
        { name: 'POS', scope: 'Word' },
      ]),
    );
    expect(schema.orthographies).toEqual(['Translit']);
    expect(schema.documentMetadata.map((m) => m.name).sort()).toEqual(['Genre', 'Source']);
  });
});
