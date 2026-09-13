// The History drawer, and what it says when it cannot read the history.
//
// The drawer is the shared one (@ui/components/shared/HistoryDrawer) and it has
// an error branch, but UD never passed `error`, so a failed audit fetch left an
// empty list under the heading "No entries" — which reads as "this document has
// no history", about a document with plenty.
//
// A failed TIME TRAVEL is deliberately not this: the entries a reader is
// browsing stay on screen and the failure is a toast.
import { test, expect, seedAuth } from './fixtures.js';
import { seedUdDoc } from './seedUdDoc.js';

const BODY = 'the dog runs';
const WORDS = [
  [0, 3],
  [4, 7],
  [8, 12],
];

const S = {};

test.beforeAll(async () => {
  Object.assign(S, await seedUdDoc(`History ${Date.now()}`, BODY, WORDS));
});

test.afterAll(async () => {
  if (S.client && S.projectId) {
    await S.client.projects
      .delete(S.projectId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

const openAnnotate = async (page) => {
  await seedAuth(page);
  await page.goto(`/#/projects/${S.projectId}/documents/${S.documentId}/annotate`);
  await expect(page.locator('.sentence-container').first()).toBeVisible({ timeout: 15000 });
};

test('the drawer lists what has happened to the document', async ({ page }) => {
  await openAnnotate(page);
  await page.getByRole('button', { name: 'History' }).click();

  await expect(page.getByText(/\d+ entries/)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('No entries')).toHaveCount(0);
});

test('picking an entry offers to restore it, and Restore opens the dialog', async ({ page }) => {
  await openAnnotate(page);
  await page.getByRole('button', { name: 'History' }).click();
  await expect(page.getByText(/\d+ entries/)).toBeVisible({ timeout: 15000 });

  // The newest entry, at the top of the list.
  await page.locator('.cursor-pointer.border-b').first().click();
  await expect(page.getByText('Historical state')).toBeVisible({ timeout: 15000 });

  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByRole('heading', { name: /^Restore to / })).toBeVisible({ timeout: 15000 });

  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: /^Restore to / })).toHaveCount(0);
});

test('a history that cannot be read says so, rather than "No entries"', async ({ page }) => {
  await openAnnotate(page);
  await page.route('**/api/v1/documents/*/audit*', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
  );

  await page.getByRole('button', { name: 'History' }).click();

  // The drawer's own error box: the heading it alone renders, and the reason.
  await expect(page.getByText('Error', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(
    page.getByText('The server hit an unexpected error. Try again in a moment.').first(),
  ).toBeVisible();
  await expect(page.getByText('No entries')).toHaveCount(0);
});
