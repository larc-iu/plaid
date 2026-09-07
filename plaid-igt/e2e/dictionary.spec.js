import PlaidClient, { ROLES, cpLength } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';

// The dictionary side of a vocabulary: the sense tree in the list and on an
// entry, reference fields, examples promoted from the concordance, and the
// cleanup a delete does. Throwaway lexicon linked to "E2E IGT Fixture" for
// the run + a throwaway document; both removed afterwards.

const CORE = 'http://localhost:8085';
const roleOf = (l) => l?.config?.plaid?.role;
const BODY = 'kappa lambda mu nu';

let client;
let projectId;
let documentId;
let vocab;
let ids = {};
let stamp;

test.beforeAll(async () => {
  client = new PlaidClient(CORE, readToken().token);
  const project = (await client.projects.list()).find((p) => p.name === 'E2E IGT Fixture');
  if (!project) throw new Error('run node e2e/fixture.js first');
  projectId = project.id;
  stamp = Date.now();
  vocab = await client.vocabLayers.create(`dictionary ${stamp}`);
  await client.vocabLayers.setConfig(vocab.id, 'igt', 'dictionary', true);
  await client.vocabLayers.setConfig(vocab.id, 'igt', 'fields', {
    morphType: { inline: false },
    gloss: { inline: true },
    variantOf: { inline: false, type: 'item' },
    etymology: { inline: false, scope: 'entry' },
  });
  ids.kat = (await client.vocabItems.create(vocab.id, `kat${stamp}`, { gloss: 'cat' })).id;
  ids.kat2 = (
    await client.vocabItems.create(vocab.id, `kat${stamp}`, {
      gloss: 'lion',
      parent: ids.kat,
      senseOrder: 1,
    })
  ).id;
  ids.run = (
    await client.vocabItems.create(vocab.id, `run${stamp}`, { gloss: 'run', variantOf: ids.kat })
  ).id;
  await client.projects.linkVocab(projectId, vocab.id);
  const full = await client.projects.get(projectId);
  const textLayer = full.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const layer = (role) => textLayer.tokenLayers.find((l) => roleOf(l) === role);
  const created = await client.documents.create(projectId, `dictionary ${stamp}`);
  documentId = created.id;
  await client.texts.create(textLayer.id, documentId, BODY);
  const raw = await client.documents.get(documentId, true);
  const TEXT = raw.textLayers.find((l) => roleOf(l) === ROLES.BASELINE).text.id;
  const words = [...BODY.matchAll(/\S+/g)].map((m) => ({
    begin: m.index,
    end: m.index + m[0].length,
  }));
  await client.tokens.bulkCreate([
    { tokenLayerId: layer(ROLES.SENTENCE).id, text: TEXT, begin: 0, end: cpLength(BODY) },
  ]);
  await client.tokens.bulkCreate(
    words.map((w) => ({ tokenLayerId: layer(ROLES.WORD).id, text: TEXT, ...w })),
  );
  await client.tokens.bulkCreate(
    words.map((w) => ({ tokenLayerId: layer(ROLES.MORPHEME).id, text: TEXT, ...w, precedence: 1 })),
  );
  const seeded = await client.documents.get(documentId, true);
  const ml = seeded.textLayers
    .find((l) => roleOf(l) === ROLES.BASELINE)
    .tokenLayers.find((l) => roleOf(l) === ROLES.MORPHEME);
  ids.tok = ml.tokens.find((t) => t.begin === 0).id;
  await client.vocabLinks.create(ids.kat, [ids.tok]);
});

test.afterAll(async () => {
  if (documentId) await client.documents.delete(documentId).catch(() => {});
  if (vocab) {
    await client.projects.unlinkVocab(projectId, vocab.id).catch(() => {});
    await client.vocabLayers.delete(vocab.id).catch(() => {});
  }
});

const meta = async (id) => (await client.vocabItems.get(id)).metadata || {};

async function openView(page, itemId) {
  await seedAuth(page);
  await page.goto(`/#/vocabularies/${vocab.id}${itemId ? `?item=${itemId}` : ''}`);
  await page.getByText(`run${stamp}`).first().waitFor({ state: 'visible' });
  await page.waitForLoadState('networkidle');
}

