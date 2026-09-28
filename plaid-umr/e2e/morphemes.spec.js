import { test, expect, seedAuth } from './fixtures.js';
import { getGlossedFixture } from './fixtureProject.js';

// Morphemes in the shape plaid-igt writes them: every morpheme of a word
// covers the WHOLE word, ordered by `precedence`, with a segmented word's
// forms in `metadata.form`. "left" is two morphemes over "left" whose forms
// are lef and t, and "." was never analyzed, so it has no morpheme token at
// all. Reading the text under a morpheme's offsets would show "left" twice.
test('morphemes over their whole word show and export their own forms', async ({ page }) => {
  const { projectId, documentId } = await getGlossedFixture();
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}/annotate`);
  const block = page.locator('.umr-block').first();
  await expect(block.locator('.umr-node').first()).toBeVisible();

  await expect(block.locator('.umr-morph-form')).toHaveText([
    'Lindsay',
    'lef',
    't',
    'in',
    'order',
    'to',
    'eat',
    'lunch',
    '.',
  ]);
  const left = block.locator('.umr-word').nth(1);
  await expect(left.locator('.umr-word-text')).toHaveText('left');
  await expect(left.locator('.umr-morph-col')).toHaveCount(2);
  // A word glossed as it stands is its one morpheme, which reads as the word.
  const eat = block.locator('.umr-word').nth(5);
  await expect(eat.locator('.umr-morph-form')).toHaveText(['eat']);
  await expect(eat.locator('.umr-morph-col .umr-word-gloss').nth(1)).toHaveText('eat');
  // A word nobody analyzed is its own morpheme, with no gloss under it.
  const stop = block.locator('.umr-word').nth(7);
  await expect(stop.locator('.umr-morph-col')).toHaveCount(1);
  await expect(stop.locator('.umr-morph-form')).toHaveText(['.']);
  await expect(stop.locator('.umr-morph-col .umr-word-gloss').nth(1)).toHaveText('_');

  await page.goto(`/#/projects/${projectId}/documents/${documentId}/export`);
  const out = page.locator('pre, textarea').first();
  await expect(out).toContainText('Words: Lindsay left in order to eat lunch .');
  await expect(out).toContainText('Morphemes: Lindsay lef t in order to eat lunch .');
  await expect(out).toContainText('Morpheme Gloss (en): Lindsay leave PST in order to eat lunch _');
  await expect(out).not.toContainText('left left');
});
