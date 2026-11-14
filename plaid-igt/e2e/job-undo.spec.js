import { randomUUID } from 'node:crypto';
import PlaidClient, { ROLES } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken, CORE } from './fixtures.js';
import { createScratchProject, roleOf } from './fixtureProject.js';
import { fakeJobWorker, stoppedReport } from './jobWorker.js';

// Undo job on an ended job's page: a job made by hand (the spec's own worker,
// no model) in two documents and the lexicon, undone whole, then a second job
// undone with a person's later edit in one document left and listed.
//
// PLAID_E2E_SCREENS, when set, is a directory the dialog and the page after
// are saved to.

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
let vocabId;
let glossLayerId;
// Per document: its id, name and morphemes in reading order.
const docs = [];

// A document of `body` in the project, tokenized one morpheme a word.
const addDocument = async (name, body, layers) => {
  const doc = await client.documents.create(projectId, name);
  const text = await client.texts.create(layers.text, doc.id, body);
  const words = [...body.matchAll(/\S+/g)].map((m) => ({
    begin: m.index,
    end: m.index + m[0].length,
  }));
  await client.tokens.bulkCreate([
    { tokenLayerId: layers.sentence, text: text.id, begin: 0, end: body.length },
  ]);
  await client.tokens.bulkCreate(
    words.map((w) => ({ tokenLayerId: layers.word, text: text.id, ...w })),
  );
  await client.tokens.bulkCreate(
    words.map((w) => ({ tokenLayerId: layers.morpheme, text: text.id, ...w, precedence: 1 })),
  );
  return doc.id;
};

const morphemesOf = async (documentId) => {
  const raw = await client.documents.get(documentId, true);
  const tl = raw.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  return tl.tokenLayers
    .find((t) => roleOf(t) === ROLES.MORPHEME)
    .tokens.slice()
    .sort((a, b) => a.begin - b.begin);
};

const glossesOf = async (d) => {
  const raw = await client.documents.get(d.id, true);
  const spans = raw.textLayers
    .flatMap((tl) => tl.tokenLayers || [])
    .flatMap((tkl) => tkl.spanLayers || [])
    .find((sl) => sl.id === glossLayerId).spans;
  return d.morphemes.map((m) => spans.find((s) => s.tokens.includes(m.id))?.value ?? null);
};
const spanOn = async (d, i) => {
  const raw = await client.documents.get(d.id, true);
  return raw.textLayers
    .flatMap((tl) => tl.tokenLayers || [])
    .flatMap((tkl) => tkl.spanLayers || [])
    .find((sl) => sl.id === glossLayerId)
    .spans.find((s) => s.tokens.includes(d.morphemes[i].id));
};
const entryForms = async () =>
  ((await client.vocabLayers.get(vocabId, true)).items || []).map((i) => i.form).sort();

// A job over both documents, worked by hand: in each document one group of
// glosses, and in the second a new entry linked to its first word.
const runJob = async (instructions) => {
  const worker = fakeJobWorker(client);
  const job = await client.jobs.create(projectId, {
    app: 'igt',
    instructions,
    documents: docs.map((d) => d.id),
  });
  const claimed = await worker.claim();
  expect(claimed?.id).toBe(job.id);
  const label = `Assistant job: ${instructions}`;
  const groups = [];
  for (const [i, d] of docs.entries()) {
    const groupId = randomUUID();
    groups.push(groupId);
    await client.withOperation(
      label,
      async () => {
        const first = await spanOn(d, 0);
        if (first) {
          await client.spans.update(first.id, `${first.value}.FUT`);
          await client.spans.setMetadata(first.id, MACHINE);
        } else {
          await client.spans.create(glossLayerId, [d.morphemes[0].id], 'go.FUT', MACHINE);
        }
        await client.spans.create(glossLayerId, [d.morphemes[1].id], 'thing', MACHINE);
        if (i === 1) {
          const made = await client.vocabItems.create(vocabId, `tuna${groups.length}`, {
            gloss: 'fish',
          });
          await client.vocabLinks.create(made.id, [d.morphemes[0].id], MACHINE);
        }
      },
      { kind: 'job', ref: `job:${job.id}/doc:${d.id}/pass:gloss`, groupId },
    );
    await worker.document(job.id, d.id, {
      state: 'done',
      sentences: 1,
      targets: 1,
      done: 1,
      counts: { words: 2 },
      glossGroup: groupId,
    });
  }
  const report = stoppedReport({
    instructions,
    document: { id: docs[0].id, name: docs[0].name, sentenceId: null },
    startedAt: claimed.startedAt,
  });
  report.state = 'done';
  report.reason = null;
  report.documents = docs.map((d, i) => ({
    ...report.documents[0],
    documentId: d.id,
    name: d.name,
    state: 'done',
    skipped: [],
    glossGroup: groups[i],
  }));
  await worker.finish(job.id, { state: 'done', report });
  return job;
};

