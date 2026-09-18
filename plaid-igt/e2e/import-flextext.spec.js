import { test, expect, seedAuth, collectClientErrors } from './fixtures.js';
import { makeClient } from './fixtureProject.js';

// A project made from .flextext files, through the page a person uses: the
// New Project card, two files at once, the review screen, the run, and the
// documents in the editor. The reader is covered by unit tests
// (src/import/flex/flextextParser.test.js); this is the part only a live core
// can check, that what it builds is accepted and reads back. The files are
// written here, and the project is deleted afterwards.

const flextext = (texts) =>
  Buffer.from(`<?xml version="1.0" encoding="utf-8"?>\n<document version="2">${texts}</document>`);

const text = (guid, title, phrases) => `
  <interlinear-text guid="${guid}">
    <item type="title" lang="en">${title}</item>
    <item type="source" lang="en">Abir</item>
    <paragraphs><paragraph><phrases>${phrases}</phrases></paragraph></paragraphs>
    <languages>
      <language lang="qaa" vernacular="true" />
      <language lang="en" />
    </languages>
  </interlinear-text>`;

const word = (txt, gloss, morphs = '') => `
  <word>
    <item type="txt" lang="qaa">${txt}</item>
    ${morphs ? `<morphemes>${morphs}</morphemes>` : ''}
    <item type="gls" lang="en">${gloss}</item>
  </word>`;

const morph = (type, txt, gloss) => `
  <morph type="${type}">
    <item type="txt" lang="qaa">${txt}</item>
    <item type="cf" lang="qaa">${txt}</item>
    <item type="gls" lang="en">${gloss}</item>
  </morph>`;

const punct = (p) => `<word><item type="punct" lang="qaa">${p}</item></word>`;

const phrase = (words, translation) => `
  <phrase>
    <words>${words}</words>
    <item type="gls" lang="en">${translation}</item>
  </phrase>`;

const DOGS = flextext(
  text(
    '11111111-0000-0000-0000-000000000001',
    'Dogs',
    phrase(
      word('Kicer', 'dogs', morph('stem', 'kic', 'dog') + morph('suffix', '-er', 'PL')) +
        word('hawa', 'bark') +
        punct('.'),
      'Dogs bark.',
    ) + phrase(word('Pud', 'three') + punct(','), 'Three,'),
  ),
);
const CATS = flextext(
  text('11111111-0000-0000-0000-000000000002', 'Cats', phrase(word('Kac', 'cat'), 'A cat')),
);

let projectId = null;

test.afterAll(async () => {
  if (projectId) {
    await makeClient()
      .projects.delete(projectId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

test('a project from two .flextext files', async ({ page }) => {
  test.setTimeout(120_000);
  const diag = collectClientErrors(page);
  await page.goto('about:blank');
  await seedAuth(page);

  await page.goto('/#/projects/new');
  await page.getByRole('link', { name: /Import from FLEx \(\.flextext\)/ }).click();
  await expect(page).toHaveURL(/#\/projects\/import-flextext$/);
  await expect(page.getByRole('heading', { name: 'Import from FLEx (.flextext)' })).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles([
    { name: 'dogs.flextext', mimeType: 'text/xml', buffer: DOGS },
    { name: 'cats.flextext', mimeType: 'text/xml', buffer: CATS },
  ]);
  await expect(page.getByText('Contents of 2 files')).toBeVisible();
  await expect(page.getByText('Not imported: Lex. Entries (2).')).toBeVisible();
  // No lexicon to choose, and no name to take from two files.
  await expect(page.getByText('Create a new lexicon')).toHaveCount(0);
  const name = page.getByLabel('Project name');
  await expect(name).toHaveValue('');
  const run = page.getByRole('button', { name: 'Import 2 texts' });
  await expect(run).toBeDisabled();
  await name.fill(`flextext import ${Date.now()}`);
  await run.click();

  await expect(page.getByRole('main').getByText('Import complete')).toBeVisible({
    timeout: 90_000,
  });
  const href = await page.getByRole('link', { name: 'Open project' }).getAttribute('href');
  projectId = href.split('/').pop();

  // What the server holds: the text rebuilt with FLEx's spacing, a word per
  // word, the morphemes without their markers, and no vocabulary.
  const client = makeClient();
  const project = await client.projects.get(projectId);
  expect(project.vocabs ?? []).toEqual([]);
  const docs = await client.projects.listDocuments(projectId);
  const dogs = docs.find((d) => d.name === 'Dogs');
  expect(docs.map((d) => d.name).sort()).toEqual(['Cats', 'Dogs']);
  const raw = await client.documents.get(dogs.id, true);
  const [textLayer] = raw.textLayers;
  expect(textLayer.text.body).toBe('Kicer hawa. Pud,');
  const layer = (role) => textLayer.tokenLayers.find((t) => t.config?.plaid?.role === role);
  const slice = (t) => textLayer.text.body.slice(t.begin, t.end);
  expect(layer('word').tokens.map(slice)).toEqual(['Kicer', 'hawa', 'Pud']);
  expect(layer('sentence').tokens.map(slice)).toEqual(['Kicer hawa. ', 'Pud,']);
  expect(
    layer('morpheme')
      .tokens.slice()
      .sort((a, b) => a.precedence - b.precedence)
      .map((m) => [m.metadata.form, m.metadata.morphType]),
  ).toEqual([
    ['kic', 'stem'],
    ['er', 'suffix'],
  ]);
  expect(raw.metadata).toMatchObject({ Source: 'Abir' });

  // And the editor shows it.
  await page.goto(`/#/projects/${projectId}/documents/${dogs.id}`);
  await page.waitForLoadState('networkidle');
  await page.getByRole('tab', { name: 'Analyze' }).click();
  const island = page.locator('.igt-island');
  await island.locator('.igt-token-col').first().waitFor({ state: 'visible' });
  await expect(island.getByRole('textbox', { name: 'Gloss for Kicer' })).toHaveValue('dogs');
  await expect(island.getByRole('textbox', { name: 'Morpheme form er' })).toHaveValue('er');
  await expect(island.getByRole('textbox', { name: 'Gloss for morpheme er' })).toHaveValue('PL');
  await expect(island.getByRole('textbox', { name: 'Translation for sentence 1' })).toHaveValue(
    'Dogs bark.',
  );
  // A user who has never rebound a key has no keymap entry, and reading it 404s.
  const failures = diag.failures.filter((f) => !f.url.includes('/data/igt%3Akeymap'));
  expect.soft(failures, 'no API failures').toEqual([]);
});
