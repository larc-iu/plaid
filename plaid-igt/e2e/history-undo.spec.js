import { randomUUID } from 'node:crypto';
import PlaidClient, { ROLES } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken, CORE } from './fixtures.js';
import { createScratchProject, roleOf } from './fixtureProject.js';
import { fakeJobWorker, stoppedReport } from './jobWorker.js';

// Undo of one History entry, from what it changed, as a person does it: a
// person's edit in the grid (and the undo of that undo, and a second tab on
// the document), an assistant plan, a job made by hand with a person's later
// edit in one sentence (that value left and listed, the rest undone), and a
// Bulk Edit merge, from the document's History (which points at the
// vocabulary's) and from the vocabulary's, then the undo of that undo.
//
// PLAID_E2E_SCREENS, when set, is a directory the dialog and History are
// saved to.

test.describe.configure({ mode: 'serial' });

const SHOTS = process.env.PLAID_E2E_SCREENS;
const shot = async (page, name) => {
  if (!SHOTS) return;
  // Past the dialog's fade-in.
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};

const MACHINE = { prov: 'inferred', provSource: 'e2e:model' };

let client;
let projectId;
let documentId;
let vocabId;
let glossLayer;
let morphemes;

const docPath = (extra = '') => `/#/projects/${projectId}/documents/${documentId}${extra}`;
const changes = (page) => page.getByTestId('history-changes');
const glossCell = (page, i) =>
  page.locator(`.igt-field[data-cell-key="ma:${morphemes[i].id}:Gloss"]`);

const glossSpans = async () => {
  const raw = await client.documents.get(documentId, true);
  return raw.textLayers
    .flatMap((tl) => tl.tokenLayers || [])
    .flatMap((tkl) => tkl.spanLayers || [])
    .find((sl) => sl.id === glossLayer.id).spans;
};
const glossOn = async (i) =>
  (await glossSpans()).find((s) => s.tokens.includes(morphemes[i].id))?.value ?? null;
const glosses = async () => Promise.all(morphemes.map((_, i) => glossOn(i)));

const openHistory = async (page) => {
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByText(/^\d+ entries$/)).toBeVisible({ timeout: 15_000 });
};

// The History rail's rows, newest first.
const railRows = (page) =>
  page.getByRole('region', { name: 'History' }).locator('[data-history-item^="u:"]');

// Undo over the changes, and the dialog it opens once its dry run is in.
const openUndo = async (page) => {
  await changes(page).getByRole('button', { name: 'Undo', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Comparing…')).toHaveCount(0, { timeout: 20_000 });
  return dialog;
};

const undoIn = async (dialog) => {
  await dialog.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 20_000 });
};

