import { test, expect, seedAuth, collectClientErrors, cleanDiagnostics } from './fixtures.js';
import { getFixture } from './fixtureProject.js';

// The read-only canvas over the imported English corpus: every sentence
// block draws its nodes over its words, with edge labels once measured.
test.describe('canvas', () => {
  test('draws the imported graphs', async ({ page }) => {
    const { projectId, documentId } = await getFixture();
    await seedAuth(page);
    const diag = collectClientErrors(page);
    await page.goto(`/#/projects/${projectId}/documents/${documentId}/annotate`);

    const firstBlock = page.locator('.umr-block').first();
    await expect(firstBlock).toBeVisible();
    await expect(firstBlock.locator('.umr-node').first()).toBeVisible();
    // Positions come from a measuring pass; once placed, the labels appear.
    await expect(firstBlock.locator('.umr-edge-label').first()).toBeVisible();

    // The deep link: ?sent=2&var=... scrolls to sentence 2 and focuses the node.
    const secondVar = await page
      .locator('.umr-block')
      .nth(1)
      .locator('.umr-node')
      .first()
      .getAttribute('data-node-var');
    await page.goto(
      `/#/projects/${projectId}/documents/${documentId}/annotate?sent=2&var=${secondVar}`,
    );
    await expect(page.locator(`[data-node-var="${secondVar}"]`)).toBeFocused();

    // A writer sees the drafting service's button beside History.
    await expect(page.getByRole('button', { name: 'Draft' })).toBeVisible();

    const blocks = await page.locator('.umr-block').count();
    expect(blocks).toBeGreaterThan(1);
    const words = await firstBlock.locator('.umr-word').count();
    expect(words).toBeGreaterThan(0);

    // One block alone, tokens and gloss lines included, for a look. Which
    // one is UMR_SHOT_INDEX's (1-based), the first by default.
    const shotIndex = Number(process.env.UMR_SHOT_INDEX || 1) - 1;
    await page
      .locator('.umr-block')
      .nth(shotIndex)
      .screenshot({ path: process.env.UMR_SHOT || 'test-results/canvas.png' });

    const clean = cleanDiagnostics(diag);
    expect(clean.failures, JSON.stringify(clean.failures, null, 2)).toEqual([]);
    expect(clean.errors, JSON.stringify(clean.errors, null, 2)).toEqual([]);
  });
});
