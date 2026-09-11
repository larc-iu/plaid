// Item 10: the project's Activity tab. The panel itself is plaid-igt's, moved
// into plaid-ui, so what is worth asserting here is the adapter: that this app
// mounts it, that it is maintainers-only, and that the two things it had to
// change for UD actually changed — the document links go to UD's routes, and
// there are no avatars, which this app decided against.
import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, seedAuth } from './fixtures.js';
import { seedUdDoc } from './seedUdDoc.js';

const CORE = 'http://localhost:8085';
const WRITER = { id: 'ud-activity-writer@x.com', password: 'writer-pass-1' };

const S = {};

test.beforeAll(async () => {
  Object.assign(
    S,
    await seedUdDoc(`Activity ${Date.now()}`, 'the dog runs', [
      [0, 3],
      [4, 7],
      [8, 12],
    ]),
  );
  // Something for the tally and the feed to report.
  for (const [i, lemma] of ['the', 'dog', 'run'].entries()) {
    await S.client.spans.create(S.layers.lemma, [S.morphIds[i]], lemma);
  }

  // A writer, to check the maintainer gate from the other side. Reused across
  // runs, so an "already exists" is the normal case and the only one swallowed:
  // any other failure here would leave the gate untested and look like a pass.
  await S.client.users
    .create(WRITER.id, WRITER.password, false, 'UD Activity Writer')
    .catch((err) => {
      if (!/exist/i.test(err.message || '')) throw err;
    });
  await S.client.projects.addWriter(S.projectId, WRITER.id);
  S.writerAuth = {
    ...(await PlaidClient.login(CORE, WRITER.id, WRITER.password)),
    userId: WRITER.id,
    displayName: WRITER.id,
    isAdmin: false,
  };
});

test.afterAll(async () => {
  if (S.client && S.projectId) {
    await S.client.projects
      .delete(S.projectId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

test('the Activity tab shows who has been working, and what they changed', async ({ page }) => {
  await seedAuth(page);
  await page.goto(`/#/projects/${S.projectId}/activity`);

  await expect(page.getByText('Who has been working')).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('Recent changes')).toBeVisible();
  // The seeding above is this project's whole history, so the feed has rows.
  await expect(page.getByText('Create UD project', { exact: false })).toBeVisible({
    timeout: 8000,
  });
});

test("a document in the feed links to this app's annotation view", async ({ page }) => {
  await seedAuth(page);
  await page.goto(`/#/projects/${S.projectId}/activity`);
  await expect(page.getByText('Recent changes')).toBeVisible({ timeout: 15000 });

  // plaid-igt opens a document at /projects/:p/documents/:d. Sending a UD
  // reader there is a dead end, which is why the feed takes a href builder.
  const link = page.locator(`a[href*="/documents/${S.documentId}"]`).first();
  await expect(link).toHaveAttribute('href', new RegExp(`/documents/${S.documentId}/annotate$`));
});

test('the panel brings no avatars with it', async ({ page }) => {
  await seedAuth(page);
  await page.goto(`/#/projects/${S.projectId}/activity`);
  await expect(page.getByText('Who has been working')).toBeVisible({ timeout: 15000 });

  // Deliberate, and this app's ruling: the shared panel draws one by default.
  await expect(page.locator('.activity-avatar, [data-slot="avatar"]')).toHaveCount(0);
  await expect(page.locator('img')).toHaveCount(0);
});

test('a maintainer is offered the tab', async ({ page }) => {
  await seedAuth(page);
  await page.goto(`/#/projects/${S.projectId}/documents`);
  await expect(page.getByRole('tab', { name: 'Activity' })).toBeVisible({ timeout: 15000 });
});

// Its own test, not a second half: seedAuth works through addInitScript, and a
// `/#/...` navigation is a hash change that never reloads the document, so a
// second identity seeded into the same page is simply never read.
test('a writer is not, and the route gives them nothing', async ({ page }) => {
  // A writer is not a maintainer. This is a per-person tally of everyone's
  // work, so it is the same gate Project Settings uses.
  await seedAuth(page, S.writerAuth);
  await page.goto(`/#/projects/${S.projectId}/documents`);
  // They are in the project and can see its documents, so the tab's absence
  // below is the gate and not a failed load.
  await expect(page.getByRole('heading', { name: /^Documents in/ })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByRole('tab', { name: 'Activity' })).toHaveCount(0);

  await page.goto(`/#/projects/${S.projectId}/activity`);
  await expect(page.getByText('Who has been working')).toHaveCount(0);
  await expect(page.getByText('Recent changes')).toHaveCount(0);
});
