import PlaidClient, { ROLES, cpLength } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';
import { executeProjectSetup } from '../src/components/projects/setup/executeSetup.js';

// TEST_PLAN rows that need their own project configuration: B11 ignored
// tokens (unicode punctuation + whitelist, blacklist, none), B5-03/12/13
// (create-row trimming follows the project's own rule), C2-01 (create-document
// dialog), C2-03 + B1-10 (a reader sees no Create button and a read-only
// editor). Builds a throwaway project through the wizard's setup helper and
// deletes it (plus its lexicon) afterwards.

const CORE = 'http://localhost:8085';
const roleOf = (l) => l?.config?.plaid?.role;
const BODY = 'derechos. ¿Qué? ? ... $ 😀 hola';
const W = { derechos: 0, que: 1, q: 2, dots: 3, dollar: 4, emoji: 5, hola: 6 };

let client;
let projectId;
let vocabId;
let documentId;
let wordLayerId;
let ids = {};

test.beforeAll(async () => {
  client = new PlaidClient(CORE, readToken().token);
  const name = `project-config ${Date.now()}`;
  const setup = await executeProjectSetup({
    client,
    isNewProject: true,
    resumeProjectId: null,
    setupData: {
      basicInfo: { projectName: name },
      orthographies: { orthographies: [{ name: 'Baseline', isBaseline: true }] },
      fields: {
        fields: [{ name: 'Gloss', scope: 'Morpheme', isCustom: true }],
        ignoredTokens: {
          mode: 'unicode-punctuation',
          unicodePunctuationExceptions: ['?'],
          explicitIgnoredTokens: [],
        },
      },
      vocabulary: {
        vocabularies: [{ id: 'new-1', name: `${name} Lexicon`, enabled: true, isCustom: true }],
      },
      documentMetadata: { enabledFields: [] },
    },
  });
  if (setup.failures.length) throw new Error(setup.failures.join('; '));
  projectId = setup.projectId;
  vocabId = setup.resources.vocabularies[0].id;
  const project = await client.projects.get(projectId);
  const textLayer = project.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const layer = (role) => textLayer.tokenLayers.find((l) => roleOf(l) === role);
  wordLayerId = layer(ROLES.WORD).id;
  const created = await client.documents.create(projectId, 'Config doc');
  documentId = created.id;
  await client.texts.create(textLayer.id, documentId, BODY);
  const raw = await client.documents.get(documentId, true);
  const TEXT = raw.textLayers.find((l) => roleOf(l) === ROLES.BASELINE).text.id;
  const cps = [...BODY];
  const words = [];
  let i = 0;
  while (i < cps.length) {
    while (i < cps.length && /\s/.test(cps[i])) i++;
    if (i >= cps.length) break;
    const begin = i;
    while (i < cps.length && !/\s/.test(cps[i])) i++;
    words.push({ begin, end: i });
  }
  await client.tokens.bulkCreate([
    { tokenLayerId: layer(ROLES.SENTENCE).id, text: TEXT, begin: 0, end: cpLength(BODY) },
  ]);
  await client.tokens.bulkCreate(
    words.map((w) => ({ tokenLayerId: wordLayerId, text: TEXT, ...w })),
  );
  // No morphemes seeded on purpose: reconcile-on-open heals one per annotatable word (B11-03).
  const seeded = await client.documents.get(documentId, true);
  const wl = seeded.textLayers
    .find((l) => roleOf(l) === ROLES.BASELINE)
    .tokenLayers.find((l) => l.id === wordLayerId);
  ids.w = words.map((x) => wl.tokens.find((t) => t.begin === x.begin).id);
  await client.projects.addReader(projectId, 'alpha-reader@x.com');
});

test.afterAll(async () => {
  if (projectId) await client.projects.delete(projectId).catch(() => {});
  if (vocabId) await client.vocabLayers.delete(vocabId).catch(() => {});
});

