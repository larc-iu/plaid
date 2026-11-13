import { randomUUID } from 'node:crypto';
import PlaidClient, { ROLES } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken, CORE } from './fixtures.js';
import { createScratchProject, roleOf } from './fixtureProject.js';
import { fakeJobWorker, stoppedReport } from './jobWorker.js';

// History shows what an entry changed: a document's entry opens on the
// sentences it changed, before and after, with whose each replaced value was,
// and the lexicon entries it changed. Each kind of entry is made here and read
// as a person would: a person's edit in the grid, an assistant plan, a Bulk
// Edit merge (and the vocabulary's History of it), a document restore, and a
// job made by hand (the spec's own worker, no model), reached from its page.
//
// PLAID_E2E_SCREENS, when set, is a directory each view is saved to.

test.describe.configure({ mode: 'serial' });

const SHOTS = process.env.PLAID_E2E_SCREENS;
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};

const MACHINE = { prov: 'inferred', provSource: 'e2e:model' };
const GLOSS_CELL = '.igt-field[data-cell-key^="ma:"]';

let client;
let projectId;
let documentId;
let vocabId;
let glossLayer;
let morphemes;
let seededAt;

const docPath = (extra = '') => `/#/projects/${projectId}/documents/${documentId}${extra}`;
const changes = (page) => page.getByTestId('history-changes');
const count = (page) => page.getByTestId('change-count');

const glossSpans = async () => {
  const raw = await client.documents.get(documentId, true);
  return raw.textLayers
    .flatMap((tl) => tl.tokenLayers || [])
    .flatMap((tkl) => tkl.spanLayers || [])
    .find((sl) => sl.id === glossLayer.id).spans;
};
const spanOn = async (m) => (await glossSpans()).find((s) => s.tokens.includes(m.id));

// The newest entry of the document's History with this message.
const entryOf = async (message) => {
  const entries = await client.documents.audit(documentId);
  const entry = entries.filter((e) => e.message === message).at(-1);
  expect(entry, `audit entry "${message}"`).toBeTruthy();
  return entry;
};

const openHistory = async (page) => {
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByText(/^\d+ entries$/)).toBeVisible({ timeout: 15_000 });
};

test.beforeAll(async () => {
  client = new PlaidClient(CORE, readToken().token);
  ({ projectId, documentId } = await createScratchProject({
    name: `E2E History Changes ${Date.now()}`,
    docName: 'Story one',
    body: 'kai pele tuna nima',
  }));
  const raw = await client.documents.get(documentId, true);
  const tl = raw.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  glossLayer = tl.tokenLayers.flatMap((t) => t.spanLayers || []).find((s) => s.name === 'Gloss');
  morphemes = tl.tokenLayers
    .find((t) => roleOf(t) === ROLES.MORPHEME)
    .tokens.slice()
    .sort((a, b) => a.begin - b.begin);
  vocabId = (await client.vocabLayers.create(projectId, 'Story lexicon')).id;
  await client.projects.linkVocab(projectId, vocabId);
  // A person's glosses on the first two words.
  await client.withOperation('Seed glosses', async () => {
    await client.spans.create(glossLayer.id, [morphemes[0].id], 'go');
    await client.spans.create(glossLayer.id, [morphemes[1].id], 'house');
  });
  seededAt = (await entryOf('Seed glosses')).endTime;
});

test.afterAll(async () => {
  if (projectId) await client.projects.delete(projectId).catch(() => {});
});

