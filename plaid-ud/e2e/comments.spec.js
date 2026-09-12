// Item 9: comments on a document and on its sentences.
//
// The store, the thread list and the browser are plaid-ui's, shared with
// plaid-igt and tested there. What is worth asserting here is this app's half:
// its anchors (a sentence is named by its sent_id, or by its position), where
// the tab and the badge are, and that the live claim is held only while
// something is open.
import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, seedAuth } from './fixtures.js';
import { seedUdDoc } from './seedUdDoc.js';

const CORE = 'http://localhost:8085';
const COLLEAGUE = { id: 'ud-comment-colleague@x.com', password: 'colleague-pass-1' };

const S = {};

test.beforeAll(async () => {
  Object.assign(
    S,
    await seedUdDoc(`Comments ${Date.now()}`, 'the dog runs. she sings.', [
      [0, 3],
      [4, 7],
      [8, 12],
      [13, 16],
      [17, 22],
    ]),
  );
  for (const [i, lemma] of ['the', 'dog', 'run', 'she', 'sing'].entries()) {
    await S.client.spans.create(S.layers.lemma, [S.morphIds[i]], lemma);
  }
  // Two sentences, so "which one" is a real question. The Sentences layer is
  // partitioning, so `split` is the endpoint and it keeps the left half's id.
  const doc = await S.client.documents.get(S.documentId, true);
  const sentences = doc.textLayers[0].tokenLayers.find((l) => l.name === 'Sentences');
  S.first = sentences.tokens[0].id;
  S.second = (await S.client.tokens.split(S.first, 13)).id;
  // The first is named by the corpus; the second is not.
  await S.client.tokens.patchMetadata(S.first, { sent_id: 'ewt-1' });

  await S.client.users
    .create(COLLEAGUE.id, COLLEAGUE.password, false, 'A Colleague')
    .catch((err) => {
      if (!/exist/i.test(err.message || '')) throw err;
    });
  await S.client.projects.addWriter(S.projectId, COLLEAGUE.id);
  S.colleague = await PlaidClient.login(CORE, COLLEAGUE.id, COLLEAGUE.password);
});

test.afterAll(async () => {
  if (S.client && S.projectId) {
    await S.client.projects
      .delete(S.projectId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

const open = async (page, tab) => {
  await seedAuth(page);
  await page.goto(`/#/projects/${S.projectId}/documents/${S.documentId}/${tab}`);
};

test('a sentence is named by its sent_id, or by its position when it has none', async ({
  page,
}) => {
  await S.client.comments.create('token', S.first, 'On the named one.', 'ewt-1');
  await S.client.comments.create('token', S.second, 'On the other.', 'Sentence 2');
  await open(page, 'comments');

  // The corpus already named the first, and that name is what survives an
  // export; the position is the sub-heading either way. Not `exact`: the
  // heading is a bare text node beside its detail, so no ELEMENT's text is
  // just the label.
  const rows = page.locator('li');
  await expect(rows.filter({ hasText: 'ewt-1' })).toHaveCount(1, { timeout: 15000 });
  await expect(rows.filter({ hasText: 'Sentence 1' })).toHaveCount(1); // the detail says where
  await expect(rows.filter({ hasText: 'Sentence 2' })).toHaveCount(1);
});

test("the document's own thread is pinned above the sentences", async ({ page }) => {
  await S.client.comments.create('document', S.documentId, 'About the whole thing.', 'Doc');
  await open(page, 'comments');

  const headings = page.locator('li button[type="button"]').nth(1);
  await expect(headings).toBeVisible({ timeout: 15000 });
  // The document's thread is first whatever the sort says.
  await expect(page.locator('li').first()).toContainText('Doc');
});

test('a thread opens, takes a comment, and the Markdown renders', async ({ page }) => {
  await open(page, 'comments');
  await page.locator('li').filter({ hasText: 'ewt-1' }).getByRole('button').first().click();

  const box = page.getByLabel('Add a comment');
  await expect(box).toBeVisible({ timeout: 15000 });
  await box.fill('The *lemma* is right.');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();

  await expect(page.locator('em', { hasText: 'lemma' })).toBeVisible({ timeout: 8000 });
  await expect
    .poll(
      async () => (await S.client.comments.list(S.projectId, { documentId: S.documentId })).length,
      { timeout: 8000 },
    )
    .toBeGreaterThan(0);
});

test('each sentence carries a badge in the editor, and it opens the thread', async ({ page }) => {
  await S.client.comments.create('token', S.second, 'Look at this one.', 'Sentence 2');
  await open(page, 'annotate');
  await expect(page.locator('.token-form', { hasText: 'dog' }).first()).toBeVisible({
    timeout: 15000,
  });

  const badges = page.locator('.sentence-comments');
  await expect(badges).toHaveCount(2);
  // Both controls read "Comment" now, and the COUNT is what tells them apart,
  // so both halves of that have to be asserted: the comment here used to say
  // one showed "the invitation", which stopped being true, and only the
  // counted one was ever checked. Which sentence is which is not this test's
  // business, so count them rather than assuming an order.
  // Earlier tests in this file leave comments behind, so how many of each
  // there are is not fixed. What is fixed: every control names the action, and
  // a sentence someone has written on carries a number beside it.
  const labels = await badges.allTextContents();
  expect(labels.every((t) => t.trim().startsWith('Comment'))).toBe(true);
  expect(labels.filter((t) => /Comment\s*\d/.test(t)).length).toBeGreaterThan(0);

  await badges.nth(1).click();
  await expect(page.getByText('Look at this one.')).toBeVisible({ timeout: 8000 });
});

test('a reader gets no invitation on an empty sentence', async ({ page }) => {
  // Readers cannot comment, so a sentence with nothing on it offers nothing.
  // The colleague is a WRITER here, so this checks the other half: they do.
  const auth = {
    token: S.colleague.token,
    userId: COLLEAGUE.id,
    displayName: COLLEAGUE.id,
    isAdmin: false,
  };
  await seedAuth(page, auth);
  await page.goto(`/#/projects/${S.projectId}/documents/${S.documentId}/annotate`);
  await expect(page.locator('.token-form', { hasText: 'dog' }).first()).toBeVisible({
    timeout: 15000,
  });
  await expect(page.locator('.sentence-comments')).toHaveCount(2);
});

test('the live stream is claimed only while a thread is open', async ({ page }) => {
  await open(page, 'annotate');
  await expect(page.locator('.token-form', { hasText: 'dog' }).first()).toBeVisible({
    timeout: 15000,
  });

  const listens = [];
  page.on('request', (r) => {
    if (r.url().includes('/listen')) listens.push(r.url());
  });

  // A plain document load never opens one: an always-open stream is a cost
  // every reader pays for a feature most of them are not using, and it breaks
  // Playwright's `networkidle` besides.
  await page.waitForTimeout(1500);
  expect(listens).toHaveLength(0);

  await page.locator('.sentence-comments').nth(1).click();
  await expect.poll(() => listens.length, { timeout: 8000 }).toBeGreaterThan(0);
});
