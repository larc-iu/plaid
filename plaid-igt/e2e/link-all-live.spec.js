import PlaidClient, { ROLES, cpLength } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';

// "Link every…" on the first click, through the real grid: an unlinked word
// with two more like it, the chip on the highlighted row, and the new entry
// taking all three in one go. The unanalyzed words have NO morpheme token, so
// the morpheme-level half of this is the path that has to materialize them.
//
// Throwaway document in the "E2E IGT Fixture" project, deleted afterwards.

const CORE = 'http://localhost:8085';
const roleOf = (l) => l?.config?.plaid?.role;
const FORM = `all${Date.now().toString(36)}`;
const BODY = `${FORM} ${FORM} ${FORM}`;

let client;
let projectId;
let documentId;
let vocabId;

test.beforeAll(async () => {
  client = new PlaidClient(CORE, readToken().token);
  const project = (await client.projects.list()).find((p) => p.name === 'E2E IGT Fixture');
  if (!project) throw new Error('run node e2e/fixtureProject.js first');
  projectId = project.id;
  const full = await client.projects.get(projectId);
  const textLayer = full.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const layer = (role) => textLayer.tokenLayers.find((l) => roleOf(l) === role);
  const created = await client.documents.create(projectId, `link-all-spec ${Date.now()}`);
  documentId = created.id;
  await client.texts.create(textLayer.id, documentId, BODY);
  const raw = await client.documents.get(documentId, true);
  const TEXT = raw.textLayers.find((l) => roleOf(l) === ROLES.BASELINE).text.id;
  await client.tokens.bulkCreate([
    { tokenLayerId: layer(ROLES.SENTENCE).id, text: TEXT, begin: 0, end: cpLength(BODY) },
  ]);
  await client.tokens.bulkCreate(
    [...BODY.matchAll(/\S+/g)].map((m) => ({
      tokenLayerId: layer(ROLES.WORD).id,
      text: TEXT,
      begin: m.index,
      end: m.index + m[0].length,
    })),
  );
  vocabId = (await client.vocabLayers.list()).find((v) => v.name === 'IGT Lexicon').id;
});

test.afterAll(async () => {
  if (documentId) await client.documents.delete(documentId).catch(() => {});
  // The entry went into the SHARED "IGT Lexicon": take it back out.
  const vocab = await client.vocabLayers.get(vocabId, true).catch(() => null);
  for (const it of vocab?.items ?? []) {
    if (it.form === FORM) await client.vocabItems.delete(it.id).catch(() => {});
  }
});

test('the create row takes every same-form morpheme along', async ({ page }) => {
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=analyze`);
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  await page.waitForLoadState('networkidle');

  await page.locator('.igt-morph-col .igt-vocab__opener').first().click();
  await page.locator('.igt-vocab-pop').waitFor({ state: 'visible' });
  const create = page.locator('.igt-vocab-pop__create');
  await create.hover();
  const chip = create.locator('.igt-vocab-pop__take-all');
  await expect(chip).toHaveText('all ×3');
  await chip.click();
  await expect(page.locator('.igt-morph-col .igt-vocab__hint')).toHaveCount(3);

  // And it is what the server holds, not only the optimistic patch.
  await page.reload();
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  await expect(page.locator('.igt-morph-col .igt-vocab__hint')).toHaveCount(3);
  const vocab = await client.vocabLayers.get(vocabId, true);
  expect(vocab.items.filter((it) => it.form === FORM)).toHaveLength(1);
});