test('a person’s edit in the grid reads as the gloss it replaced', async ({ page }) => {
  await seedAuth(page);
  await page.goto(docPath('?tab=analyze'));
  const cell = page.locator(GLOSS_CELL).first();
  await expect(cell).toHaveValue('go', { timeout: 20_000 });
  await cell.click();
  await cell.fill('walk');
  await cell.press('Enter');
  await expect
    .poll(async () => (await spanOn(morphemes[0]))?.value, { timeout: 15_000 })
    .toBe('walk');

  await openHistory(page);
  await page
    .getByText(/^Gloss of morpheme "kai"/)
    .first()
    .click();
  await expect(changes(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Changes made in this entry/)).toBeVisible();
  await expect(count(page)).toHaveText('1 change, 1 replaced a person’s value');
  const replaced = changes(page).locator('[data-change="replaced"]');
  await expect(replaced).toHaveCount(1);
  await expect(replaced.locator('del')).toHaveText('go');
  await expect(replaced.locator('span').first()).toHaveText('walk');
  // The entry is in the address, so a reload reopens it.
  expect(page.url()).toContain('history=');
  await shot(page, '1-person-edit');
  await page.reload();
  await expect(count(page)).toHaveText('1 change, 1 replaced a person’s value', {
    timeout: 20_000,
  });
});

test('an assistant plan reads as what it filled and what it replaced', async ({ page }) => {
  const groupId = randomUUID();
  const first = await spanOn(morphemes[0]);
  await client.withOperation(
    'Assistant: gloss the sentence',
    async () => {
      await client.spans.update(first.id, 'go.PST');
      await client.spans.setMetadata(first.id, MACHINE);
      await client.spans.create(glossLayer.id, [morphemes[2].id], 'fish', MACHINE);
      await client.spans.create(glossLayer.id, [morphemes[3].id], 'three', MACHINE);
    },
    { kind: 'assistant-plan', groupId },
  );
  await seedAuth(page);
  await page.goto(docPath(`?tab=analyze&history=${groupId}`));
  await expect(count(page)).toHaveText('3 changes, 1 replaced a person’s value', {
    timeout: 20_000,
  });
  await expect(changes(page).locator('[data-change="added"]')).toHaveCount(2);
  await expect(changes(page).locator('[data-change="replaced"] del')).toHaveText('walk');
  // The new values wear the machine's mark.
  await expect(
    changes(page).locator('[data-change="added"] .plaid-prov--machine').first(),
  ).toHaveText('fish');
  await shot(page, '2-assistant-plan');

  // Only the sentences where a person's value went.
  await page.getByRole('button', { name: /A person’s value replaced/ }).click();
  await expect(changes(page).locator('[data-sentence]')).toHaveCount(1);

  // The document as of the entry is one click away.
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Document' }).click();
  await expect(page.getByText(/This is the document as of/)).toBeVisible();
  await expect(page.locator(GLOSS_CELL).first()).toHaveValue('go.PST', { timeout: 15_000 });
});

test('a Bulk Edit merge reads as the links it moved, in the document and the vocabulary', async ({
  page,
}) => {
  const kai = await client.vocabItems.create(vocabId, 'kai', { gloss: 'go' });
  const kay = await client.vocabItems.create(vocabId, 'kay', { gloss: 'go' });
  await client.withOperation('Link kai', async () => {
    await client.vocabLinks.create(kay.id, [morphemes[0].id]);
  });
  const groupId = randomUUID();
  await client.withOperation(
    'Merge “kay” into “kai”',
    async () => {
      await client.vocabItems.merge(kai.id, [kay.id]);
    },
    { kind: 'bulk-edit', ref: 'action:merge', groupId },
  );

  await seedAuth(page);
  await page.goto(docPath(`?tab=analyze&history=${groupId}`));
  await expect(changes(page)).toBeVisible({ timeout: 20_000 });
  const entryRow = changes(page).locator('tr[data-row="entry"] [data-change]');
  await expect(entryRow.locator('del')).toHaveText('kay');
  await expect(entryRow.locator('span').first()).toHaveText('kai');
  const lexicon = changes(page).locator(`[data-entry="${kay.id}"]`);
  await expect(lexicon).toContainText('Merged into kai');
  await shot(page, '3-bulk-merge-document');

  // The merged entry is gone, so it links to its vocabulary's History at the
  // merge, which counts the links the merge moved per document.
  await lexicon.getByRole('link', { name: 'kay' }).click();
  await expect(page).toHaveURL(new RegExp(`/vocabularies/${vocabId}\\?history=${groupId}`));
  await expect(count(page)).toHaveText('1 entry, 1 link in 1 document', { timeout: 20_000 });
  const docRow = page.getByTestId('link-counts').locator('tbody tr');
  await expect(docRow).toHaveText(/Story one\s*1/);
  await shot(page, '4-bulk-merge-vocabulary');

  // And back to the document's History at the same entry.
  await docRow.getByRole('link', { name: 'Story one' }).click();
  await expect(page).toHaveURL(new RegExp(`documents/${documentId}\\?history=${groupId}`));
  await expect(changes(page)).toBeVisible({ timeout: 20_000 });
});

