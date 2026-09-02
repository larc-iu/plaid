import PlaidClient, { ROLES } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';
import { getFixture } from './fixture.js';

// Reconcile-on-open WRITES (it seeds morphemes and deletes orphans), so the
// document must not be open and editable while it runs. Seed an orphan
// morpheme so the initial pass has real work to do, hold its batch open, and
// check that the editor is a spinner — with no tab strip to escape through —
// for as long as the repair is in flight.
//
// The seeded orphan is self-cleaning: reconcile deletes it, which is the very
// repair under test.
test('the initial repair holds the document behind a spinner', async ({ page }) => {
  const { projectId, documentId } = await getFixture();
  const client = new PlaidClient('http://localhost:8085', readToken().token);
  const project = await client.projects.get(projectId);
  const tokenLayers = project.textLayers.flatMap((tl) => tl.tokenLayers || []);
  const morphemeLayer = tokenLayers.find((tl) => tl.config?.plaid?.role === ROLES.MORPHEME);
  const wordLayer = tokenLayers.find((tl) => tl.config?.plaid?.role === ROLES.WORD);

  const doc = await client.documents.get(documentId, true);
  const text = doc.textLayers.map((tl) => tl.text).find(Boolean);
  const words = doc.textLayers
    .flatMap((tl) => tl.tokenLayers || [])
    .filter((tl) => tl.id === wordLayer.id)
    .flatMap((tl) => tl.tokens || []);
  // An orphan is a morpheme whose extent matches no word EXACTLY (morphemes are
  // full-width here; segmentation lives in span values). Shrink a real word's
  // extent by one character until the result matches nothing.
  const wordExtents = new Set(words.map((w) => `${w.begin}:${w.end}`));
  const base = words.find((w) => w.end - w.begin > 1);
  expect(base, 'fixture has a word longer than one character').toBeTruthy();
  let end = base.end - 1;
  while (end > base.begin && wordExtents.has(`${base.begin}:${end}`)) end -= 1;
  const orphan = await client.tokens.create(morphemeLayer.id, text.id, base.begin, end, 1);

  let cleaned = false;
  try {
    // Hold the heal's batch open long enough to observe the gate. Reconcile is
    // the only thing batching at this point in the page's life.
    await page.route('**/api/v1/batch', async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    });

    await seedAuth(page);
    await page.goto(`/#/projects/${projectId}/documents/${documentId}`);

    // The gate is up: spinner shown, and no tab is reachable to edit through.
    await expect(page.getByText('Checking this document…')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('tab', { name: /Analyze/ })).toHaveCount(0);
    // The chrome above it stays put, so the page never blanks.
    await expect(page.getByRole('heading', { name: 'Sample IGT Document' })).toBeVisible();

    // ...and comes down once the repair lands.
    await expect(page.getByText('Checking this document…')).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByRole('tab', { name: /Analyze/ })).toBeVisible();

    // The repair the gate was covering for actually happened.
    const after = await client.documents.get(documentId, true);
    const morphemeIds = after.textLayers
      .flatMap((tl) => tl.tokenLayers || [])
      .filter((tl) => tl.id === morphemeLayer.id)
      .flatMap((tl) => (tl.tokens || []).map((t) => t.id));
    expect(morphemeIds).not.toContain(orphan.id);
    cleaned = true;
  } finally {
    if (!cleaned) await client.tokens.delete(orphan.id).catch(() => {});
  }
});
