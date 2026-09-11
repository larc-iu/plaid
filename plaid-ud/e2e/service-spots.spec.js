// Item 11: Parse and Tokenize are service runs, on the shared dialog.
//
// The built-in tokenizer is what makes this testable without a service: it is
// always in the method list, so the whole idiom (opener, dialog, method row,
// run, the write lock underneath) can be driven with nothing connected. The
// Parse spot is only checked as far as its dialog, since whether a parser is
// online is a property of the machine and not of the code.
import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';
import { createUdProject } from '../src/domain/udProjectSetup.js';
import { getUdLayerInfo } from '../src/utils/udLayerUtils.js';

const CORE = 'http://localhost:8085';
const BODY = 'The dog runs. The cat sleeps.';

const S = {};

// A document with saved text and NO tokens, which is the one state Tokenize
// will run in.
test.beforeAll(async () => {
  const { token } = readToken();
  S.client = new PlaidClient(CORE, token);
  const created = await createUdProject(S.client, `Service spots ${Date.now()}`);
  S.projectId = created.id;
  const info = getUdLayerInfo(await S.client.projects.get(created.id));
  const doc = await S.client.documents.create(created.id, 'Doc');
  S.documentId = doc.id;
  await S.client.texts.create(info.textLayer.id, doc.id, BODY);
});

test.afterAll(async () => {
  if (S.client && S.projectId) {
    await S.client.projects
      .delete(S.projectId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

const openEditor = async (page) => {
  await seedAuth(page);
  await page.goto(`/#/projects/${S.projectId}/documents/${S.documentId}/edit`);
  await expect(page.getByRole('button', { name: 'Tokenize' })).toBeVisible({ timeout: 15000 });
};

const counts = (page) => page.getByText(/\d+ tokens?, \d+ sentences?/);

test('Tokenize is a run: the button opens a dialog naming its method', async ({ page }) => {
  await openEditor(page);
  await expect(counts(page)).toHaveText('0 tokens, 0 sentences');

  await page.getByRole('button', { name: 'Tokenize' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // One method is stated rather than offered, and it is the built-in, so a
  // project with no service connected can still tokenize.
  await expect(dialog.getByText('Method')).toBeVisible();
  await expect(dialog.getByText(/Unicode segmentation/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Tokenize' })).toBeEnabled();
});

test('running it tokenizes the document, and the dialog then refuses to run again', async ({
  page,
}) => {
  await openEditor(page);
  await page.getByRole('button', { name: 'Tokenize' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Tokenize' }).click();

  // The run ends in a reload, so poll rather than reading once. The count is
  // pinned rather than merely "more than none": this IS the built-in's output
  // for this body (punctuation is a token of its own, and with no tokenizer
  // locale on the project the segmenter finds one sentence), so a change in it
  // is a change worth being told about.
  await expect(counts(page)).toHaveText('8 tokens, 1 sentence', { timeout: 20000 });

  // Re-tokenizing would replace what is there, so the dialog says why it will
  // not, rather than offering a button that does nothing.
  await page.getByRole('button', { name: 'Tokenize' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Clear tokens before re-tokenizing.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Tokenize' })).toBeDisabled();
});

test('Parse is a run too, on the same dialog', async ({ page }) => {
  await openEditor(page);
  await page.getByRole('button', { name: 'Parse' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Parse' })).toBeVisible();
  await expect(dialog.getByText(/written into this document/)).toBeVisible();
  // Closing never cancels, and it is always offered. The Radix dialog's corner
  // X is also named "Close", hence the scoping.
  await expect(dialog.getByRole('button', { name: 'Close', exact: true }).first()).toBeEnabled();
});
