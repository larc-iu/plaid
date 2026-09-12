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
        JSON.stringify({ lemma: true, xpos: true, upos: true, feats: true }),
      );
    }
  });
  await page.goto(`/#/projects/${S.projectId}/documents/${S.documentId}/${tab}`);
};

// The sentence's own fields live in a dialog, one sentence at a time. Returns
// the dialog, so a test names its fields inside it rather than on the page.
const openMetadata = async (page, nth = 0) => {
  await page.locator('.sentence-meta__toggle').nth(nth).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
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
  await expect(page.locator('label[for="metadata-leftover"]')).toHaveAttribute(
    'title',
    /leftover is not one of this project's fields/,
  );

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

  const fields = await openMetadata(page);
  await expect(fields.getByLabel('sent_id', { exact: true })).toBeVisible();
  const translation = fields.getByLabel('text_en', { exact: true });
  await expect(translation).toBeVisible();

  await fields.getByLabel('sent_id', { exact: true }).click();
  await fields.getByLabel('sent_id', { exact: true }).fill('ewt-1');
  await fields.getByLabel('sent_id', { exact: true }).press('Enter');
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

test('the dialog edits ONE sentence, and nothing about the grid moves', async ({ page }) => {
  await S.client.tokens.patchMetadata(S.sentenceTokenId, { sent_id: 'ewt-9' });
  await open(page, 'annotate');
  await expect(page.locator('.token-form', { hasText: 'dog' }).first()).toBeVisible({
    timeout: 15000,
  });

  // Nothing under the grid until it is asked for. The strip that used to sit
  // there opened for every sentence at once and buried the annotation.
  await expect(page.locator('#metadata-sent_id')).toHaveCount(0);

  const fields = await openMetadata(page);
  await expect(fields.getByLabel('sent_id', { exact: true })).toHaveValue('ewt-9');
  await expect(page.getByText('sentence 1', { exact: false })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('#metadata-sent_id')).toHaveCount(0);
});

test('a field the project never declared can be added and removed', async ({ page }) => {
  // CoNLL-U's `# k = v` lines are open-ended, so the editor is not limited to
  // what the project declares.
  await open(page, 'annotate');
  await expect(page.locator('.token-form', { hasText: 'dog' }).first()).toBeVisible({
    timeout: 15000,
  });
  const fields = await openMetadata(page);

  await fields.getByRole('button', { name: 'Add field' }).click();
  await fields.getByLabel('New field name').fill('speaker');
  await fields.getByLabel('New field name').press('Enter');

  const speaker = fields.getByLabel('speaker', { exact: true });
  await expect(speaker).toBeVisible();
  await speaker.fill('Claire');
  await speaker.press('Enter');

  await expect
    .poll(async () => (await S.client.tokens.get(S.sentenceTokenId)).metadata?.speaker, {
      timeout: 8000,
    })
    .toBe('Claire');

  // Removing it takes the key out rather than storing a blank, and the row
  // goes with it because nothing declares it.
  await fields.getByRole('button', { name: 'Remove speaker' }).click();
  await expect(speaker).toHaveCount(0, { timeout: 8000 });
  await expect
    .poll(
      async () => 'speaker' in ((await S.client.tokens.get(S.sentenceTokenId)).metadata || {}),
      {
        timeout: 8000,
      },
    )
    .toBe(false);
});

test('a name that cannot be a field says why and is not added', async ({ page }) => {
  await open(page, 'annotate');
  await expect(page.locator('.token-form', { hasText: 'dog' }).first()).toBeVisible({
    timeout: 15000,
  });
  const fields = await openMetadata(page);

  await fields.getByRole('button', { name: 'Add field' }).click();
  await fields.getByLabel('New field name').fill('sent_id');
  await fields.getByLabel('New field name').press('Enter');

  await expect(fields.getByText('Every sentence already has sent_id.')).toBeVisible();
  // One sent_id box, not two.
  await expect(page.locator('#metadata-sent_id')).toHaveCount(1);
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
  // One treatment, so none of them is the loudest thing here: none of these is
  // what you came to the sentence to do.
  // These brighten on hover OR focus, so the thing just clicked is still lit
  // under both the caret and the pointer.
  const stepAside = async () => {
    await page.evaluate(() => document.activeElement?.blur());
    await page.mouse.move(0, 0);
  };
  await stepAside();
  // Whichever of them are here wear the same treatment. The COUNT is not the
  // point and is not pinned: "Ask" only appears while an assistant is online,
  // which is a fact about the core this suite is pointed at.
  const actions = strip.locator('.sentence-action');
  const n = await actions.count();
  expect(n).toBeGreaterThanOrEqual(3);
  for (let i = 0; i < n; i += 1) {
    await expect(actions.nth(i)).toHaveCSS('opacity', '0.55');
  }
});

test("the top-left number is the sentence's place in the document", async ({ page }) => {
  // Its POSITION, not its sent_id: the id is a field like any other and can be
  // edited to anything, and a stale one at the corner of every sentence is
  // worse than no label.
  await S.client.tokens.patchMetadata(S.sentenceTokenId, { sent_id: 'anything-at-all' });
  await open(page, 'annotate');
  await expect(page.locator('.token-form', { hasText: 'dog' }).first()).toBeVisible({
    timeout: 15000,
  });
  await expect(page.locator('.sentence-id').first()).toHaveText('1');
});
