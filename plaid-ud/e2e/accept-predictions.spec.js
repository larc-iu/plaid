// Verification for the prediction-review UX in the Annotate view:
//  - the "Accept predictions" (sentence) button is subtle by default,
//  - each word with unconfirmed machine predictions gets a ✓ that reveals on
//    hover / keyboard focus and accepts that word (teaching Ctrl+Enter),
//  - accepting clears the inferred styling.
// Seeds 'the dog runs' with a machine-inferred UPOS span on "dog".
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

  const project = await client.projects.create(`Accept preds ${Date.now()}`);
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
  const doc = await client.documents.create(S.projectId, 'Preds Doc');
  S.documentId = doc.id;
  const text = await client.texts.create(textLayerId, doc.id, body);

  const words = [[0, 3], [4, 7], [8, 12]];
  client.beginBatch();
  client.tokens.bulkCreate([{ tokenLayerId: sentenceLayerId, text: text.id, begin: 0, end: body.length }]);
  client.tokens.bulkCreate(words.map(([b, e]) => ({ tokenLayerId: wordLayerId, text: text.id, begin: b, end: e })));
  client.tokens.bulkCreate(words.map(([b, e]) => ({ tokenLayerId: morphemeLayerId, text: text.id, begin: b, end: e, precedence: 0 })));
  const morphIds = (await client.submitBatch())[2].body.ids;
  S.morphIds = morphIds; // [the, dog, runs]

  await client.spans.create(byKey.lemma, [morphIds[0]], 'the');
  await client.spans.create(byKey.lemma, [morphIds[1]], 'dog');
  await client.spans.create(byKey.lemma, [morphIds[2]], 'run');
  // A machine prediction (unconfirmed) on "dog"'s UPOS — drives the review UI.
  await client.spans.create(byKey.upos, [morphIds[1]], 'NOUN', { prov: 'inferred', provSource: 'service:test' });
});

test.afterAll(async () => {
  if (S.client && S.projectId) {
    await S.client.projects.delete(S.projectId).catch((e) => console.error('cleanup failed:', e.message));
  }
});

async function openAnnotate(page) {
  await seedAuth(page);
  await page.addInitScript(() => {
    localStorage.setItem('ud-annotation-visible-fields',
      JSON.stringify({ lemma: true, xpos: true, upos: true, feats: true }));
  });
  await page.goto(`/#/projects/${S.projectId}/documents/${S.documentId}/annotate`);
  await expect(page.locator('.token-form', { hasText: 'dog' }).first()).toBeVisible({ timeout: 15000 });
}

const opacityOf = (loc) => loc.evaluate((el) => getComputedStyle(el).opacity);

test('the sentence "Accept predictions" button is subtle, prominent on hover', async ({ page }) => {
  await openAnnotate(page);
  const btn = page.locator('.accept-predictions-btn');
  await expect(btn).toBeVisible();
  expect(Number(await opacityOf(btn))).toBeLessThan(1); // dimmed by default
  await btn.hover();
  await expect.poll(() => opacityOf(btn)).toBe('1'); // pops on hover
});

test('the per-word ✓ is hidden by default and reveals on keyboard focus', async ({ page }) => {
  await openAnnotate(page);

  // "dog"'s UPOS is a machine prediction → rendered inferred (violet).
  await expect(page.locator('.editable-field--inferred')).toHaveCount(1);
  const accept = page.locator('.word-accept');
  await expect(accept).toHaveCount(1);
  expect(await opacityOf(accept)).toBe('0'); // NOT always-visible

  // Focusing one of the word's cells reveals it (keyboard review). Use the lemma
  // cell — a plain input whose focus doesn't open a vocab dropdown.
  await page.locator(`[id="${S.morphIds[1]}-lemma"]`).focus();
  await expect.poll(() => opacityOf(accept)).toBe('1');
});

test('the per-word ✓ is reachable by mouse and accepts the word', async ({ page }) => {
  await openAnnotate(page);
  const accept = page.locator('.word-accept');

  await page.locator(`[id="${S.morphIds[1]}-lemma"]`).hover(); // mouse reveal
  await expect.poll(() => opacityOf(accept)).toBe('1');

  // Must survive the trip up to it (across the tree SVG) and be clickable.
  await accept.click();
  await expect(page.locator('.editable-field--inferred')).toHaveCount(0, { timeout: 8000 });
  await expect(page.locator('.word-accept')).toHaveCount(0, { timeout: 8000 });
});
