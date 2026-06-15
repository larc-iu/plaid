// Verification spec for the deprel-label keyboard navigation:
//   - focus returns to the edited label after Enter (selected, not editing)
//   - ArrowLeft/Right move between labels
//   - ArrowDown drops from a label into that dependent token's grid cell
//   - ArrowUp from the top grid row hands off to the token's deprel label
// Seeds a throwaway UD project 'the dog runs' with lemma spans + a 3-relation
// tree: root(runs), nsubj(runs->dog), det(dog->the). Relations store
// source=head, target=dependent, so each token maps 1:1 to its own label.
import { test, expect, seedAuth, collectClientErrors, readToken } from './fixtures.js';
import { PlaidClient, ROLES, PLAID_NAMESPACE, ROLE_KEY } from '@larc-iu/plaid-client';

const BASE = 'http://localhost:8085';
const UD_NS = 'ud';
const SPAN_SPECS = [['Form', 'form'], ['Lemma', 'lemma'], ['UPOS', 'upos'], ['XPOS', 'xpos'], ['Features', 'features']];
const S = {};

test.beforeAll(async () => {
  const { token } = readToken();
  const client = new PlaidClient(BASE, token);
  S.client = client;

  const project = await client.projects.create(`DEPREL nav ${Date.now()}`);
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
  client.tokenLayers.create(textLayerId, 'Words', 'non-overlapping', sentenceLayerId);
  const wordLayerId = (await client.submitBatch())[1].body.id;

  client.beginBatch();
  client.tokenLayers.setConfig(wordLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.WORD);
  client.tokenLayers.create(textLayerId, 'Morphemes', 'any', wordLayerId);
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
  const morphIds = (await client.submitBatch())[2].body.ids;
  S.morphIds = morphIds; // [the, dog, runs]

  const lemThe = (await client.spans.create(byKey.lemma, [morphIds[0]], 'the')).id;
  const lemDog = (await client.spans.create(byKey.lemma, [morphIds[1]], 'dog')).id;
  const lemRuns = (await client.spans.create(byKey.lemma, [morphIds[2]], 'run')).id;

  // source = head, target = dependent
  await client.relations.create(relationLayerId, lemRuns, lemRuns, 'root');
  await client.relations.create(relationLayerId, lemRuns, lemDog, 'nsubj');
  await client.relations.create(relationLayerId, lemDog, lemThe, 'det');
});

test.afterAll(async () => {
  if (S.client && S.projectId) {
    await S.client.projects.delete(S.projectId).catch((e) => console.error('cleanup failed:', e.message));
  }
});

async function openGrid(page) {
  const collected = collectClientErrors(page);
  await seedAuth(page);
  await page.addInitScript(() => {
    localStorage.setItem('ud-annotation-visible-fields',
      JSON.stringify({ lemma: true, xpos: true, upos: true, feats: true }));
  });
  await page.goto(`/#/projects/${S.projectId}/documents/${S.documentId}/annotate`);
  for (const form of ['the', 'dog', 'runs']) {
    await expect(page.locator('.token-form', { hasText: form }).first()).toBeVisible({ timeout: 15000 });
  }
  // Wait for the three deprel labels to be painted (after position measurement).
  await expect(page.locator('.tree-deprel-text')).toHaveCount(3, { timeout: 15000 });
  return collected;
}

const active = (page) => page.evaluate(() => ({
  tag: document.activeElement?.tagName?.toLowerCase() || null,
  text: (document.activeElement?.textContent || '').trim(),
  id: document.activeElement?.id || '',
  cls: document.activeElement?.getAttribute?.('class') || '',
}));

const label = (page, value) => page.locator('.tree-deprel-text', { hasText: new RegExp(`^${value}`) });

test('Enter returns focus to the edited deprel label', async ({ page }) => {
  const collected = await openGrid(page);

  await label(page, 'det').click();
  // Editor opened: an input inside the SVG foreignObject, seeded with 'det'.
  const editor = page.locator('foreignObject input');
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue('det');

  await page.keyboard.press('Enter');

  // Editor closed and focus is back on the 'det' <text> label.
  await expect(editor).toHaveCount(0);
  await expect.poll(() => active(page).then((a) => `${a.tag}:${a.text}`)).toBe('text:det');
  await expect(label(page, 'det')).toHaveClass(/tree-deprel-text--focused/);

  reportErrors('Enter-return', collected);
});

test('ArrowLeft/Right move between deprel labels', async ({ page }) => {
  await openGrid(page);

  await label(page, 'det').click();
  await page.keyboard.press('Enter'); // -> selected on 'det'
  await expect.poll(() => active(page).then((a) => a.text)).toBe('det');

  // Visual left-to-right order is det, nsubj, root.
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => active(page).then((a) => `${a.tag}:${a.text}`)).toBe('text:nsubj');

  await page.keyboard.press('ArrowRight');
  await expect.poll(() => active(page).then((a) => a.text)).toBe('root');

  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => active(page).then((a) => a.text)).toBe('nsubj');
});

test('ArrowDown drops from a label into its dependent token cell', async ({ page }) => {
  await openGrid(page);

  await label(page, 'det').click();
  await page.keyboard.press('Enter'); // selected on 'det' (dependent = 'the' = morphIds[0])
  await expect.poll(() => active(page).then((a) => a.text)).toBe('det');

  await page.keyboard.press('ArrowDown');
  await expect.poll(() => active(page).then((a) => a.id)).toBe(`${S.morphIds[0]}-lemma`);
});

test('ArrowUp from the top grid row hands off to the token label', async ({ page }) => {
  await openGrid(page);

  // Focus the lemma cell of 'the' (morphIds[0]); ArrowUp -> its deprel ('det').
  await page.locator(`[id="${S.morphIds[0]}-lemma"]`).focus();
  await expect.poll(() => active(page).then((a) => a.id)).toBe(`${S.morphIds[0]}-lemma`);

  await page.keyboard.press('ArrowUp');
  await expect.poll(() => active(page).then((a) => `${a.tag}:${a.text}`)).toBe('text:det');
});

function reportErrors(labelText, { errors }) {
  if (errors.length) {
    console.log(`--- [${labelText}] console errors ---`);
    for (const e of errors) console.log(JSON.stringify(e));
  }
}
