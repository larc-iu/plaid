// An Arabic sentence in the annotation grid, in a real browser.
//
// This is the one check no unit test can make. happy-dom lays nothing out, so
// "the first token is on the right" is a question only a layout engine
// answers, and so is the thing this feature leans hardest on: the dependency
// arcs are drawn from positions MEASURED off the DOM, so they mirror with the
// flex container and nothing in the arc code knows about direction at all. If
// that assumption is wrong, it is wrong here and nowhere else.
import { test, expect, seedAuth } from './fixtures.js';
import { seedUdDoc } from './seedUdDoc.js';

// "قرأ الولد الكتاب": read.PST the.boy the.book.
const BODY = 'قرأ الولد الكتاب';
const WORDS = [
  [0, 3],
  [4, 9],
  [10, 16],
];

const S = {};

test.beforeAll(async () => {
  Object.assign(S, await seedUdDoc(`RTL ${Date.now()}`, BODY, WORDS));
  const { client, layers, morphIds } = S;
  // A lemma on every word, so each has a cell to focus, plus one relation so
  // there is an arc to look at.
  for (let i = 0; i < morphIds.length; i++) {
    await client.spans.create(layers.lemma, [morphIds[i]], BODY.slice(...WORDS[i]));
  }
});

test.afterAll(async () => {
  if (S.client && S.projectId) {
    await S.client.projects
      .delete(S.projectId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

const open = async (page) => {
  await seedAuth(page);
  await page.goto(`/#/projects/${S.projectId}/documents/${S.documentId}/annotate`);
  await expect(page.locator('.sentence-container').first()).toBeVisible({ timeout: 15000 });
};

test('the first token of an Arabic sentence is on the right', async ({ page }) => {
  await open(page);
  await expect(page.locator('.sentence-container').first()).toHaveAttribute('dir', 'rtl');

  const cols = page.locator('.sentence-container .token-column');
  await expect(cols).toHaveCount(3);
  const boxes = [];
  for (let i = 0; i < 3; i++) boxes.push(await cols.nth(i).boundingBox());
  expect(boxes[0].x).toBeGreaterThan(boxes[1].x);
  expect(boxes[1].x).toBeGreaterThan(boxes[2].x);
});

test('the labels column sits on the right, past the first token', async ({ page }) => {
  await open(page);
  const labels = await page.locator('.sentence-container .labels-column').first().boundingBox();
  const firstCol = await page.locator('.sentence-container .token-column').first().boundingBox();
  expect(labels.x).toBeGreaterThan(firstCol.x);
});

test('the tree is drawn over the words where they actually are', async ({ page }) => {
  await open(page);
  // The arcs take no part in the flip themselves: they are measured. What that
  // buys is checked here, by putting the SVG over the same span of the page the
  // token columns occupy.
  const svg = await page.locator('.sentence-container svg').first().boundingBox();
  const cols = page.locator('.sentence-container .token-column');
  const first = await cols.nth(0).boundingBox();
  const last = await cols.nth(2).boundingBox();
  expect(svg.x).toBeLessThanOrEqual(last.x + 1);
  expect(svg.x + svg.width).toBeGreaterThanOrEqual(first.x - 1);
});

test('arrow keys walk the sentence rightwards', async ({ page }) => {
  await open(page);
  const lemmas = page.locator('input[id$="-lemma"]');
  await lemmas.nth(0).click();
  const from = await lemmas.nth(0).boundingBox();

  // Both directions in one gesture. The cell holds an Arabic lemma, so it is
  // an RTL box whose logical END is at its visual LEFT: End puts the caret
  // there, and ArrowLeft from there is pressing out of the field, towards the
  // next token, which in this sentence is also to the left. The box proves the
  // second half: this cannot pass on a grid that never flipped.
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft');
  await expect(lemmas.nth(1)).toBeFocused();
  const to = await lemmas.nth(1).boundingBox();
  expect(to.x).toBeLessThan(from.x);

  // And back: Home is the logical start, at this cell's visual right.
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await expect(lemmas.nth(0)).toBeFocused();
});

test('an arrow inside a value moves the caret rather than leaving the cell', async ({ page }) => {
  await open(page);
  const lemma = page.locator('input[id$="-lemma"]').first();
  await lemma.click();
  // One step in from the logical end, so the next press has text to move
  // through. Without the cell's own direction in the rule, this key would
  // jump out of the field instead.
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowRight');
  await expect(lemma).toBeFocused();
});

test('a Latin lemma reads left to right inside the flipped grid', async ({ page }) => {
  await open(page);
  // Layout takes the document's direction, a value takes its own.
  const cell = page.locator('input[id$="-upos"]').first();
  await cell.click();
  await cell.fill('NOUN');
  expect(await cell.evaluate((el) => getComputedStyle(el).direction)).toBe('ltr');
});