async function openAnalyze(page, auth) {
  if (page.url() !== 'about:blank') await page.goto('about:blank');
  await seedAuth(page, auth);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=analyze`);
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  await page.waitForLoadState('networkidle');
}
const opener = (page, tokenId) => page.locator(`button[data-vocab-opener="${tokenId}"]`);
const createRow = (page) => page.locator('.igt-vocab-pop__create');
async function createFormFor(page, tokenId) {
  await opener(page, tokenId).click();
  await page.locator('.igt-vocab-pop').waitFor({ state: 'visible' });
  const text = (await createRow(page).innerText()).replace(/\s+/g, ' ').trim();
  await page.keyboard.press('Escape');
  return text;
}

test('B11-01/02/03 + B5-03/01: unicode-punctuation rule with a `?` whitelist', async ({ page }) => {
  await openAnalyze(page);
  // Ignored tokens: inert column, hover title, no opener, no healed morpheme.
  for (const k of ['dots', 'dollar']) {
    await expect(opener(page, ids.w[W[k]])).toHaveCount(0);
    await expect(
      page.locator(`[title="${BODY.split(' ')[W[k]]}: excluded from annotation"]`),
    ).toHaveCount(1);
  }
  // Whitelisted `?` and the emoji are annotatable: opener + a healed morpheme form cell.
  for (const k of ['q', 'emoji']) {
    await expect(opener(page, ids.w[W[k]])).toHaveCount(1);
    await expect(page.locator(`.igt-morph-field[data-word="${ids.w[W[k]]}"]`)).toHaveCount(1);
  }
  const raw = await client.documents.get(documentId, true);
  const ml = raw.textLayers[0].tokenLayers.find((l) => roleOf(l) === ROLES.MORPHEME);
  expect(ml.tokens.length, 'one healed morpheme per annotatable word (5 of 7)').toBe(5);
  // Create-row trimming follows the same rule: edges trimmed, whitelist is whole-token only.
  expect(await createFormFor(page, ids.w[W.derechos])).toMatch(/Create "derechos"/);
  expect(await createFormFor(page, ids.w[W.que])).toMatch(/Create "Qué"/);
  expect(await createFormFor(page, ids.w[W.q])).toMatch(/Create "\?"/);
});

test('B5-12: a blacklist rule trims nothing; listed tokens are inert', async ({ page }) => {
  await client.tokenLayers.setConfig(wordLayerId, 'igt', 'ignoredTokens', {
    type: 'blacklist',
    blacklist: ['...'],
  });
  await openAnalyze(page);
  await expect(opener(page, ids.w[W.dots])).toHaveCount(0);
  await expect(opener(page, ids.w[W.dollar])).toHaveCount(1);
  expect(await createFormFor(page, ids.w[W.derechos])).toMatch(/Create "derechos\."/);
  expect(await createFormFor(page, ids.w[W.que])).toMatch(/Create "¿Qué\?"/);
});

test('B5-13: no ignore config at all: nothing is ignored, nothing trimmed', async ({ page }) => {
  await client.tokenLayers.deleteConfig(wordLayerId, 'igt', 'ignoredTokens');
  await openAnalyze(page);
  await expect(opener(page, ids.w[W.dots])).toHaveCount(1);
  expect(await createFormFor(page, ids.w[W.derechos])).toMatch(/Create "derechos\."/);
  // Restore the original rule for any later run in this file.
  await client.tokenLayers.setConfig(wordLayerId, 'igt', 'ignoredTokens', {
    type: 'unicodePunctuation',
    whitelist: ['?'],
  });
});

test('C2-01: the Create Document dialog needs a name and submits on Enter', async ({ page }) => {
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}`);
  await page.getByRole('button', { name: 'Create Document' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const submit = dialog.getByRole('button', { name: /Create Document/ });
  await expect(submit).toBeDisabled();
  await dialog.getByRole('textbox').first().fill('Enter-made doc');
  await expect(submit).toBeEnabled();
  await dialog.getByRole('textbox').first().press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Enter-made doc').first()).toBeVisible();
  const docs = await client.projects.listDocuments(projectId);
  expect(docs.some((d) => d.name === 'Enter-made doc')).toBe(true);
});

test('C2-03 + B1-10: a reader gets no Create button and a read-only editor', async ({ page }) => {
  const { token } = await PlaidClient.login(CORE, 'alpha-reader@x.com', 'alpha-pass-1');
  const auth = {
    token,
    userId: 'alpha-reader@x.com',
    displayName: 'alpha-reader@x.com',
    isAdmin: false,
  };
  await seedAuth(page, auth);
  await page.goto(`/#/projects/${projectId}`);
  await expect(page.getByText('Config doc')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create Document' })).toHaveCount(0);
  await openAnalyze(page, auth);
  await expect(page.locator('.igt-island')).toHaveClass(/igt-island--readonly/);
  await expect(page.locator('.igt-vocab__opener')).toHaveCount(0);
  await expect(page.locator('.igt-field:not([disabled])')).toHaveCount(0);
});
