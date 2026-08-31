import { zipSync, strToU8 } from 'fflate';
import { test, expect, seedAuth } from './fixtures.js';

// The CLDF import review screen. Everything under src/import/cldf/ is covered
// by unit tests; this covers the surface the user actually touches, where the
// interesting behaviour is that changing an option re-derives the whole build,
// so the counts, the warnings and the button state all move together.
//
// Fixtures are generated here rather than downloaded, so the spec is
// self-contained and deterministic. Nothing is imported: the run stops at
// review.

const T = 'http://cldf.clld.org/v1.0/terms.rdf#';
const col = (name, term, extra = {}) => ({
  name,
  ...(term ? { propertyUrl: T + term } : {}),
  datatype: 'string',
  ...extra,
});
const listCol = (name, term) => col(name, term, { separator: '\t', null: [] });
const table = (url, component, columns) => ({
  url,
  'dc:conformsTo': T + component,
  tableSchema: { columns },
});

/** A CLDF dataset as a zip buffer, ready for setInputFiles. */
function cldfZip({ title = 'Test dataset', module = 'TextCorpus', tables, files }) {
  const entries = {
    'cldf-metadata.json': strToU8(
      JSON.stringify({
        '@context': ['http://www.w3.org/ns/csvw'],
        'dc:conformsTo': T + module,
        'dc:title': title,
        tables,
      }),
    ),
  };
  for (const [path, content] of Object.entries(files)) {
    entries[path] = typeof content === 'string' ? strToU8(content) : content;
  }
  return Buffer.from(zipSync(entries));
}

const upload = async (page, buffer, name = 'dataset.zip') => {
  await page.goto('about:blank');
  await seedAuth(page);
  await page.goto('/#/projects/import-cldf');
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType: 'application/zip', buffer });
  await page.getByLabel('Project name').waitFor({ state: 'visible' });
};

/** The card whose heading is `heading`, for scoping a Radix select. */
const card = (page, heading) =>
  page.locator('div.rounded-lg', { has: page.getByText(heading, { exact: true }) }).last();

/** Pick an option from the Radix select inside that card (options portal out). */
async function choose(page, heading, optionName) {
  await card(page, heading).getByRole('combobox').click();
  await page.getByRole('option', { name: optionName, exact: true }).click();
}

// ---- fixtures ---------------------------------------------------------------

const EXAMPLE_COLUMNS = [
  col('ID', 'id'),
  col('Language_ID', 'languageReference'),
  col('Primary_Text', 'primaryText'),
  listCol('Analyzed_Word', 'analyzedWord'),
  listCol('Gloss', 'gloss'),
  col('Translated_Text', 'translatedText'),
  col('Contribution_ID', 'contributionReference'),
  col('Position', 'position'),
];

/** Two texts, three sentences, morpheme-segmented, with a Word_POS tier. */
const corpus = ({ ours = true } = {}) => {
  const extra = ours
    ? [listCol('Word_POS', null), col('Plaid_ID', null)]
    : [listCol('Word_POS', null)];
  const head =
    'ID,Language_ID,Primary_Text,Analyzed_Word,Gloss,Translated_Text,Contribution_ID,Position,Word_POS' +
    (ours ? ',Plaid_ID' : '');
  const row = (id, text, words, glosses, tr, c, pos, plaid) =>
    `${id},spa,${text},${words},${glosses},${tr},${c},1,${pos}` + (ours ? `,${plaid}` : '');
  return cldfZip({
    title: 'Spanish sample',
    tables: [
      table('examples.csv', 'ExampleTable', [...EXAMPLE_COLUMNS, ...extra]),
      table('contributions.csv', 'ContributionTable', [col('ID', 'id'), col('Name', 'name')]),
      table('languages.csv', 'LanguageTable', [
        col('ID', 'id'),
        col('Name', 'name'),
        col('Glottocode', 'glottocode'),
      ]),
    ],
    files: {
      'examples.csv':
        `${head}\r\n` +
        [
          row(
            '1',
            'perros corren',
            'perro=s\tcorren',
            'dog=PL\trun',
            'The dogs run',
            't1',
            'NOUN\tVERB',
            'x1',
          ),
          row(
            '2',
            'gatos duermen',
            'gato=s\tduermen',
            'cat=PL\tsleep',
            'The cats sleep',
            't1',
            'NOUN\tVERB',
            'x2',
          ),
          row(
            '3',
            'hola amigo',
            'hola\tamigo',
            'hello\tfriend',
            'Hello friend',
            't2',
            'INTJ\tNOUN',
            'x3',
          ),
        ].join('\r\n') +
        '\r\n',
      'contributions.csv': 'ID,Name\r\nt1,Alpha\r\nt2,Beta\r\n',
      'languages.csv': 'ID,Name,Glottocode\r\nspa,Spanish,stan1288\r\n',
    },
  });
};

/** Two examples, each with its own audio file in the archive. */
const withMedia = () =>
  cldfZip({
    title: 'Recordings',
    tables: [
      table('examples.csv', 'ExampleTable', [
        col('ID', 'id'),
        col('Primary_Text', 'primaryText'),
        listCol('Analyzed_Word', 'analyzedWord'),
        listCol('Gloss', 'gloss'),
        col('Audio', 'mediaReference'),
      ]),
      table('media.csv', 'MediaTable', [
        col('ID', 'id'),
        col('Media_Type', 'mediaType'),
        col('Download_URL', 'downloadUrl'),
      ]),
    ],
    files: {
      'examples.csv':
        'ID,Primary_Text,Analyzed_Word,Gloss,Audio\r\n' +
        'ex1,hola amigo,hola\tamigo,hello\tfriend,m1\r\n' +
        'ex2,adios amigo,adios\tamigo,bye\tfriend,m2\r\n',
      'media.csv':
        'ID,Media_Type,Download_URL\r\n' +
        'm1,audio/mpeg,audio/a.mp3\r\nm2,audio/mpeg,audio/b.mp3\r\n',
      'audio/a.mp3': 'ID3fake-a',
      'audio/b.mp3': 'ID3fake-b',
    },
  });

