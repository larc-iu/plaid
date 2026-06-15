// Verification spec for the redesigned TokenVisualizer (Text Editor view):
// Mantine HoverCard hover panel + click-to-toggle-sentence + Modal word editor.
// Seeds a throwaway UD project 'the dog runs' with the full layer hierarchy +
// tokens, opens the /edit route, and drives the new popover behaviors.
import { test, expect, seedAuth, readToken } from './fixtures.js';
import { PlaidClient, ROLES, PLAID_NAMESPACE, ROLE_KEY } from '@larc-iu/plaid-client';

const BASE = 'http://localhost:8085';
const UD_NS = 'ud';
const SPAN_SPECS = [['Form', 'form'], ['Lemma', 'lemma'], ['UPOS', 'upos'], ['XPOS', 'xpos'], ['Features', 'features']];
const S = {};

test.beforeAll(async () => {
  const { token } = readToken();
  const client = new PlaidClient(BASE, token);
  S.client = client;

  const project = await client.projects.create(`Token popover ${Date.now()}`);
  S.projectId = project.id;

  client.beginBatch();
  client.textLayers.create(S.projectId, 'Text');
  const textLayerId = (await client.submitBatch())[0].body.id;

  client.beginBatch();
  client.textLayers.setConfig(textLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.BASELINE);
  client.tokenLayers.create(textLayerId, 'Sentences', 'partitioning');
  const sentenceLayerId = (await client.submitBatch())[1].body.id;

  client.beginBatch();
  client.tokenLayers.setConfig(sentenceLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.SENTENCE);
  client.tokenLayers.create(textLayerId, 'Tokens', 'non-overlapping', sentenceLayerId);
  const wordLayerId = (await client.submitBatch())[1].body.id;

  client.beginBatch();
  client.tokenLayers.setConfig(wordLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.WORD);
  client.tokenLayers.create(textLayerId, 'Words', 'any', wordLayerId);
  const morphemeLayerId = (await client.submitBatch())[1].body.id;

  client.beginBatch();
  client.tokenLayers.setConfig(morphemeLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.SYNTACTIC_WORD);
  for (const [name] of SPAN_SPECS) client.spanLayers.create(morphemeLayerId, name);
  const b6 = await client.submitBatch();
  const spanLayerIds = SPAN_SPECS.map((_, i) => b6[1 + i].body.id);
  const byKey = Object.fromEntries(SPAN_SPECS.map(([, key], i) => [key, spanLayerIds[i]]));

  client.beginBatch();
  SPAN_SPECS.forEach(([, key], i) => client.spanLayers.setConfig(spanLayerIds[i], UD_NS, key, true));
  client.relationLayers.create(byKey.lemma, 'Dependency Relations');
  const b7 = await client.submitBatch();
  const relationLayerId = b7[b7.length - 1].body.id;
  client.beginBatch();
  client.relationLayers.setConfig(relationLayerId, UD_NS, 'dependency', true);
  await client.submitBatch();

  const body = 'the dog runs';
  const doc = await client.documents.create(S.projectId, 'Nav Doc');
  S.documentId = doc.id;
  const text = await client.texts.create(textLayerId, doc.id, body);

  const words = [[0, 3], [4, 7], [8, 12]]; // the / dog / runs
  client.beginBatch();
  client.tokens.bulkCreate([{ tokenLayerId: sentenceLayerId, text: text.id, begin: 0, end: body.length }]);
  client.tokens.bulkCreate(words.map(([b, e]) => ({ tokenLayerId: wordLayerId, text: text.id, begin: b, end: e })));
  client.tokens.bulkCreate(words.map(([b, e]) => ({ tokenLayerId: morphemeLayerId, text: text.id, begin: b, end: e, precedence: 0 })));
  await client.submitBatch();
});

test.afterAll(async () => {
  if (S.client && S.projectId) {
    await S.client.projects.delete(S.projectId).catch((e) => console.error('cleanup failed:', e.message));
  }
});

async function openEditor(page) {
  await seedAuth(page);
  await page.goto(`/#/projects/${S.projectId}/documents/${S.documentId}/edit`);
  // Three token badges (stable data-attr locator, not the hashed CSS-module class).
  await expect(page.locator('[data-mwt]')).toHaveCount(3, { timeout: 15000 });
}

const badges = (page) => page.locator('[data-mwt]');

test('hovering a token shows the Mantine panel with actions', async ({ page }) => {
  await openEditor(page);
  await badges(page).first().hover();

  // Portaled HoverCard dropdown with the sentence toggle + actions.
  await expect(page.getByText('Start of sentence')).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole('button', { name: 'Edit words' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete' })).toBeVisible();
});

test('Edit words opens the word-editor modal', async ({ page }) => {
  await openEditor(page);
  await badges(page).nth(1).hover(); // "dog"
  await page.getByRole('button', { name: 'Edit words' }).click();

  // The HoverCard dropdown also has role=dialog, so target the Modal by name.
  const dialog = page.getByRole('dialog', { name: /Words of/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox').first()).toHaveValue('dog');
  await expect(dialog.getByRole('button', { name: 'Add word' })).toBeVisible();
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
