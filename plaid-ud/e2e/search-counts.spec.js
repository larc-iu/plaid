// Item 12: counting the matches instead of reading them, and a plain lookup
// for people who do not write Grew.
import { test, expect, seedAuth } from './fixtures.js';
import { seedUdDoc } from './seedUdDoc.js';

const BODY = 'the dog runs the cat sleeps the bird sings';
const WORDS = [
  [0, 3],
  [4, 7],
  [8, 12],
  [13, 16],
  [17, 20],
  [21, 27],
  [28, 31],
  [32, 36],
  [37, 42],
];

const S = {};

test.beforeAll(async () => {
  Object.assign(S, await seedUdDoc(`Search counts ${Date.now()}`, BODY, WORDS));
  const { client, layers, morphIds } = S;
  const lemmas = ['the', 'dog', 'run', 'the', 'cat', 'sleep', 'the', 'bird', 'sing'];
  const upos = ['DET', 'NOUN', 'VERB', 'DET', 'NOUN', 'VERB', 'DET', 'NOUN', 'VERB'];
  const lemmaIds = [];
  for (const [i, lemma] of lemmas.entries()) {
    lemmaIds.push((await client.spans.create(layers.lemma, [morphIds[i]], lemma)).id);
  }
  for (const [i, tag] of upos.entries()) await client.spans.create(layers.upos, [morphIds[i]], tag);
  for (const [head, dep] of [
    [2, 1],
    [5, 4],
    [8, 7],
  ]) {
    await client.relations.create(layers.relation, lemmaIds[head], lemmaIds[dep], 'nsubj');
  }
  for (const [head, dep] of [
    [1, 0],
    [4, 3],
    [7, 6],
  ]) {
    await client.relations.create(layers.relation, lemmaIds[head], lemmaIds[dep], 'det');
  }
});

test.afterAll(async () => {
  if (S.client && S.projectId) {
    await S.client.projects
      .delete(S.projectId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

const openSearch = async (page) => {
  await seedAuth(page);
  await page.goto(`/#/projects/${S.projectId}/search`);
  await expect(page.getByRole('heading', { name: /^Search / })).toBeVisible({ timeout: 15000 });
};

const quickSearch = async (page, field, match, text) => {
  await page.getByLabel('Which field').click();
  await page.getByRole('option', { name: field, exact: true }).click();
  await page.getByLabel('How to match').click();
  await page.getByRole('option', { name: match, exact: true }).click();
  await page.getByLabel('What to look for').fill(text);
  await page.getByRole('button', { name: 'Search', exact: true }).first().click();
};

test('a quick lookup writes a Grew pattern and runs it', async ({ page }) => {
  await openSearch(page);
  await quickSearch(page, 'Lemma', 'contains', 'the');

  // It writes into the Grew box rather than searching on its own, so a quick
  // search is the first draft of a real one.
  await expect(page.locator('textarea')).toHaveValue('pattern { W [lemma=re"the"] }', {
    timeout: 8000,
  });
  await expect(page.getByText(/matching sentence/)).toBeVisible({ timeout: 8000 });
});

test('a relation lookup puts the label in the ARC, and matches', async ({ page }) => {
  await openSearch(page);
  await quickSearch(page, 'Dependency relation', 'contains', 'subj');

  // NOT `e: H -> W; e.label = re"subj"`: the compiler reads `e.something` as a
  // feature of a NODE called e, so that form searches for a FEATS span reading
  // `label=subj` and matches nothing, with no error to show for it.
  await expect(page.locator('textarea')).toHaveValue('pattern { H -[re"subj"]-> W }', {
    timeout: 8000,
  });
  await expect(page.getByText(/1 matching sentence/)).toBeVisible({ timeout: 8000 });
});

test('counting by a field re-runs the pattern as an aggregate', async ({ page }) => {
  await openSearch(page);
  await quickSearch(page, 'Dependency relation', 'contains', 'subj');
  await expect(page.getByText(/matching sentence/)).toBeVisible({ timeout: 8000 });

  await page.getByLabel('Count by').click();
  // Only the pattern's own nodes are offered, and never an edge as if it were
  // one: `e.lemma` would be a search that cannot match.
  await expect(page.getByRole('option', { name: 'W.lemma' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'e.lemma' })).toHaveCount(0);
  await page.getByRole('option', { name: 'W.lemma' }).click();
  await page.getByRole('button', { name: 'Count' }).click();

  // Three nsubj dependents, one each.
  const table = page.locator('table');
  await expect(table).toBeVisible({ timeout: 8000 });
  await expect(table.getByText('bird')).toBeVisible();
  await expect(table.getByText('cat')).toBeVisible();
  await expect(table.getByText('dog')).toBeVisible();
  await expect(table.getByText('33%').first()).toBeVisible();
});

test('counting by a tag groups the matches', async ({ page }) => {
  await openSearch(page);
  await quickSearch(page, 'Lemma', 'contains', 'the');
  await expect(page.getByText(/matching sentence/)).toBeVisible({ timeout: 8000 });

  await page.getByLabel('Count by').click();
  await page.getByRole('option', { name: 'W.upos' }).click();
  await page.getByRole('button', { name: 'Count' }).click();

  const table = page.locator('table');
  await expect(table.getByText('DET')).toBeVisible({ timeout: 8000 });
  await expect(table.getByText('3', { exact: true })).toBeVisible();
});
