// The Annotate tab pages its sentences, 25 to a page.
//
// A dependency tree is a tall row, and a treebank document runs to hundreds of
// sentences, so the tab used to render every one of them into one scroll. What
// this spec pins is not the paging itself but the two things paging can break:
// a sentence is still reachable by the deep link every other screen hands out,
// and what a sentence is called does not change with the page it is on.
import { test, expect, seedAuth } from './fixtures.js';
import { seedUdDoc } from './seedUdDoc.js';

const MACHINE = { prov: 'inferred', provSource: 'service:test' };

const COUNT = 30; // more than one page of 25, and a short second page
const WORD = 'word';
// "word word word …", one word per sentence, so the spans are easy to compute.
const BODY = Array.from({ length: COUNT }, () => WORD).join(' ');
const SPANS = Array.from({ length: COUNT }, (_, i) => [i * 5, i * 5 + WORD.length]);
// Sentences must TILE the body (the layer is partitioning), so each one carries
// its word plus the space after it.
const SENTENCES = Array.from({ length: COUNT }, (_, i) => [
  i * 5,
  i === COUNT - 1 ? BODY.length : (i + 1) * 5,
]);

const S = {};

test.beforeAll(async () => {
  Object.assign(S, await seedUdDoc(`Paging ${Date.now()}`, BODY, SPANS, SENTENCES));
  const { client, layers, morphIds } = S;
  // Two words that still need a look, one on each page, so the sweep between
  // them has to cross the boundary. Nothing in between, so a sweep that stops
  // at the end of the page is unmistakable.
  for (const i of [0, COUNT - 1]) {
    await client.spans.create(layers.lemma, [morphIds[i]], WORD);
    await client.spans.create(layers.upos, [morphIds[i]], 'NOUN', { ...MACHINE });
  }
});

test.afterAll(async () => {
  if (S.client && S.projectId) {
    await S.client.projects
      .delete(S.projectId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

const open = async (page, query = '') => {
  await seedAuth(page);
  // The page is remembered per document, so a test that did not ask for a
  // particular one starts at the first. Once per test, not once per
  // navigation: addInitScript runs on every load, and a test that RELOADS to
  // check the page was remembered would otherwise clear it on the way in.
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-cleared-annotate-page')) return;
    sessionStorage.setItem('e2e-cleared-annotate-page', '1');
    for (const key of Object.keys(localStorage)) {
      if (key.includes('_list_page:ud-annotate')) localStorage.removeItem(key);
    }
  });
  await page.goto(`/#/projects/${S.projectId}/documents/${S.documentId}/annotate${query}`);
  await expect(page.locator('.sentence-container').first()).toBeVisible({ timeout: 15000 });
};

// Rows are virtualized, so only the ones scrolled to are really rendered.
// The wrapper holds the slot either way, which is what "how many are on this
// page" has to be counted from.
const slots = (page) => page.locator('[data-sentence-row]');

test('a page holds 25 sentences, and the pager says which', async ({ page }) => {
  await open(page);

  await expect(page.getByText(`1–25 of ${COUNT}`).first()).toBeVisible();
  await expect(slots(page)).toHaveCount(25);
  await expect(page.locator('.sentence-id').first()).toHaveText('1');

  await page.getByRole('button', { name: 'Next page' }).first().click();
  await expect(page.getByText(`26–${COUNT} of ${COUNT}`).first()).toBeVisible();
  await expect(slots(page)).toHaveCount(COUNT - 25);
  // Numbering is the document's, not the page's: sentence 26 is sentence 26.
  await expect(page.locator('.sentence-id').first()).toHaveText('26');
});

test('the deep link reaches a sentence on a later page', async ({ page }) => {
  // Search results, the validation report and the assistant all link here by
  // sentence token id. Before paging, the row was always in the DOM; now the
  // editor has to turn to its page first or the link lands on nothing.
  const target = S.sentenceIds[27]; // sentence 28, on page 2
  await open(page, `?sent=${target}`);

  await expect(page.getByText(`26–${COUNT} of ${COUNT}`).first()).toBeVisible();
  const row = page.locator(`[data-sentence-row="${target}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator('.sentence-id')).toHaveText('28');
});

test('the page a document was left on is where it opens', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Last page' }).first().click();
  await expect(page.getByText(`26–${COUNT} of ${COUNT}`).first()).toBeVisible();

  // Not `open`, which clears the remembered page on purpose.
  await page.reload();
  await expect(page.locator('.sentence-container').first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(`26–${COUNT} of ${COUNT}`).first()).toBeVisible();
});

test('the review sweep crosses a page boundary', async ({ page }) => {
  // Ctrl/Cmd+Shift+Down walks the whole DOCUMENT, and the word it lands on may
  // be on a page that is not rendered. Before this, the hop scrolled to a row
  // that did not exist and the sweep dead-ended at the last sentence of page 1.
  await open(page);
  await page.locator(`[id="${S.morphIds[0]}-upos"]`).focus();

  await page.keyboard.press('Control+Shift+ArrowDown');
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.id), { timeout: 8000 })
    .toBe(`${S.morphIds[COUNT - 1]}-upos`);
  // It turned the page to get there.
  await expect(page.getByText(`26–${COUNT} of ${COUNT}`).first()).toBeVisible();

  // And back the other way.
  await page.keyboard.press('Control+Shift+ArrowUp');
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.id), { timeout: 8000 })
    .toBe(`${S.morphIds[0]}-upos`);
  await expect(page.getByText(`1–25 of ${COUNT}`).first()).toBeVisible();
});
