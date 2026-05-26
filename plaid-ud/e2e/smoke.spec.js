import { test, expect, seedAuth, collectClientErrors } from './fixtures.js';
import { getFixture } from './fixture.js';

test('text editor loads for a 3-layer UD doc', async ({ page }) => {
  const { projectId, documentId } = await getFixture();
  const { errors, failures, apiCalls } = collectClientErrors(page);
  await seedAuth(page);

  await page.goto(`/#/projects/${projectId}/documents/${documentId}/edit`);
  await page.waitForLoadState('networkidle');

  // Give the loading->loaded transition a beat in case data is still settling.
  await page.waitForTimeout(500);

  console.log('--- url ---', page.url());
  console.log('--- api calls ---');
  for (const c of apiCalls) console.log(`${c.status} ${c.method} ${c.url.replace('http://localhost:5173', '')}`);
  console.log('--- failed requests ---');
  for (const f of failures) console.log(JSON.stringify(f));
  console.log('--- console errors ---');
  for (const e of errors) console.log(JSON.stringify(e));

  // What does the user actually see?
  const visibleText = await page.locator('body').innerText();
  console.log('--- visible text (first 800 chars) ---');
  console.log(visibleText.slice(0, 800));

  await expect.soft(page).toHaveURL(/edit$/);
  await expect.soft(page.getByText(/Failed to load/)).toHaveCount(0);
  await expect.soft(page.getByText(/^Loading\b/)).toHaveCount(0);
});