/** Entries and senses, no ExampleTable: the not-yet-implemented case. */
const dictionaryOnly = () =>
  cldfZip({
    title: 'A dictionary',
    module: 'Dictionary',
    tables: [
      table('entries.csv', 'EntryTable', [col('ID', 'id'), col('Headword', 'headword')]),
      table('senses.csv', 'SenseTable', [
        col('ID', 'id'),
        col('Entry_ID', 'entryReference'),
        col('Description', 'description'),
      ]),
    ],
    files: {
      'entries.csv': 'ID,Headword\r\ne1,perro\r\ne2,gato\r\n',
      'senses.csv': 'ID,Entry_ID,Description\r\ns1,e1,dog\r\ns2,e2,cat\r\n',
    },
  });

// ---- tests ------------------------------------------------------------------

test('review: reads the dataset and reports what it found', async ({ page }) => {
  await upload(page, corpus());
  await expect(page.getByLabel('Project name')).toHaveValue('Spanish sample');
  await expect(page.getByText('2 texts', { exact: true })).toBeVisible();
  await expect(page.getByText('3 sentences', { exact: true })).toBeVisible();
  await expect(page.getByText('6 words', { exact: true })).toBeVisible();
  await expect(page.getByText('8 morphemes', { exact: true })).toBeVisible();
  // Translation (Sentence), Gloss (Morpheme), POS (Word).
  await expect(page.getByText('3 annotation fields', { exact: true })).toBeVisible();
  await expect(page.getByText(/Object language:\s*Spanish/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create project & import' })).toBeEnabled();
});

test('review: the gloss scope moves the Gloss field between scopes', async ({ page }) => {
  await upload(page, corpus());
  // Segmentation is independent of where the gloss lands: "perro=s" is two
  // morphemes either way, and only the Gloss field's scope moves.
  await expect(page.getByText('8 morphemes', { exact: true })).toBeVisible();
  await expect(page.getByText(/Gloss \(Morpheme\)/)).toBeVisible();

  await choose(page, 'How the gloss is read', 'Word (whole)');
  await expect(page.getByText(/Gloss \(Word\)/)).toBeVisible();
  await expect(page.getByText('8 morphemes', { exact: true })).toBeVisible();

  await choose(page, 'How the gloss is read', 'Morpheme (segmented)');
  await expect(page.getByText(/Gloss \(Morpheme\)/)).toBeVisible();
});

test('review: our own export’s prefixes are read back, a stranger’s are not', async ({ page }) => {
  // With Plaid_ID present the dataset is ours, so Word_POS is a word-scoped
  // "POS" and is on by default.
  await upload(page, corpus({ ours: true }));
  const ours = card(page, 'Columns CLDF has no term for');
  await expect(ours.getByRole('combobox')).toHaveText('Word');
  await expect(ours.locator('input')).toHaveValue('POS');

  // Without it the column is a stranger's: kept whole and left off.
  await upload(page, corpus({ ours: false }), 'foreign.zip');
  const foreign = card(page, 'Columns CLDF has no term for');
  await expect(foreign.getByRole('combobox')).toHaveText('Don’t import');
  await expect(foreign.locator('input')).toHaveValue('Word_POS');
  // 2 fields now, not 3: the POS tier is not being imported.
  await expect(page.getByText('2 annotation fields', { exact: true })).toBeVisible();
});

test('review: per-example grouping is the default when examples carry media', async ({ page }) => {
  await upload(page, withMedia());
  const grouping = card(page, 'How the examples split into texts');
  await expect(grouping.getByRole('combobox')).toHaveText('One document per example');
  await expect(page.getByText('2 texts', { exact: true })).toBeVisible();
  await expect(page.getByText(/their own media file/)).toHaveCount(0);

  // Any other grouping collapses them into one text and loses the audio, which
  // the screen has to say before the user commits to it.
  await choose(page, 'How the examples split into texts', 'One text for everything');
  await expect(page.getByText('1 texts', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('listitem').filter({ hasText: /2 examples have their own media file/ }),
  ).toBeVisible();

  await choose(page, 'How the examples split into texts', 'One document per example');
  await expect(page.getByText('2 texts', { exact: true })).toBeVisible();
  await expect(page.getByText(/their own media file/)).toHaveCount(0);
});

test('review: a dictionary on its own says so instead of offering a dead button', async ({
  page,
}) => {
  await upload(page, dictionaryOnly());
  await expect(
    page.getByText('Importing a dictionary on its own is not yet implemented'),
  ).toBeVisible();
  await expect(page.getByText(/2 entries but no ExampleTable/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create project & import' })).toBeDisabled();
});

test('review: an archive with no CLDF in it is refused at the door', async ({ page }) => {
  await page.goto('about:blank');
  await seedAuth(page);
  await page.goto('/#/projects/import-cldf');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'nope.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(zipSync({ 'readme.txt': strToU8('hello') })),
  });
  await expect(page.getByText(/No CLDF dataset found in this archive/)).toBeVisible();
  // Still on the drop zone, ready for another try.
  await expect(page.getByText(/Drop a CLDF \.zip here/)).toBeVisible();
});
