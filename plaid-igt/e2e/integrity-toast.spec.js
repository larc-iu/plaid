import PlaidClient, { ROLES } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';
import { getFixture } from './fixture.js';

// TEST_PLAN C12-03: an un-healable integrity finding (inverted alignment
// timing) surfaces as ONE sticky toast with a "Copy details" action on the
// document, and that toast leaves with the document instead of following the
// user to other pages.
test('integrity toast shows on the document and leaves with it', async ({ page }) => {
  const { projectId, documentId } = await getFixture();
  const client = new PlaidClient('http://localhost:8085', readToken().token);
  const project = await client.projects.get(projectId);
  const alignLayer = project.textLayers
    .flatMap((tl) => tl.tokenLayers || [])
    .find((tl) => tl.config?.plaid?.role === ROLES.TIME_ALIGNMENT);
  const doc = await client.documents.get(documentId, true);
  const text = doc.textLayers.map((tl) => tl.text).find(Boolean);
  await client.tokens.bulkCreate([
    {
      tokenLayerId: alignLayer.id,
      text: text.id,
      begin: 0,
      end: 3,
      metadata: { timeBegin: 3, timeEnd: 1 },
    },
  ]);
  try {
    await seedAuth(page);
    await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=analyze`);
    const toast = page.getByText('Data integrity issue detected');
    await expect(toast).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/end time \(1\) before start time \(3\)/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy details' })).toBeVisible();

    await page.goto('/#/projects');
    await expect(page.getByRole('heading', { name: /Projects/ })).toBeVisible();
    await expect(toast).toHaveCount(0, { timeout: 5_000 });
  } finally {
    const after = await client.documents.get(documentId, true);
    for (const tl of after.textLayers) {
      for (const tk of tl.tokenLayers || []) {
        if (tk.id !== alignLayer.id) continue;
        for (const t of tk.tokens || []) {
          if (t.metadata?.timeBegin === 3 && t.metadata?.timeEnd === 1)
            await client.tokens.delete(t.id);
        }
      }
    }
  }
});
