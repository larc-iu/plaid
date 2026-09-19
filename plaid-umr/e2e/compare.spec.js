import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';
import { getFixture } from './fixtureProject.js';

const API = 'http://localhost:8085';
const COPY_NAME = 'E2E UMR Copy';

// The Compare tab reads the report the AnCast service leaves on a document.
// No service runs here: a report is planted on a copy of the fixture
// document, scored against the original, and the tab shows the scores and
// the two graphs with the unmatched nodes marked.
test('the Compare tab shows a planted report side by side', async ({ page }) => {
  const { projectId, documentId } = await getFixture();
  const client = new PlaidClient(API, readToken().token);
  const docs = await client.projects.listDocuments(projectId);
  let copy = docs.find((d) => d.name === COPY_NAME) || null;
  if (!copy) {
    const made = await client.documents.copy(documentId, COPY_NAME);
    copy = { id: made?.id || made };
  }
  const original = await client.documents.get(documentId, true);
  const firstVar = original.textLayers[0].tokenLayers
    .find((l) => l.config?.umr?.nodes)
    .spanLayers[0].spans.map((s) => s.metadata?.umr?.var)
    .find((v) => v && v.startsWith('s1'));
  const current = (await client.documents.get(copy.id, false)).metadata?.umr || {};
  const report = {
    version: 1,
    tool: 'ancast 0.1.1',
    against: { id: documentId, name: original.name },
    at: '2026-09-19T20:00:00Z',
    scope: 'doc',
    scores: { sentence: 0.8312, modal: 0.5, temporal: 0.25, coref: 1, comprehensive: 0.7 },
    sentences: [
      {
        index: 1,
        concept: 0.9,
        labeled: 0.8,
        unlabeled: 0.85,
        weighted: 0.8,
        smatch: 0.7,
        matches: [[firstVar, firstVar]],
        unmatched: [],
        unmatchedOther: [firstVar],
        skipped: null,
      },
    ],
  };
  await client.documents.patchMetadata(copy.id, { umr: { ...current, adjudication: report } });

  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${copy.id}/compare`);
  const box = page.getByTestId('compare-report');
  await expect(box).toBeVisible();
  await expect(box.locator('[data-score="sentence"]')).toContainText('83%');
  await expect(box.locator('[data-score="comprehensive"]')).toContainText('70%');
  await expect(box).toContainText(original.name);

  const first = page.locator('[data-compare-sentence="1"]');
  await expect(first.locator('[data-sentence-score="concept"]')).toContainText('90%');
  // Both graphs, the other document's read live, and its unmatched node marked.
  const pres = first.locator('pre');
  await expect(pres.nth(0)).toContainText('(s1');
  await expect(pres.nth(1)).toContainText('(s1');
  await expect(pres.nth(1).locator('mark')).toHaveText(firstVar);
  await expect(first).toContainText(`${firstVar} = ${firstVar}`);
  // A sentence the report does not cover says so rather than inventing scores.
  await expect(page.locator('[data-compare-sentence="2"]')).toContainText('Not in the report');

  // The dialog offers the other documents, the original among them.
  await page.getByRole('button', { name: 'Compare' }).click();
  await expect(page.getByTestId('compare-against')).toContainText(original.name);
});
