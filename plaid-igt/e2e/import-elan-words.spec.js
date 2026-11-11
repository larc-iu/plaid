import { test, expect, seedAuth } from './fixtures.js';
import { makeClient, roleOf } from './fixtureProject.js';

// An .eaf whose only tier is the transcription, so the tier screen offers it
// Sentences and nothing divides it into words. Its words are made as the
// Tokenize tab makes them, under the rule of the project they go into: the
// review shows them and core stores them, punctuation left out. Through both
// routes a person takes: a new project, then Add ELAN documents into it after
// its rule is changed. The project is deleted afterwards.

const eaf = (utterances) => {
  const slots = utterances
    .flatMap((_, i) => [
      `<TIME_SLOT TIME_SLOT_ID="ts${2 * i + 1}" TIME_VALUE="${i * 1000}"/>`,
      `<TIME_SLOT TIME_SLOT_ID="ts${2 * i + 2}" TIME_VALUE="${i * 1000 + 900}"/>`,
    ])
    .join('');
  const anns = utterances
    .map(
      (u, i) =>
        `<ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="a${i + 1}" TIME_SLOT_REF1="ts${2 * i + 1}" TIME_SLOT_REF2="ts${2 * i + 2}"><ANNOTATION_VALUE>${u}</ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>`,
    )
    .join('');
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<ANNOTATION_DOCUMENT AUTHOR="t" DATE="2026-01-01T00:00:00Z" VERSION="2.8" FORMAT="2.8">
<HEADER TIME_UNITS="milliseconds"/>
<TIME_ORDER>${slots}</TIME_ORDER>
<TIER TIER_ID="Transcription" LINGUISTIC_TYPE_REF="u" PARTICIPANT="Ana">${anns}</TIER>
<LINGUISTIC_TYPE LINGUISTIC_TYPE_ID="u" TIME_ALIGNABLE="true"/>
</ANNOTATION_DOCUMENT>`);
};

let projectId = null;

test.afterAll(async () => {
  if (projectId) {
    await makeClient()
      .projects.delete(projectId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

// The words core holds for a document, in text order, sliced by code point.
const storedWords = async (client, docId) => {
  const raw = await client.documents.get(docId, true);
  const [textLayer] = raw.textLayers;
  const chars = [...textLayer.text.body];
  const words = textLayer.tokenLayers.find((l) => roleOf(l) === 'word').tokens;
  return words
    .slice()
    .sort((a, b) => a.begin - b.begin)
    .map((t) => chars.slice(t.begin, t.end).join(''));
};

const previewWords = (page) => page.locator('div.font-semibold[dir="auto"]').allTextContents();

test('an .eaf with no word tier gets words without punctuation', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('about:blank');
  await seedAuth(page);
  const client = makeClient();

  // A new project: the rule every new project starts with.
  await page.goto('/#/projects/import-elan');
  await page.locator('input[type="file"]').setInputFiles([
    {
      name: 'story.eaf',
      mimeType: 'text/xml',
      buffer: eaf(["ama, k'a sipa. ¿tuni wari?", '(???) "puri", nina.']),
    },
  ]);
  await expect(page.getByText('Preview')).toBeVisible();
  await expect.poll(() => previewWords(page)).toEqual(['ama', 'k', 'a', 'sipa', 'tuni', 'wari']);
  await expect(page.getByText(/^1 document · 2 sentences · 8 words ·/)).toBeVisible();
  await page.getByLabel('Project name').fill(`elan words ${Date.now()}`);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('main').getByText('Import complete')).toBeVisible({
    timeout: 90_000,
  });
  const href = await page.getByRole('link', { name: 'Open project' }).getAttribute('href');
  projectId = href.split('/').pop();
  const [story] = await client.projects.listDocuments(projectId);
  expect(await storedWords(client, story.id)).toEqual([
    'ama',
    'k',
    'a',
    'sipa',
    'tuni',
    'wari',
    'puri',
    'nina',
  ]);

  // The project now keeps the apostrophe as a letter, and documents added to
  // it are split by that.
  const project = await client.projects.get(projectId);
  const wordLayer = project.textLayers
    .flatMap((t) => t.tokenLayers)
    .find((l) => roleOf(l) === 'word');
  await client.tokenLayers.setConfig(wordLayer.id, 'plaid', 'ignoredTokens', {
    type: 'unicodePunctuation',
    whitelist: ["'"],
    blacklist: [],
  });
  await page.goto(`/#/projects/${projectId}/import-elan`);
  await expect(page.getByRole('heading', { name: 'Add ELAN documents' })).toBeVisible();
  await page
    .locator('input[type="file"]')
    .setInputFiles([
      { name: 'second.eaf', mimeType: 'text/xml', buffer: eaf(["¿k'a ama, kilu?"]) },
    ]);
  await expect(page.getByText('Preview')).toBeVisible();
  await expect.poll(() => previewWords(page)).toEqual(["k'a", 'ama', 'kilu']);
  await expect(page.getByText(/^1 document · 1 sentence · 3 words ·/)).toBeVisible();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('main').getByText('Import complete')).toBeVisible({
    timeout: 90_000,
  });
  const second = (await client.projects.listDocuments(projectId)).find((d) => d.id !== story.id);
  expect(await storedWords(client, second.id)).toEqual(["k'a", 'ama', 'kilu']);
});