test.beforeAll(async () => {
  client = new PlaidClient(CORE, readToken().token);
  let first;
  ({ projectId, documentId: first } = await createScratchProject({
    name: `E2E Job Undo ${Date.now()}`,
    docName: 'Story one',
    body: 'kai pele',
  }));
  const project = await client.projects.get(projectId);
  const tl = project.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const layer = (role) => tl.tokenLayers.find((t) => roleOf(t) === role).id;
  glossLayerId = tl.tokenLayers
    .flatMap((t) => t.spanLayers || [])
    .find((s) => s.name === 'Gloss').id;
  const second = await addDocument('Story two', 'tuna nima', {
    text: tl.id,
    sentence: layer(ROLES.SENTENCE),
    word: layer(ROLES.WORD),
    morpheme: layer(ROLES.MORPHEME),
  });
  docs.push({ id: first, name: 'Story one', morphemes: await morphemesOf(first) });
  docs.push({ id: second, name: 'Story two', morphemes: await morphemesOf(second) });
  vocabId = (await client.vocabLayers.create(projectId, 'Story lexicon')).id;
  await client.projects.linkVocab(projectId, vocabId);
  // A person's gloss the job will write over.
  await client.withOperation('Seed a gloss', async () => {
    await client.spans.create(glossLayerId, [docs[0].morphemes[0].id], 'go');
  });
});

test.afterAll(async () => {
  if (projectId) await client.projects.delete(projectId).catch(() => {});
});

test('a job in two documents and the lexicon is undone whole from its page', async ({ page }) => {
  const before = await Promise.all(docs.map(glossesOf));
  const job = await runJob('Gloss every word.');
  expect(await entryForms()).toEqual(['tuna2']);

  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/jobs/${job.id}`);
  await page.getByRole('button', { name: 'Undo job' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Comparing…')).toHaveCount(0, { timeout: 20_000 });
  await expect(dialog.getByRole('heading', { name: 'Undo this job?' })).toBeVisible();
  await expect(dialog.getByTestId('undo-line')).toHaveText(
    '4 values, 1 link and 1 lexicon entry removed',
  );
  await expect(dialog.getByTestId('undo-left')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 20_000 });

  await expect(page.getByText('4 values, 1 link and 1 lexicon entry removed.')).toBeVisible();
  await expect(page.getByTestId('job-undone')).toContainText('Job undone');
  await expect(page.getByRole('button', { name: 'Undo job' })).toHaveCount(0);
  expect(await Promise.all(docs.map(glossesOf))).toEqual(before);
  expect(await entryForms()).toEqual([]);

  // The undo is one entry in each document's History, and opens there.
  await page.getByTestId('job-undone').getByRole('link', { name: 'Show in History' }).click();
  await expect(page.getByTestId('history-changes')).toBeVisible({ timeout: 20_000 });
});

test('a job is undone but for what a person changed since, which is listed', async ({ page }) => {
  const job = await runJob('Gloss again.');
  // A person corrects the job's gloss in the second document.
  const fixed = await spanOn(docs[1], 1);
  await client.withOperation('Correct nima', async () => {
    await client.spans.update(fixed.id, 'hand');
    await client.spans.setMetadata(fixed.id, {});
  });

  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/jobs/${job.id}`);
  await page.getByRole('button', { name: 'Undo job' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Comparing…')).toHaveCount(0, { timeout: 20_000 });
  await expect(dialog.getByTestId('undo-line')).toHaveText(
    '3 values, 1 link and 1 lexicon entry removed',
  );
  const left = dialog.getByTestId('undo-left');
  await expect(left.locator('summary')).toHaveText(['Changed again later1']);
  await left.locator('summary').click();
  await expect(left.getByRole('link', { name: 'Story two' })).toHaveAttribute(
    'href',
    new RegExp(`documents/${docs[1].id}$`),
  );
  await shot(page, '6-job-undo-dialog');
  await dialog.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId('job-undone')).toContainText('Job undone');
  await shot(page, '7-job-after-undo');

  // The person's value stays, the job's others are back as they were.
  expect(await glossesOf(docs[0])).toEqual(['go', null]);
  expect(await glossesOf(docs[1])).toEqual([null, 'hand']);
  expect(await entryForms()).toEqual([]);

  // After a reload the page still knows, from the job's read, and the Jobs
  // tab says it beside the job's state.
  await page.reload();
  await expect(page.getByTestId('job-undone')).toContainText('Job undone', { timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Undo job' })).toHaveCount(0);
  await page.goto(`/#/projects/${projectId}?tab=jobs`);
  await expect(page.locator('tbody tr').first().locator('[data-undone]')).toHaveText('Undone', {
    timeout: 20_000,
  });

  // The undo undone from a document's History (a redo): the line goes and
  // Undo job is offered again.
  await page.goto(`/#/projects/${projectId}/jobs/${job.id}`);
  await page.getByTestId('job-undone').getByRole('link', { name: 'Show in History' }).click();
  await expect(page.getByTestId('history-changes')).toBeVisible({ timeout: 20_000 });
  await page
    .getByTestId('history-changes')
    .getByRole('button', { name: 'Undo', exact: true })
    .click();
  const redo = page.getByRole('dialog');
  await expect(redo.getByText('Comparing…')).toHaveCount(0, { timeout: 20_000 });
  await redo.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(redo).toHaveCount(0, { timeout: 20_000 });
  await page.goto(`/#/projects/${projectId}/jobs/${job.id}`);
  await expect(page.getByRole('button', { name: 'Undo job' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('job-undone')).toHaveCount(0);
});
