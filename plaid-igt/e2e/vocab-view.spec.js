import PlaidClient, { ROLES, cpLength } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';

// TEST_PLAN B7-02 (homonym numbering in the vocabulary view), B9-04 (usage
// counts and "N use(s)" wording) and B9-01 (deleting a linked entry names the
// count, then the links are gone). Throwaway lexicon linked to "E2E IGT
// Fixture" for the run + a throwaway document; both removed afterwards.

const CORE = 'http://localhost:8085';
const roleOf = (l) => l?.config?.plaid?.role;
const BODY = 'kappa lambda mu nu';

let client;
let projectId;
let documentId;
let vocab;
let items = {};

test.beforeAll(async () => {
  client = new PlaidClient(CORE, readToken().token);
  const project = (await client.projects.list()).find((p) => p.name === 'E2E IGT Fixture');
  if (!project) throw new Error('run node e2e/fixture.js first');
  projectId = project.id;
  const stamp = Date.now();
  vocab = await client.vocabLayers.create(`vocab-view ${stamp}`);
  items.ser1 = (await client.vocabItems.create(vocab.id, 'ser')).id;
  items.ser2 = (await client.vocabItems.create(vocab.id, 'ser')).id;
  items.dup = (await client.vocabItems.create(vocab.id, `dup${stamp}`)).id;
  items.dupForm = `dup${stamp}`;
  await client.projects.linkVocab(projectId, vocab.id);
  const full = await client.projects.get(projectId);
  const textLayer = full.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const layer = (role) => textLayer.tokenLayers.find((l) => roleOf(l) === role);
  const created = await client.documents.create(projectId, `vocab-view ${stamp}`);
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
  const m = words.map((x) => ml.tokens.find((t) => t.begin === x.begin).id);
  for (const id of m.slice(0, 3)) await client.vocabLinks.create(items.dup, [id]);
  await client.vocabLinks.create(items.ser1, [m[3]]);
});

test.afterAll(async () => {
  if (documentId) await client.documents.delete(documentId).catch(() => {});
  if (vocab) {
    await client.projects.unlinkVocab(projectId, vocab.id).catch(() => {});
    await client.vocabLayers.delete(vocab.id).catch(() => {});
  }
});

async function openView(page) {
  await seedAuth(page);
  await page.goto(`/#/vocabularies/${vocab.id}`);
  await page.getByText(items.dupForm).first().waitFor({ state: 'visible' });
  await page.waitForLoadState('networkidle');
}

test('B7-02: homonyms are numbered in creation order in the vocabulary view', async ({ page }) => {
  await openView(page);
  const serRows = page.locator('sub').filter({ hasText: /^[12]$/ });
  await expect(serRows).toHaveCount(2);
  await expect(serRows.nth(0)).toHaveText('1');
  await expect(serRows.nth(1)).toHaveText('2');
});

test('B9-04: usage counts match the links, singular wording for one use', async ({ page }) => {
  await openView(page);
  const dupRow = page.getByText(items.dupForm).first();
  await dupRow.click();
  await expect(page.getByText(/^3 uses$/)).toBeVisible();
  const serRow = page.locator('sub', { hasText: /^1$/ }).first();
  await serRow.click();
  await expect(page.getByText(/^1 use$/)).toBeVisible();
});

test('B9-01: deleting a linked entry names the link count and removes the links', async ({
  page,
}) => {
  await openView(page);
  await page.getByText(items.dupForm).first().click();
  await page.getByRole('button', { name: /^Delete$/ }).click();
  const dialog = page.getByRole('dialog').or(page.getByRole('alertdialog'));
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('3');
  await expect(dialog).toContainText(/links will be removed/i);
  await dialog.getByRole('button', { name: /Delete Item/ }).click();
  await expect(page.getByText(items.dupForm)).toHaveCount(0);
  await expect
    .poll(async () => {
      const raw = await client.documents.get(documentId, true);
      return raw.textLayers
        .flatMap((t) => t.tokenLayers)
        .flatMap((l) => l.vocabs || [])
        .flatMap((v) => v.vocabLinks || [])
        .filter((l) => l.vocabItem?.id === items.dup).length;
    })
    .toBe(0);
});