test('a document restore reads as what it put back', async ({ page }) => {
  await client.documents.restore(documentId, seededAt, {}, 'Restore to the seeded glosses');
  await seedAuth(page);
  await page.goto(docPath('?tab=analyze'));
  await expect(page.locator(GLOSS_CELL).first()).toHaveValue('go', { timeout: 20_000 });
  await openHistory(page);
  await page
    .getByText(/Restore to the seeded glosses/)
    .first()
    .click();
  await expect(changes(page)).toBeVisible({ timeout: 15_000 });
  // The machine glosses it took away are no person's, the link is.
  const deleted = changes(page).locator('[data-change="deleted"] del');
  await expect(deleted).toHaveText(['fish', 'three']);
  await expect(changes(page).locator('[data-change="changed"] del').first()).toHaveText('go.PST');
  await shot(page, '5-document-restore');
});

test('a job made by hand reads as its work, reached from the job page', async ({ page }) => {
  const worker = fakeJobWorker(client);
  const job = await client.jobs.create(projectId, {
    app: 'igt',
    instructions: 'Gloss every word.',
    documents: [documentId],
  });
  const claimed = await worker.claim();
  expect(claimed?.id).toBe(job.id);
  const groupId = randomUUID();
  const spans = await glossSpans();
  const on = (m) => spans.find((s) => s.tokens.includes(m.id));
  let made;
  await client.withOperation(
    'Assistant job: Gloss every word.',
    async () => {
      await client.spans.update(on(morphemes[0]).id, 'go.FUT');
      await client.spans.setMetadata(on(morphemes[0]).id, MACHINE);
      await client.spans.create(glossLayer.id, [morphemes[2].id], 'fish.PL', MACHINE);
      made = await client.vocabItems.create(vocabId, 'tuna', { gloss: 'fish', Status: 'machine' });
      await client.vocabLinks.create(made.id, [morphemes[2].id], MACHINE);
    },
    { kind: 'job', ref: `job:${job.id}/doc:${documentId}/pass:gloss`, groupId },
  );
  await worker.document(job.id, documentId, {
    state: 'done',
    sentences: 1,
    targets: 1,
    done: 1,
    counts: { words: 2, links: 1, entries: 1 },
    glossGroup: groupId,
  });
  const report = stoppedReport({
    instructions: 'Gloss every word.',
    document: { id: documentId, name: 'Story one', sentenceId: null },
    startedAt: claimed.startedAt,
  });
  report.state = 'done';
  report.reason = null;
  report.documents = [{ ...report.documents[0], state: 'done', skipped: [], glossGroup: groupId }];
  await worker.finish(job.id, { state: 'done', report });

  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/jobs/${job.id}`);
  const link = page.getByRole('link', { name: 'Changes', exact: true });
  await expect(link).toBeVisible({ timeout: 20_000 });
  await shot(page, '6-job-page');
  await link.click();
  await expect(page).toHaveURL(new RegExp(`documents/${documentId}\\?.*history=${groupId}`));
  await expect(count(page)).toHaveText('4 changes, 1 replaced a person’s value', {
    timeout: 20_000,
  });
  await expect(changes(page).locator(`[data-entry="${made.id}"]`)).toContainText('Added');
  await shot(page, '7-job-changes');
});
