// Item 3: the notes a treebank keeps about a document and about a sentence.
//
// CoNLL-U carries both as `# k = v` lines, and ConlluDocument has always
// round-tripped the sentence half onto the sentence token. What was missing was
// any way to see or edit either, so the last assertion here is the one that
// matters: what you type comes back out of the exporter.
import { test, expect, seedAuth } from './fixtures.js';
import { seedUdDoc } from './seedUdDoc.js';

const BODY = 'the dog runs';
const WORDS = [
  [0, 3],
  [4, 7],
  [8, 12],
];

const S = {};

test.beforeAll(async () => {
  Object.assign(S, await seedUdDoc(`Metadata ${Date.now()}`, BODY, WORDS));
  for (const [i, lemma] of ['the', 'dog', 'run'].entries()) {
    await S.client.spans.create(S.layers.lemma, [S.morphIds[i]], lemma);
  }
  await S.client.projects.setConfig(S.projectId, 'ud', 'documentMetadata', [
    { name: 'source' },
    { name: 'genre' },
  ]);
  await S.client.projects.setConfig(S.projectId, 'ud', 'sentenceMetadata', [{ name: 'text_en' }]);
});

test.afterAll(async () => {
  if (S.client && S.projectId) {
    await S.client.projects
      .delete(S.projectId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

test.beforeEach(async () => {
  // Each test writes metadata, so start from nothing.
  await S.client.documents.setMetadata(S.documentId, {});
  const doc = await S.client.documents.get(S.documentId, true);
  const sentenceLayer = doc.textLayers[0].tokenLayers.find((l) => l.name === 'Sentences');
  S.sentenceTokenId = sentenceLayer.tokens[0].id;
  await S.client.tokens.setMetadata(S.sentenceTokenId, {});
});

const open = async (page, tab) => {
  await seedAuth(page);
  // SEED, don't overwrite. addInitScript runs on every navigation, so writing
  // this unconditionally would stamp the row visibility back over whatever the
  // app had saved and make "it remembers across a reload" untestable.
  await page.addInitScript(() => {
    if (!localStorage.getItem('ud-annotation-visible-fields')) {
      localStorage.setItem(
        'ud-annotation-visible-fields',
        JSON.stringify({ lemma: true, xpos: true, upos: true, feats: true, meta: true }),
      );
    }
  });
  await page.goto(`/#/projects/${S.projectId}/documents/${S.documentId}/${tab}`);
};

test('the Details tab offers the fields the project declares, and saves one on Enter', async ({
  page,
}) => {
  await open(page, 'details');
  const source = page.locator('#metadata-source');
  await expect(source).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#metadata-genre')).toBeVisible();

  await source.click();
  await source.fill('UD_English-EWT');
  await source.press('Enter');

  await expect
    .poll(async () => (await S.client.documents.get(S.documentId)).metadata?.source, {
      timeout: 8000,
    })
    .toBe('UD_English-EWT');
});

test('clearing a field deletes the key rather than storing a blank', async ({ page }) => {
  await S.client.documents.patchMetadata(S.documentId, { genre: 'narrative' });
  await open(page, 'details');
  const genre = page.locator('#metadata-genre');
  await expect(genre).toHaveValue('narrative', { timeout: 15000 });

  await genre.click();
  await genre.fill('');
  await genre.press('Enter');

  // Gone, not empty: an empty value would export as a bare `# genre =` line.
  await expect
    .poll(async () => 'genre' in ((await S.client.documents.get(S.documentId)).metadata || {}), {
      timeout: 8000,
    })
    .toBe(false);
});

test('a stored field the project no longer declares is still shown, and can be cleared', async ({
  page,
}) => {
  await S.client.documents.patchMetadata(S.documentId, { leftover: 'from an import' });
  await open(page, 'details');

  // Hiding it would leave a value that exports but cannot be reached.
  const leftover = page.locator('#metadata-leftover');
  await expect(leftover).toHaveValue('from an import', { timeout: 15000 });
  await expect(
    page.getByText("leftover is not one of this project's fields", { exact: false }),
  ).toBeVisible();

  await leftover.click();
  await leftover.fill('');
  await leftover.press('Enter');
  // Nothing declares it and nothing stores it, so the row goes too.
  await expect(leftover).toHaveCount(0, { timeout: 8000 });
});

test('a sentence carries sent_id and the declared fields, and they reach the export', async ({
  page,
}) => {
  await open(page, 'annotate');
  await expect(page.locator('.token-form', { hasText: 'dog' }).first()).toBeVisible({
    timeout: 15000,
  });

  const strip = page.locator('.sentence-meta');
  await expect(strip).toBeVisible();
  await expect(strip.getByLabel('sent_id')).toBeVisible();
  const translation = strip.getByLabel('text_en');
  await expect(translation).toBeVisible();

  await strip.getByLabel('sent_id').click();
  await strip.getByLabel('sent_id').fill('ewt-1');
  await strip.getByLabel('sent_id').press('Enter');
  await translation.click();
  await translation.fill('The dog runs.');
  await translation.press('Enter');

  await expect
    .poll(
      async () => {
        const token = await S.client.tokens.get(S.sentenceTokenId);
        return JSON.stringify(token.metadata || {});
      },
      { timeout: 8000 },
    )
    .toContain('The dog runs.');

  // The point of storing them there: the exporter writes them back out.
  await page.goto(`/#/projects/${S.projectId}/documents/${S.documentId}/export`);
  const preview = page.locator('pre, textarea').first();
  await expect(preview).toBeVisible({ timeout: 15000 });
  const text = (await preview.inputValue().catch(() => null)) ?? (await preview.textContent());
  expect(text).toContain('# sent_id = ewt-1');
  expect(text).toContain('# text_en = The dog runs.');
});

test('the sentence strip collapses, and remembers that for the whole document', async ({
  page,
}) => {
  await S.client.tokens.patchMetadata(S.sentenceTokenId, { sent_id: 'ewt-9' });
  await open(page, 'annotate');
  await expect(page.locator('.token-form', { hasText: 'dog' }).first()).toBeVisible({
    timeout: 15000,
  });

  await expect(page.locator('.sentence-meta__fields')).toBeVisible();
  await page.locator('.sentence-meta__toggle').click();
  await expect(page.locator('.sentence-meta__fields')).toHaveCount(0);
  // Collapsed, the toggle still shows the one value worth seeing at a glance.
  await expect(page.locator('.sentence-meta__summary')).toHaveText('ewt-9');

  await page.reload();
  await expect(page.locator('.token-form', { hasText: 'dog' }).first()).toBeVisible({
    timeout: 15000,
  });
  await expect(page.locator('.sentence-meta__fields')).toHaveCount(0);
});

test('the four things a sentence offers are one row of four, alike', async ({ page }) => {
  // The metadata disclosure used to be a bold SENTENCE heading on its own line
  // above the strip. Nothing pinned the redesign: the specs that survived it
  // survived by naming CSS classes the redesign kept.
  await open(page, 'annotate');
  await expect(page.locator('.token-form').first()).toBeVisible({ timeout: 15000 });

  const strip = page.locator('.sentence-confirm').first();
  for (const label of ['Edit metadata', 'Edit text', 'Comment']) {
    await expect(strip.getByText(label, { exact: false }).first()).toBeVisible();
  }
  // One treatment, so none of them is the loudest thing here. The metadata
  // control is the exception WHILE ITS FIELDS ARE OPEN, which is a state of
  // the sentence rather than a difference in weight, and the disclosure is
  // remembered for the whole document, so collapse it first.
  const toggle = page.locator('.sentence-meta__toggle').first();
  if ((await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click();
  // These brighten on hover OR focus, so the thing just clicked is still lit
  // under both the caret and the pointer.
  const stepAside = async () => {
    await page.evaluate(() => document.activeElement?.blur());
    await page.mouse.move(0, 0);
  };
  await stepAside();
  const actions = strip.locator('.sentence-action');
  await expect(actions).toHaveCount(3); // Ask needs an assistant online
  for (let i = 0; i < 3; i += 1) {
    await expect(actions.nth(i)).toHaveCSS('opacity', '0.55');
  }

  // Open, it stays lit while the other two do not.
  await toggle.click();
  await stepAside();
  await expect(toggle).toHaveCSS('opacity', '1');
  await expect(strip.getByText('Edit text')).toHaveCSS('opacity', '0.55');

  // The fields open BELOW the row that opens them, not above the grid.
  await expect(page.locator('.sentence-meta__fields').first()).toBeVisible();
  const stripBox = await strip.boundingBox();
  const fieldsBox = await page.locator('.sentence-meta').first().boundingBox();
  expect(fieldsBox.y).toBeGreaterThan(stripBox.y);
});
