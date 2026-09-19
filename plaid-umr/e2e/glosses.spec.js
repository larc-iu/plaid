import { test, expect, seedAuth } from './fixtures.js';
import { getGlossedFixture } from './fixtureProject.js';

// An IGT-shaped project: the morphemes and their glosses sit under the
// words, the translation runs as a row, and the export writes them as the
// file's gloss lines, all through the proposed mapping.
test("glosses from the project's layers show under the words and export", async ({ page }) => {
  const { projectId, documentId } = await getGlossedFixture();
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}/annotate`);
  const block = page.locator('.umr-block').first();
  await expect(block.locator('.umr-node').first()).toBeVisible();
  // "left" is leav-e: two morphemes, two glosses, under one word.
  const left = block.locator('.umr-word').nth(1);
  await expect(left.locator('.umr-word-gloss').nth(0)).toHaveText('lef t');
  await expect(left.locator('.umr-word-gloss').nth(1)).toHaveText('leave PST');
  await expect(block.locator('.umr-ilg-items')).toHaveText('Lindsay went off to have lunch.');
  await block.screenshot({ path: process.env.UMR_GLOSS_SHOT || 'test-results/glosses.png' });

  await page.goto(`/#/projects/${projectId}/documents/${documentId}/export`);
  const out = page.locator('pre, textarea').first();
  await expect(out).toContainText('Morphemes: Lindsay lef t in order to eat lunch .');
  await expect(out).toContainText('Morpheme Gloss (en): Lindsay leave PST in order to eat lunch .');
  await expect(out).toContainText('Sentence Gloss (en): Lindsay went off to have lunch.');
});
