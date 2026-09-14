import {
  test,
  expect,
  seedAuth,
  collectClientErrors,
  reportDiagnostics,
  BASE_URL,
} from './fixtures.js';
import { getFixture } from './fixtureProject.js';

// A diagnostic smoke test, the same shape as plaid-igt's: drive a surface
// against live plaid-core and print every API failure and console error it
// produced. Assertions are soft so the diagnostics reach the log either way.
//
// The `waitForTimeout` is not a gate on an assertion, which would retry anyway:
// it is settling time for `failures`, which is a plain array read once. A late
// 500 that arrives after the read is a failure this test exists to see.

test('text editor loads for a 3-layer UD doc', async ({ page }) => {
  const { projectId, documentId } = await getFixture();
  const diag = collectClientErrors(page);
  await seedAuth(page);

  await page.goto(`/#/projects/${projectId}/documents/${documentId}/edit`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);

  console.log('--- url ---', page.url());
  reportDiagnostics('text editor', diag, { calls: BASE_URL });

  // What does the user actually see?
  const visibleText = await page.locator('body').innerText();
  console.log('--- visible text (first 800 chars) ---');
  console.log(visibleText.slice(0, 800));

  await expect.soft(page).toHaveURL(/edit$/);
  await expect.soft(page.getByText(/Failed to load/)).toHaveCount(0);
  await expect.soft(page.getByText(/^Loading\b/)).toHaveCount(0);
});
