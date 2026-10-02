// Verification spec for the redesigned TokenVisualizer (Text Editor view):
// The hover panel + click-to-toggle-sentence + the inline word editor.
// Seeds a throwaway UD project 'the dog runs' with the full layer hierarchy +
// tokens, opens the /edit route, and drives the new popover behaviors.
import { createUdLayers } from './seedUdDoc.js';
import { test, expect, seedAuth, readToken } from './fixtures.js';
import { PlaidClient } from '@larc-iu/plaid-client';

const BASE = 'http://localhost:8085';
const S = {};

test.beforeAll(async () => {
  const { token } = readToken();
  const client = new PlaidClient(BASE, token);
  S.client = client;

  const L = await createUdLayers(client, `Token popover ${Date.now()}`);
  S.projectId = L.projectId;
  const { textLayerId, sentenceLayerId, wordLayerId, morphemeLayerId } = L;

  const body = 'the dog runs';
  const doc = await client.documents.create(S.projectId, 'Nav Doc');
  S.documentId = doc.id;
  const text = await client.texts.create(textLayerId, doc.id, body);

  const words = [
    [0, 3],
    [4, 7],
    [8, 12],
  ]; // the / dog / runs
  await client.batched(async (b) => {
    b.tokens.bulkCreate([
      { tokenLayerId: sentenceLayerId, text: text.id, begin: 0, end: body.length },
    ]);
    b.tokens.bulkCreate(
      words.map(([begin, end]) => ({ tokenLayerId: wordLayerId, text: text.id, begin, end })),
    );
    b.tokens.bulkCreate(
      words.map(([begin, end]) => ({
        tokenLayerId: morphemeLayerId,
        text: text.id,
        begin,
        end,
        precedence: 0,
      })),
    );
  });
});

test.afterAll(async () => {
  if (S.client && S.projectId) {
    await S.client.projects
      .delete(S.projectId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

async function openEditor(page) {
  await seedAuth(page);
  await page.goto(`/#/projects/${S.projectId}/documents/${S.documentId}/edit`);
  // Three token badges (stable data-attr locator, not the hashed CSS-module class).
  await expect(page.locator('[data-mwt]')).toHaveCount(3, { timeout: 15000 });
}

const badges = (page) => page.locator('[data-mwt]');

const panel = (page) => page.locator('[data-token-panel]');

test('hovering a token shows the inline panel (switch, word editor, footer)', async ({ page }) => {
  await openEditor(page);
  await badges(page).nth(1).hover(); // "dog"

  const p = panel(page);
  await expect(p).toBeVisible({ timeout: 5000 });
  await expect(p.getByText('Start of sentence')).toBeVisible();
  await expect(p.getByText('Words', { exact: false })).toBeVisible();
  await expect(p.getByRole('textbox')).toHaveValue('dog'); // word editor is inline
  await expect(p.getByRole('button', { name: 'Add word' })).toBeVisible();
  await expect(p.getByRole('button', { name: 'Delete' })).toBeVisible();
  await expect(p.getByRole('button', { name: 'Save' })).toBeVisible();
});

test('panel stays open while editing inline, cancels on Escape', async ({ page }) => {
  await openEditor(page);
  await badges(page).nth(1).hover(); // "dog"
  const p = panel(page);
  await expect(p).toBeVisible();

  const input = p.getByRole('textbox').first();
  await input.click(); // focus → pins the panel
  await input.fill('dogg'); // unsaved draft
  await page.mouse.move(2, 2); // move the cursor well away
  await page.waitForTimeout(400); // longer than the close delay
  await expect(p).toBeVisible(); // must NOT dismiss while editing

  await page.keyboard.press('Escape'); // discard + close
  await expect(p).toHaveCount(0);
});

test('editing words inline creates a multi-word token on save', async ({ page }) => {
  await openEditor(page);
  await badges(page).nth(2).hover(); // "runs"
  const p = panel(page);
  await expect(p).toBeVisible();

  await p.getByRole('textbox').first().fill('run');
  await p.getByRole('button', { name: 'Add word' }).click();
  await p.getByRole('textbox').nth(1).fill('s');
  await p.getByRole('button', { name: 'Save' }).click();

  await expect(badges(page).nth(2)).toHaveAttribute('data-mwt', 'true', { timeout: 8000 });
});

test('clicking a token toggles its sentence boundary', async ({ page }) => {
  const sentenceCount = async () => {
    const doc = await S.client.documents.get(S.documentId, true);
    let n = 0;
    for (const tl of doc.textLayers || [])
      for (const tok of tl.tokenLayers || [])
        if (tok.name === 'Sentences') n = (tok.tokens || []).length;
    return n;
  };
  await openEditor(page);
  expect(await sentenceCount()).toBe(1);
  await expect(page.locator('[data-sent-start="true"]')).toHaveCount(1);

  await badges(page).nth(1).click({ force: true }); // "dog"
  await expect.poll(sentenceCount, { timeout: 8000 }).toBe(2);
  await expect(page.locator('[data-sent-start="true"]')).toHaveCount(2, { timeout: 8000 });

  await badges(page).nth(1).click({ force: true }); // toggle back
  await expect.poll(sentenceCount, { timeout: 8000 }).toBe(1);
  await expect(page.locator('[data-sent-start="true"]')).toHaveCount(1, { timeout: 8000 });
});
