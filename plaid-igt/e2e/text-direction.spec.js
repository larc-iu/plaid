import PlaidClient, { ROLES, cpLength } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';

// An Arabic document, in a real browser.
//
// This is the one check no unit test can make. happy-dom and jsdom lay nothing
// out, so "the first word is on the right" is a question only a layout engine
// answers, and every part of the feature that can go wrong goes wrong in the
// layout: the flipped flex order, the sticky label column, the hanging indent
// of a wrapped band, the caret walking one way while the focus walks the other.
//
// Throwaway document in "E2E IGT Fixture", deleted afterwards.

const CORE = 'http://localhost:8085';
const roleOf = (l) => l?.config?.plaid?.role;

// "قرأ الولد الكتاب": read.PST the.boy the.book.
const BODY = 'قرأ الولد الكتاب';

let client;
let projectId;
let documentId;
let ids = {};

test.beforeAll(async () => {
  client = new PlaidClient(CORE, readToken().token);
  const project = (await client.projects.list()).find((p) => p.name === 'E2E IGT Fixture');
  if (!project) throw new Error('run node e2e/fixtureProject.js first');
  projectId = project.id;
  const full = await client.projects.get(projectId);
  const textLayer = full.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const layer = (role) => textLayer.tokenLayers.find((l) => roleOf(l) === role);
  const created = await client.documents.create(projectId, `text-direction ${Date.now()}`);
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
  const tl = seeded.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const ml = tl.tokenLayers.find((l) => roleOf(l) === ROLES.MORPHEME);
  ids = { m: words.map((x) => ml.tokens.find((t) => t.begin === x.begin).id) };
});

test.afterAll(async () => {
  if (documentId) await client.documents.delete(documentId).catch(() => {});
});

const openTab = async (page, tab) => {
  // A goto to the SAME hash URL is a same-document navigation (no reload), so
  // bounce through about:blank to guarantee a fresh load of the document.
  if (page.url() !== 'about:blank') await page.goto('about:blank');
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=${tab}`);
  await page.waitForLoadState('networkidle');
};

const gloss = (page, i) => page.locator(`.igt-field[data-cell-key="ma:${ids.m[i]}:Gloss"]`);

test('the first word of an Arabic sentence is on the right', async ({ page }) => {
  await openTab(page, 'analyze');
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });

  await expect(page.locator('.igt-sentence').first()).toHaveAttribute('dir', 'rtl');

  const cols = page.locator('.igt-sentence .igt-token-col');
  await expect(cols).toHaveCount(3);
  const boxes = [];
  for (let i = 0; i < 3; i++) boxes.push(await cols.nth(i).boundingBox());
  // Document order is sentence order, and sentence order now runs rightwards.
  expect(boxes[0].x).toBeGreaterThan(boxes[1].x);
  expect(boxes[1].x).toBeGreaterThan(boxes[2].x);
});

test('the row labels stick to the right edge, past the last column', async ({ page }) => {
  await openTab(page, 'analyze');
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });

  const labels = await page.locator('.igt-sentence .igt-labels').first().boundingBox();
  const firstCol = await page.locator('.igt-sentence .igt-token-col').first().boundingBox();
  expect(labels.x).toBeGreaterThan(firstCol.x);
});

test('the chrome does not move with the grid', async ({ page }) => {
  await openTab(page, 'analyze');
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  // The toolbar is outside the block that flips, and reads left to right like
  // every other piece of the app.
  const dir = await page
    .locator('.igt-toolbar')
    .first()
    .evaluate((el) => getComputedStyle(el).direction);
  expect(dir).toBe('ltr');
});

test('Enter and the arrows walk the sentence rightwards', async ({ page }) => {
  await openTab(page, 'analyze');
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });

  // Enter means the next cell in READING order, which here is the one to the
  // left. Its box proves it, so this cannot pass on a grid that never flipped.
  await gloss(page, 0).click();
  const from = await gloss(page, 0).boundingBox();
  await page.keyboard.press('Enter');
  await expect(gloss(page, 1)).toBeFocused();
  const to = await gloss(page, 1).boundingBox();
  expect(to.x).toBeLessThan(from.x);

  // ArrowLeft out of an empty cell goes the same way Enter did. ArrowRight
  // comes back.
  await page.keyboard.press('ArrowLeft');
  await expect(gloss(page, 2)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(gloss(page, 1)).toBeFocused();
});

test('a gloss typed in Latin reads left to right inside the flipped grid', async ({ page }) => {
  await openTab(page, 'analyze');
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });

  // The whole rule in one assertion: layout takes the document's direction, a
  // value takes its own.
  await gloss(page, 0).click();
  await page.keyboard.type('read.PST');
  await expect(gloss(page, 0)).toHaveJSProperty('dir', 'auto');
  const dir = await gloss(page, 0).evaluate((el) => getComputedStyle(el).direction);
  expect(dir).toBe('ltr');
});

test('the baseline reads and types right to left', async ({ page }) => {
  await openTab(page, 'baseline');

  // What the tab opens on: the text, read.
  const shown = page.locator('.whitespace-pre-wrap').first();
  await shown.waitFor({ state: 'visible' });
  expect(await shown.evaluate((el) => getComputedStyle(el).direction)).toBe('rtl');

  // And the box it is edited in, where direction decides where the caret goes.
  await page.getByRole('button', { name: 'Edit Text' }).click();
  const box = page.locator('#baseline-text');
  await box.waitFor({ state: 'visible' });
  expect(await box.evaluate((el) => getComputedStyle(el).direction)).toBe('rtl');
});