test.beforeAll(async () => {
  client = new PlaidClient(CORE, readToken().token);
  ({ projectId, documentId } = await createScratchProject({
    name: `E2E History Undo ${Date.now()}`,
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
  await client.withOperation('Seed glosses', async () => {
    await client.spans.create(glossLayer.id, [morphemes[0].id], 'go');
    await client.spans.create(glossLayer.id, [morphemes[1].id], 'house');
  });
});

test.afterAll(async () => {
  if (projectId) await client.projects.delete(projectId).catch(() => {});
});

test('a person’s edit is undone from History, a second tab follows, and the undo is undone', async ({
  page,
  browser,
}) => {
  // A second tab on the document, open before the undo, as a colleague's.
  const other = await browser.newContext();
  const page2 = await other.newPage();
  try {
    await seedAuth(page);
    await page.goto(docPath('?tab=analyze'));
    const cell = glossCell(page, 0);
    await expect(cell).toHaveValue('go', { timeout: 20_000 });
    await cell.click();
    await cell.fill('walk');
    await cell.press('Enter');
    await expect.poll(() => glossOn(0), { timeout: 15_000 }).toBe('walk');

    await seedAuth(page2);
    await page2.goto(docPath('?tab=analyze'));
    await expect(glossCell(page2, 0)).toHaveValue('walk', { timeout: 20_000 });

    await openHistory(page);
    await page
      .getByText(/^Gloss of morpheme "kai"/)
      .first()
      .click();
    await expect(changes(page)).toBeVisible({ timeout: 15_000 });
    const dialog = await openUndo(page);
    await expect(dialog.getByRole('heading', { name: 'Undo this entry?' })).toBeVisible();
    await expect(dialog.getByTestId('undo-line')).toHaveText('1 value');
    await expect(dialog.getByTestId('undo-left')).toHaveCount(0);
    await shot(page, '1-dialog-clean');
    await undoIn(dialog);

    // The document now, the gloss back, the undo at the top of History.
    await expect(page.getByText('1 value.', { exact: true })).toBeVisible();
    await expect(changes(page)).toHaveCount(0);
    await expect(page.getByText('Historical state')).toHaveCount(0);
    await expect(glossCell(page, 0)).toHaveValue('go', { timeout: 20_000 });
    expect(await glossOn(0)).toBe('go');
    await expect(railRows(page).first()).toContainText('Undo entry: Gloss of morpheme "kai"', {
      timeout: 15_000,
    });
    expect(page.url()).not.toContain('history=');
    await shot(page, '4-history-after');

    // The second tab sees it as it sees a restore: its next write meets the
    // new version, is sent again on the document read afresh, and the tab
    // shows the undone gloss beside its own.
    const cell2 = glossCell(page2, 1);
    await cell2.click();
    await cell2.fill('home');
    await cell2.press('Enter');
    await expect.poll(() => glossOn(1), { timeout: 15_000 }).toBe('home');
    await expect(glossCell(page2, 0)).toHaveValue('go', { timeout: 20_000 });
    await expect(page2.locator('.igt-island__error')).toHaveCount(0);

    // The undo is an entry like any other: it opens on what it changed, and
    // undoing it puts the person's edit back.
    await railRows(page).first().click();
    await expect(changes(page)).toBeVisible({ timeout: 15_000 });
    await expect(changes(page).locator('[data-change] del')).toHaveText('walk');
    const again = await openUndo(page);
    await expect(again.getByTestId('undo-line')).toHaveText('1 value');
    await undoIn(again);
    await expect(glossCell(page, 0)).toHaveValue('walk', { timeout: 20_000 });
    expect(await glossOn(0)).toBe('walk');
    await expect(railRows(page).first()).toContainText('Undo entry: Undo entry:', {
      timeout: 15_000,
    });

    // The person's edit itself now has nothing left to undo: its row was
    // written again since.
    await page
      .getByText(/^Gloss of morpheme "kai"/)
      .first()
      .click();
    await expect(changes(page)).toBeVisible({ timeout: 15_000 });
    const nothing = await openUndo(page);
    await expect(nothing.getByText('Nothing to undo.')).toBeVisible();
    await expect(nothing.getByText('Changed again later')).toBeVisible();
    await expect(nothing.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
    await nothing.getByText('Changed again later').click();
    await expect(nothing.getByRole('link', { name: 'Sentence 1' })).toBeVisible();
    await shot(page, '3-dialog-nothing');
    await nothing.getByRole('button', { name: 'Close' }).first().click();
    await expect(nothing).toHaveCount(0);
  } finally {
    await other.close();
  }
});

test('an assistant plan is undone whole', async ({ page }) => {
  const before = await glosses();
  const groupId = randomUUID();
  const first = (await glossSpans()).find((s) => s.tokens.includes(morphemes[0].id));
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
  await expect(changes(page)).toBeVisible({ timeout: 20_000 });
  const dialog = await openUndo(page);
  await expect(dialog.getByTestId('undo-line')).toHaveText('3 values');
  // The undo's answer is lost once after core made it: the client sends it
  // again under its key, core answers the stored summary, and it is made once.
  const keys = [];
  await page.route('**/audit/entries/*/undo?*', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('dry-run')) return route.continue();
    keys.push(route.request().headers()['idempotency-key']);
    if (keys.length === 1) {
      await route.fetch();
      return route.abort('connectionreset');
    }
    return route.continue();
  });
  await undoIn(dialog);
  await page.unroute('**/audit/entries/*/undo?*');
  expect(keys.length).toBe(2);
  expect(keys[1]).toBe(keys[0]);
  const undos = (await client.documents.audit(documentId))
    .flatMap((e) => e.ops || [])
    .filter((o) => o.type === 'audit-entry/undo' && o.description.includes('Assistant: gloss'));
  expect(undos).toHaveLength(1);
  await expect(page.getByText('3 values.', { exact: true })).toBeVisible();
  await expect(glossCell(page, 2)).toHaveValue('', { timeout: 20_000 });
  expect(await glosses()).toEqual(before);
});

test('a job’s entry is undone but for the value a person wrote since, which is listed', async ({
  page,
}) => {
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
      await client.spans.create(glossLayer.id, [morphemes[3].id], 'hand', MACHINE);
      made = await client.vocabItems.create(vocabId, 'tuna', { gloss: 'fish' });
      await client.vocabLinks.create(made.id, [morphemes[2].id], MACHINE);
    },
    { kind: 'job', ref: `job:${job.id}/doc:${documentId}/pass:gloss`, groupId },
  );
  await worker.document(job.id, documentId, {
    state: 'done',
    sentences: 1,
    targets: 1,
    done: 1,
    counts: { words: 3, links: 1, entries: 1 },
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

  // A person corrects the job's gloss on tuna afterwards.
  const fish = (await glossSpans()).find((s) => s.tokens.includes(morphemes[2].id));
  await client.withOperation('Correct tuna', async () => {
    await client.spans.update(fish.id, 'fish.SG');
    await client.spans.setMetadata(fish.id, {});
  });

  // From the job's page, to its entry in the document.
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/jobs/${job.id}`);
  await page.getByRole('link', { name: 'Changes', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`history=${groupId}`));
  await expect(changes(page)).toBeVisible({ timeout: 20_000 });
  const dialog = await openUndo(page);
  await expect(dialog.getByTestId('undo-line')).toHaveText('2 values and 1 link');
  const left = dialog.getByTestId('undo-left');
  await expect(left.locator('summary')).toHaveText(['Changed again later1']);
  // The entry it made stays: it is undone from the vocabulary's History.
  await expect(dialog.getByTestId('undo-entries-note')).toContainText('Story lexicon');
  await left.locator('summary').click();
  const place = left.getByRole('link', { name: 'Sentence 1' });
  await expect(place).toHaveAttribute('href', /focusSentence=/);
  await shot(page, '2-dialog-left');
  await undoIn(dialog);
  await expect(page.getByText('2 values and 1 link. 1 change left as it was.')).toBeVisible();

  // The person's value stays, the job's others are gone or back.
  expect(await glossOn(2)).toBe('fish.SG');
  expect(await glossOn(3)).toBeNull();
  expect(await glossOn(0)).toBe('walk');
  const links = await client.query({
    where: [['link', '?l', { item: made.id }]],
    return: { group: [], aggregates: [['count']] },
  });
  expect(links?.results?.[0]?.[0] ?? 0).toBe(0);
});

test('a Bulk Edit merge is undone from the vocabulary’s History, and the undo undone', async ({
  page,
}) => {
  const kai = await client.vocabItems.create(vocabId, 'kai', { gloss: 'go' });
  const kay = await client.vocabItems.create(vocabId, 'kay', { gloss: 'go' });
  await client.withOperation('Link kay', async () => {
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
  // How many links each of the two entries has.
  const linkCount = async (item) => {
    const res = await client.query({
      where: [['link', '?l', { item: item.id }]],
      return: { group: [], aggregates: [['count']] },
    });
    return res?.results?.[0]?.[0] ?? 0;
  };
  const linkedTo = async () => ({ kai: await linkCount(kai), kay: await linkCount(kay) });
  const itemIds = async () =>
    ((await client.vocabLayers.get(vocabId, true)).items || []).map((i) => i.id);

  // From the document's History, the link cannot move back without its
  // entry: the dialog says where the entry is undone, and links there.
  await seedAuth(page);
  await page.goto(docPath(`?tab=analyze&history=${groupId}`));
  await expect(changes(page)).toBeVisible({ timeout: 20_000 });
  const fromDoc = await openUndo(page);
  await expect(fromDoc.getByText('Nothing to undo.')).toBeVisible();
  await expect(fromDoc.getByTestId('undo-entries-note')).toHaveText(
    'Lexicon entries are undone from the vocabulary’s History, with every link to them: Story lexicon',
  );
  await fromDoc.getByRole('link', { name: 'Story lexicon' }).click();
  await expect(page).toHaveURL(new RegExp(`/vocabularies/${vocabId}\\?history=${groupId}`));
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // There: the merged entry back, with its link.
  await expect(changes(page)).toBeVisible({ timeout: 20_000 });
  const dialog = await openUndo(page);
  await expect(dialog.getByTestId('undo-line')).toHaveText(
    '1 link and 1 lexicon entry brought back',
  );
  await undoIn(dialog);
  await expect(page.getByText('1 link and 1 lexicon entry brought back.')).toBeVisible();
  await expect(changes(page)).toHaveCount(0);
  expect(await itemIds()).toContain(kay.id);
  await expect.poll(linkedTo).toEqual({ kai: 0, kay: 1 });

  // The undo is the vocabulary History's newest entry, and undoing it merges
  // again.
  const rows = page.getByRole('region', { name: 'History' }).locator('[data-history-item^="u:"]');
  await expect(rows.first()).toContainText('Undo entry: Merge', { timeout: 15_000 });
  await shot(page, '5-vocabulary-history-after');
  await rows.first().click();
  await expect(changes(page)).toBeVisible({ timeout: 20_000 });
  const redo = await openUndo(page);
  await expect(redo.getByTestId('undo-line')).toHaveText('1 link and 1 lexicon entry removed');
  await undoIn(redo);
  expect(await itemIds()).not.toContain(kay.id);
  await expect.poll(linkedTo).toEqual({ kai: 1, kay: 0 });
});