test('the list draws senses under their entry in the By entry view', async ({ page }) => {
  await openView(page);
  await page.getByRole('button', { name: 'By entry' }).click();
  const sense = page.locator('a[data-depth="1"]');
  await expect(sense).toHaveCount(1);
  await expect(sense).toContainText('2');
  await expect(sense).toContainText('lion');
  await page.getByRole('button', { name: 'Flat' }).click();
  await expect(page.locator('a[data-depth="1"]')).toHaveCount(0);
});

test('an entry says where it sits, and can be freed and placed again', async ({ page }) => {
  await openView(page, ids.kat2);
  await expect(page.getByText(/^Sense 2 of/)).toBeVisible();
  await page.getByRole('button', { name: 'Make its own entry' }).click();
  await expect(page.getByText(/^Entry$/)).toBeVisible();
  await expect.poll(() => meta(ids.kat2)).not.toHaveProperty('parent');
  // The entry-only field shows now that it is an entry.
  await expect(page.getByLabel('Etymology')).toBeVisible();

  await page.getByRole('button', { name: 'Make a sense of…' }).click();
  await page.getByPlaceholder('Find the entry…').fill(`kat${stamp}`);
  await page.getByRole('option').filter({ hasText: 'cat' }).click();
  await expect(page.getByText(/^Sense 2 of/)).toBeVisible();
  await expect.poll(() => meta(ids.kat2)).toMatchObject({ parent: ids.kat, senseOrder: 1 });
  await expect(page.getByLabel('Etymology')).toHaveCount(0);
});

test('a reference field is a picker whose value is a link to the entry', async ({ page }) => {
  await openView(page, ids.run);
  const chip = page.getByRole('link', { name: new RegExp(`kat${stamp}`) }).first();
  await expect(chip).toBeVisible();
  await page.getByRole('button', { name: 'Remove' }).first().click();
  const picker = page.getByPlaceholder(/Find an entry for variant of/);
  await expect(picker).toBeVisible();
  await picker.fill('lion');
  await page.getByRole('option').filter({ hasText: 'lion' }).click();
  await page.getByRole('button', { name: /^Save$/ }).click();
  await expect.poll(() => meta(ids.run)).toMatchObject({ variantOf: ids.kat2 });
  // Referenced by, on the target.
  await openView(page, ids.kat2);
  const referenced = page.locator('div.rounded-lg', { hasText: 'Referenced by' });
  await expect(referenced).toContainText(`run${stamp}`);
  await expect(referenced).toContainText('Variant Of');
});

test('a concordance row can be promoted to an example and removed again', async ({ page }) => {
  await openView(page, ids.kat);
  const use = page.getByRole('button', { name: 'Use as example' });
  await expect(use).toBeVisible();
  await use.click();
  await expect(page.getByText('Examples')).toBeVisible();
  await expect
    .poll(() => meta(ids.kat))
    .toMatchObject({
      examples: [{ document: documentId, token: ids.tok }],
    });
  await expect(use).toBeDisabled();
  await expect(page.getByRole('list').getByText('kappa').first()).toBeVisible();
  await page.getByRole('button', { name: 'Remove example' }).click();
  await expect.poll(() => meta(ids.kat)).not.toHaveProperty('examples');
});

test('deleting an entry frees its senses and clears references to it', async ({ page }) => {
  // run -> kat2 (from the picker test); kat2 is a sense of kat. Point run
  // back at kat so the delete touches both kinds.
  await client.vocabItems.setMetadata(ids.run, { gloss: 'run', variantOf: ids.kat });
  await openView(page, ids.kat);
  await page.getByRole('button', { name: /^Delete$/ }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('2 entries');
  await dialog.getByRole('button', { name: /Delete Item/ }).click();
  await expect.poll(() => meta(ids.kat2)).not.toHaveProperty('parent');
  await expect.poll(() => meta(ids.run)).not.toHaveProperty('variantOf');
  await expect(page.getByText('cat')).toHaveCount(0);
});
