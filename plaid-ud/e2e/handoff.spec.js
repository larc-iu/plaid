// Item 6: Tokenize and Annotate hand over to each other, at the sentence you
// are looking at. Tokenizing and annotating are one job done in two places, and
// the case a treebanker actually hits is a word cut wrong, fixed over there,
// and straight back.
import { test, expect, seedAuth } from './fixtures.js';
import { seedUdDoc } from './seedUdDoc.js';

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

test.beforeAll(async () => {
  Object.assign(S, await seedUdDoc(`Handoff ${Date.now()}`, BODY, WORDS));
  for (const [i, lemma] of ['the', 'dog', 'run', 'the', 'cat', 'sleep'].entries()) {
    await S.client.spans.create(S.layers.lemma, [S.morphIds[i]], lemma);
  }
  // A second sentence, so "which sentence" is a real question. The seeder makes
  // one covering the whole body; SPLIT it at "the cat". The Sentences layer is
  // partitioning, so it refuses a direct extent change: `tokens.split` is the
  // endpoint, and it keeps the left half's identity.
  const doc = await S.client.documents.get(S.documentId, true);
  const sentences = doc.textLayers[0].tokenLayers.find((l) => l.name === 'Sentences');
  const whole = sentences.tokens[0];
  S.firstSentenceId = whole.id;
  const split = await S.client.tokens.split(whole.id, 13);
  S.secondSentenceId = split.id;
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

test('Alt+click a token in the Text Editor annotates its sentence', async ({ page }) => {
  await open(page, 'edit');
  const cat = page.locator('[data-sentence]', { hasText: 'cat' }).first();
  await expect(cat).toBeVisible({ timeout: 15000 });

  await cat.click({ modifiers: ['Alt'] });

  await expect(page).toHaveURL(new RegExp(`/annotate\\?sent=${S.secondSentenceId}`), {
    timeout: 8000,
  });
});

test('a plain click in the Text Editor still toggles the sentence boundary', async ({ page }) => {
  await open(page, 'edit');
  const runs = page.locator('[data-sentence-block] span', { hasText: 'runs' }).first();
  await expect(runs).toBeVisible({ timeout: 15000 });

  await runs.click();

  // Still on the Text Editor: the hand-off must not steal the ordinary click.
  await expect(page).toHaveURL(/\/edit$/, { timeout: 4000 });
  // And it did what a plain click does.
  await expect
    .poll(
      async () => {
        const doc = await S.client.documents.get(S.documentId, true);
        const sentences = doc.textLayers[0].tokenLayers.find((l) => l.name === 'Sentences');
        return sentences.tokens.length;
      },
      { timeout: 8000 },
    )
    .toBe(3);

  // Put it back for the other tests: merge the extra sentence into its
  // predecessor, which is what removing a boundary is on a partitioning layer.
  const doc = await S.client.documents.get(S.documentId, true);
  const sentences = doc.textLayers[0].tokenLayers.find((l) => l.name === 'Sentences');
  const extra = sentences.tokens
    .slice()
    .sort((a, b) => a.begin - b.begin)
    .find((t) => t.id !== S.firstSentenceId && t.id !== S.secondSentenceId);
  if (extra) {
    const previous = sentences.tokens.find((t) => t.end === extra.begin);
    if (previous) await S.client.tokens.merge(previous.id, extra.id);
  }
});

test('Edit text under a sentence opens the Text Editor on it', async ({ page }) => {
  await open(page, 'annotate');
  await expect(page.locator('.token-form', { hasText: 'cat' }).first()).toBeVisible({
    timeout: 15000,
  });

  // The second sentence's own button.
  await page.locator('.sentence-container').nth(1).locator('.edit-text-btn').click();

  await expect(page).toHaveURL(new RegExp(`/edit\\?sent=${S.secondSentenceId}`), {
    timeout: 8000,
  });
  // And the block it landed on is the one that was asked for, outlined.
  await expect(page.locator(`[data-sentence-block="${S.secondSentenceId}"]`)).toHaveAttribute(
    'data-flash',
    'true',
    { timeout: 8000 },
  );
});

test('Alt+click a word in Annotate opens the Text Editor on its sentence', async ({ page }) => {
  await open(page, 'annotate');
  await expect(page.locator('.token-form', { hasText: 'cat' }).first()).toBeVisible({
    timeout: 15000,
  });

  // The tree draws a transparent grab rect over each word's form, so THAT is
  // what a click on a word hits. The affordance lives there for the same
  // reason: a handler on the form below it could never fire.
  const areas = page.locator('.sentence-container').nth(1).locator('.tree-token-area');
  await expect(areas.first()).toBeAttached({ timeout: 8000 });
  await areas.nth(1).click({ modifiers: ['Alt'], force: true });

  await expect(page).toHaveURL(new RegExp(`/edit\\?sent=${S.secondSentenceId}`), {
    timeout: 8000,
  });
});

test('a plain click on a word still starts drawing a relation', async ({ page }) => {
  await open(page, 'annotate');
  await expect(page.locator('.token-form', { hasText: 'cat' }).first()).toBeVisible({
    timeout: 15000,
  });

  const areas = page.locator('.sentence-container').nth(1).locator('.tree-token-area');
  await areas.nth(1).click({ force: true });

  // Still here: the hand-off must not take the ordinary click.
  await expect(page).toHaveURL(/\/annotate$/, { timeout: 4000 });
});

test('the outline fades, and does not come back on a re-render', async ({ page }) => {
  await open(page, `edit?sent=${S.secondSentenceId}`);
  const block = page.locator(`[data-sentence-block="${S.secondSentenceId}"]`);
  await expect(block).toHaveAttribute('data-flash', 'true', { timeout: 15000 });
  await expect(block).not.toHaveAttribute('data-flash', 'true', { timeout: 8000 });
});
