import { test, expect, seedAuth } from './fixtures.js';
import { seedUdDoc } from './seedUdDoc.js';

// End-to-end smoke for the Grew search page: drives the real React UI against
// the live core. Seeds its own two-sentence treebank, runs a labeled-edge
// query, checks results render, and verifies the result→editor deep link.
//
// It used to search the server for the first project with dependency
// relations, so it passed or failed on whatever other runs had left there,
// and failed outright once that project was deleted.

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5173';
const BODY = 'the dog runs the cat sleeps';
const WORDS = [
  [0, 3],
  [4, 7],
  [8, 12],
  [13, 16],
  [17, 20],
  [21, 27],
];
const S = {};
let PID;

test.beforeAll(async () => {
  Object.assign(
    S,
    await seedUdDoc(`Search ${Date.now()}`, BODY, WORDS, [
      [0, 13],
      [13, 27],
    ]),
  );
  PID = S.projectId;
  const { client, layers, morphIds } = S;
  const lemmaIds = [];
  for (const [i, lemma] of ['the', 'dog', 'run', 'the', 'cat', 'sleep'].entries()) {
    lemmaIds.push((await client.spans.create(layers.lemma, [morphIds[i]], lemma)).id);
  }
  for (const [head, dep, deprel] of [
    [2, 1, 'nsubj'],
    [1, 0, 'det'],
    [5, 4, 'nsubj'],
    [4, 3, 'det'],
  ]) {
    await client.relations.create(layers.relation, lemmaIds[head], lemmaIds[dep], deprel);
  }
});

test.afterAll(async () => {
  if (S.client && S.projectId) {
    await S.client.projects
      .delete(S.projectId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

// The page has two Search buttons: the quick-lookup box's (which writes a
// pattern into the box below) and the Grew box's own, which runs what is in it.
// This spec types a pattern, so it means the second.
const runPattern = (page) =>
  page.getByRole('button', { name: 'Search', exact: true }).last().click();

test('runs a Grew query and shows highlighted matching sentences', async ({ page }) => {
  await seedAuth(page);
  await page.goto(`${BASE}/#/projects/${PID}/search`);

  // Enter a query that should match in any UD treebank and run it.
  const box = page.getByPlaceholder(/pattern \{/);
  await expect(box).toBeVisible();
  await box.fill('pattern { H []; D []; H -[nsubj]-> D }');
  await runPattern(page);

  // Results summary appears and at least one highlighted token is shown.
  await expect(page.getByText(/matching sentence/)).toBeVisible();
  await expect(page.locator('mark').first()).toBeVisible();

  // Clicking a result opens the annotation editor deep-linked to that sentence.
  await page.locator('mark').first().click();
  await expect(page).toHaveURL(/\/documents\/[^/]+\/annotate\?sent=/);
});

test('reports a clear error for an unsupported feature', async ({ page }) => {
  await seedAuth(page);
  await page.goto(`${BASE}/#/projects/${PID}/search`);
  const box = page.getByPlaceholder(/pattern \{/);
  await box.fill('pattern { X [] } global { is_cyclic }');
  await runPattern(page);
  // is_cyclic is constant-folded to empty under the UD tree invariant.
  await expect(page.getByText('No matching sentences.')).toBeVisible();
});
