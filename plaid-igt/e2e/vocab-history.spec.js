import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';

// A vocabulary's History (audit-vocab-history, ruled b): the rail lists every
// change, a pick shows the entries as they were, read-only, and a maintainer
// puts one entry back, a changed one or a deleted one, with Undo. A throwaway
// vocabulary is made and removed; nothing touches the shared fixture.

const CORE = 'http://localhost:8085';

let client;
let vocabId;
let ids;

test.beforeEach(async () => {
  client = new PlaidClient(CORE, readToken().token);
  const stamp = Date.now();
  const vocab = await client.vocabLayers.create(`History spec ${stamp}`);
  vocabId = vocab.id;
  ids = {};
  await client.withOperation('Add entries', async () => {
    for (const [form, gloss] of [
      ['kai', 'eat'],
      ['kaia', 'food'],
      ['tama', 'child'],
    ]) {
      ids[form] = (await client.vocabItems.create(vocabId, form, { gloss })).id;
    }
  });
  await client.vocabItems.bulkUpdate(
    [{ id: ids.kai, form: 'kay', metadata: [{ op: 'set', path: ['gloss'], value: 'consume' }] }],
    'Edit entry "kay"',
  );
  await client.vocabItems.delete(ids.kaia, 'Delete entry "kaia"');
});

test.afterEach(async () => {
  if (vocabId) await client.vocabLayers.delete(vocabId).catch(() => {});
});

const openPast = async (page, itemId) => {
  await seedAuth(page);
  await page.goto(`/#/vocabularies/${vocabId}?item=${itemId}`);
  await page.getByRole('button', { name: 'History', exact: true }).first().click();
  await page.getByText('Add entries').click();
  await expect(page.getByText('Read-only. This is the vocabulary as of')).toBeVisible();
};

test('a past state lists the entries as they were, read-only', async ({ page }) => {
  await openPast(page, ids.kai);
  await expect(page.getByText('Delete entry "kaia"')).toBeVisible();
  await expect(page.getByRole('link', { name: /kaia/ })).toBeVisible();
  const form = page.locator('input[id$="-form"]');
  await expect(form).toHaveValue('kai');
  await expect(form).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Return to current' }).click();
  await expect(page.getByText('Read-only. This is the vocabulary as of')).toHaveCount(0);
  await expect(page.locator('input[id$="-form"]')).toHaveValue('kay');
});

test('an entry is put back as it was, and the form shows it', async ({ page }) => {
  await openPast(page, ids.kai);
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Form: “kay” → “kai”')).toBeVisible();
  await expect(dialog.getByText('Gloss: “consume” → “eat”')).toBeVisible();
  await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByText('Restored').first()).toBeVisible();

  const { items } = await client.vocabLayers.get(vocabId, true);
  const kai = items.find((it) => it.id === ids.kai);
  expect([kai.form, kai.metadata.gloss]).toEqual(['kai', 'eat']);
  // Back on the vocabulary as it is now, the form filled from the restored entry.
  await expect(page.locator('input[id$="-form"]')).toHaveValue('kai');
  await expect(page.locator('input[id$="-form"]')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  await expect(page.getByText(/Restore entry “kai” to/)).toBeVisible();
});

test('a deleted entry comes back, and Undo deletes it again', async ({ page }) => {
  await openPast(page, ids.kaia);
  await expect(page.getByText('Deleted since')).toBeVisible();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('The entry comes back as it was.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByText('“kaia” is back, without its links.')).toBeVisible();
  let { items } = await client.vocabLayers.get(vocabId, true);
  expect(items.some((it) => it.id === ids.kaia)).toBe(true);

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('“kaia” deleted again.')).toBeVisible();
  ({ items } = await client.vocabLayers.get(vocabId, true));
  expect(items.some((it) => it.id === ids.kaia)).toBe(false);
});
