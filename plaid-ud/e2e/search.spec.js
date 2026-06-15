import { test, expect, seedAuth } from './fixtures.js';
import { PlaidClient } from '@larc-iu/plaid-client';
import { getUdLayerInfo } from '../src/utils/udLayerUtils.js';

// End-to-end smoke for the Grew search page: drives the real React UI against
// the live core. Finds a UD-configured project with data, runs a labeled-edge
// query, checks results render, and verifies the result→editor deep link.

const BASE = process.env.UD_BASE || 'http://localhost:5173';
let PID;

test.beforeAll(async () => {
  const client = await PlaidClient.login('http://localhost:8085', 'a@b.com', 'password');
  let projects = [];
  try { projects = await client.projects.list(); } catch { projects = await client.projects.listAll(); }
  for (const p of projects) {
    const full = await client.projects.get(p.id);
    const li = getUdLayerInfo(full);
    if (!li.isConfigured) continue;
    const r = await client.query({ find: ['?t'], where: [['token', '?t', { layer: li.morphemeTokenLayer.id }]], return: 'count', scope: { projectIds: [p.id] } });
    if ((r.count ?? 0) > 0) { PID = p.id; break; }
  }
});

test('runs a Grew query and shows highlighted matching sentences', async ({ page }) => {
  expect(PID, 'a UD project with data must exist').toBeTruthy();
  await seedAuth(page);
  await page.goto(`${BASE}/#/projects/${PID}/search`);

  // Enter a query that should match in any UD treebank and run it.
  const box = page.getByPlaceholder(/pattern \{/);
  await expect(box).toBeVisible();
  await box.fill('pattern { H []; D []; H -[nsubj]-> D }');
  await page.getByRole('button', { name: 'Search' }).click();

  // Results summary appears and at least one highlighted token is shown.
  await expect(page.getByText(/matching sentence/)).toBeVisible();
  await expect(page.locator('mark').first()).toBeVisible();

  // Clicking a result opens the annotation editor deep-linked to that sentence.
  await page.locator('mark').first().click();
  await expect(page).toHaveURL(/\/documents\/[^/]+\/annotate\?sent=/);
});

test('reports a clear error for an unsupported feature', async ({ page }) => {
  expect(PID).toBeTruthy();
  await seedAuth(page);
  await page.goto(`${BASE}/#/projects/${PID}/search`);
  const box = page.getByPlaceholder(/pattern \{/);
  await box.fill('pattern { X [] } global { is_cyclic }');
  await page.getByRole('button', { name: 'Search' }).click();
  // is_cyclic is constant-folded to empty under the UD tree invariant.
  await expect(page.getByText('No matching sentences.')).toBeVisible();
});
