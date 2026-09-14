import { test, expect, seedAuth, collectClientErrors } from './fixtures.js';
import { getFixture, makeClient } from './fixtureProject.js';

// Exercises the vanilla interlinear island end-to-end against live plaid-core:
// renders the grid, edits a morpheme gloss, and verifies the edit round-trips
// through IgtDocument -> server -> reload -> re-render.
//
// The document is the SHARED fixture, reused by name across runs and by every
// other spec in this directory, so the one test here that writes puts the gloss
// back. It did not, and left TESTGLOSS on the first morpheme for good.

let projectId;
let documentId;
// The Gloss the first morpheme carried before the edit, and null when it
// carried none, which is the state a freshly built fixture is in.
let originalGloss;

const client = () => makeClient();

// The Gloss span on the first morpheme of the document, which is the cell the
// edit below lands in.
const glossSpan = async () => {
  const raw = await client().documents.get(documentId, true);
  const text = raw.textLayers[0];
  const morphemes = text.tokenLayers.find((t) => t.config?.plaid?.role === 'morpheme');
  const gloss = (morphemes.spanLayers || []).find((s) => s.name === 'Gloss');
  const first = morphemes.tokens.slice().sort((a, b) => a.begin - b.begin)[0];
  return (gloss.spans || []).find((s) => (s.tokens || []).some((t) => (t?.id ?? t) === first.id));
};

async function openAnalyze(page) {
  await page.goto(`/#/projects/${projectId}/documents/${documentId}`);
  await page.waitForLoadState('networkidle');
  await page.getByRole('tab', { name: 'Analyze' }).click();
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
}

test.beforeAll(async () => {
  ({ projectId, documentId } = await getFixture());
  originalGloss = (await glossSpan()) || null;
});

test.afterAll(async () => {
  const span = await glossSpan();
  if (!span) return;
  const c = client();
  const back = originalGloss
    ? c.spans.update(span.id, originalGloss.value)
    : c.spans.delete(span.id);
  await back.catch((e) => console.error('cleanup failed:', e.message));
});

test('interlinear grid renders token + morpheme columns', async ({ page }) => {
  const diag = collectClientErrors(page);
  await seedAuth(page);
  await openAnalyze(page);

  const cols = page.locator('.igt-island .igt-token-col');
  expect(await cols.count()).toBeGreaterThan(1);
  // morpheme form fields present (one per seeded morpheme)
  expect(await page.locator('.igt-island .igt-morph-field').count()).toBeGreaterThan(0);
  // row labels include the configured fields
  await expect.soft(page.locator('.igt-row-label', { hasText: 'Part of Speech' })).toBeVisible();

  console.log('--- failed requests ---');
  for (const f of diag.failures) console.log(JSON.stringify(f));
  console.log('--- console errors ---');
  for (const e of diag.errors) console.log(JSON.stringify(e));
  expect.soft(diag.failures, 'no API failures while rendering').toEqual([]);
});

test('editing a morpheme gloss persists across reload', async ({ page }) => {
  const diag = collectClientErrors(page);
  await seedAuth(page);
  await openAnalyze(page);

  const cell = page.locator('.igt-field[data-cell-key^="ma:"]').first();
  await cell.click();
  await cell.fill('TESTGLOSS');
  await cell.press('Enter'); // commit on blur

  // The grid patches its own state before awaiting the server, so what says the
  // write landed is the server.
  await expect.poll(async () => (await glossSpan())?.value, { timeout: 15_000 }).toBe('TESTGLOSS');

  console.log('--- failed requests after edit ---');
  for (const f of diag.failures) console.log(JSON.stringify(f));
  expect.soft(diag.failures, 'no API failures on edit').toEqual([]);

  // Reload the whole page and re-open analyze: the value must survive the
  // full server round-trip + re-derivation.
  await openAnalyze(page);
  const reloaded = page.locator('.igt-field[data-cell-key^="ma:"]').first();
  await expect(reloaded).toHaveValue('TESTGLOSS');
});
