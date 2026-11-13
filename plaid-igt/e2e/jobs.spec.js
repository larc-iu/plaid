import PlaidClient, { ROLES } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken, signInAdmin, CORE } from './fixtures.js';
import { createScratchProject, roleOf } from './fixtureProject.js';
import { fakeJobWorker, stoppedReport } from './jobWorker.js';

// Assistant jobs in the app (the unattended glossing jobs, SPEC 11): Start job
// from the Documents tab and from a document, the Jobs tab and the job page as
// a worker moves the job, the banner on the document the job is working in
// and on no other, Stop from the banner and from the page, the refusal of a
// second job, and what a reader sees.
//
// The worker is the spec's (jobWorker.js): the e2e admin's client claiming
// the job and moving it step by step, no model. The jobs are started in the
// app by the same admin. A throwaway project with two documents and a lexicon
// (the instructions are required, a starter text fills them), deleted
// afterwards with its jobs.

test.describe.configure({ mode: 'serial' });

const READER = { email: 'jobs-reader@x.com', password: 'jobs-pass-1' };

let client;
let worker;
let projectId;
let docA;
let docB;
let sentenceA;
// The job each test leaves for the next.
let jobId;

test.beforeAll(async () => {
  client = new PlaidClient(CORE, readToken().token);
  worker = fakeJobWorker(client);
  ({ projectId, documentId: docA } = await createScratchProject({
    name: `jobs ${Date.now()}`,
    docName: 'Story A',
    body: 'kai pele tuna',
  }));
  const lexicon = await client.vocabLayers.create(projectId, 'Jobs lexicon');
  await client.projects.linkVocab(projectId, lexicon.id);
  const project = await client.projects.get(projectId);
  const textLayer = project.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  docB = (await client.documents.create(projectId, 'Story B')).id;
  await client.texts.create(textLayer.id, docB, 'nima rua');
  const raw = await client.documents.get(docA, true);
  const sentences = raw.textLayers
    .find((l) => roleOf(l) === ROLES.BASELINE)
    .tokenLayers.find((l) => roleOf(l) === ROLES.SENTENCE).tokens;
  sentenceA = sentences[0].id;
  const exists = await client.users.get(READER.email).then(
    () => true,
    () => false,
  );
  if (!exists) await (await signInAdmin(CORE)).users.create(READER.email, READER.password, false);
  await client.projects.addReader(projectId, READER.email);
});

test.afterAll(async () => {
  if (projectId) await client.projects.delete(projectId).catch(() => {});
});

const banner = (page) => page.locator('[data-run-banner]');
// The job page's line of state, phase and message.
const jobState = (page) =>
  page.getByRole('status').filter({ hasText: /^(Waiting|Running|Stopping|Done|Stopped|Failed)/ });
const jobUrl = (id) => new RegExp(`#/projects/${projectId}/jobs/${id ?? '[0-9a-f-]{36}'}$`);

const openDocument = async (page, documentId) => {
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=baseline`);
  await expect(page.getByRole('button', { name: 'History' })).toBeVisible();
};

// Confirm the open "Stop the job?" question.
const confirmStop = async (page) => {
  const ask = page.getByRole('alertdialog');
  await expect(ask).toContainText('Stop the job?');
  await ask.getByRole('button', { name: 'Stop', exact: true }).click();
};

test('Start job on the Documents tab makes a waiting job and opens its page', async ({ page }) => {
  await seedAuth(page);
  // Core's own answer, as though no worker had asked for work on it: a spec
  // run before this one may have run a worker on the same core.
  await page.route('**/api/v1/jobs/worker', async (route) => {
    const response = await route.fetch();
    route.fulfill({ response, json: { ...(await response.json()), 'seen-at': null } });
  });
  await page.goto(`/#/projects/${projectId}`);
  await page.getByRole('button', { name: 'Start job' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('All documents (2)');
  await expect(dialog).toContainText('No job worker is running. The job waits until one starts.');
  await expect(dialog.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Segment, gloss and link' }).click();
  await dialog.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page).toHaveURL(jobUrl());
  jobId = page.url().split('/jobs/')[1];
  await expect(jobState(page)).toContainText('Waiting');
  await expect(page.getByText('link each morpheme to its lexicon entry')).toBeVisible();
  const job = await client.jobs.get(jobId);
  expect(job.state).toBe('waiting');
  expect(job.instructions).toMatch(/^Segment and gloss every word nobody has analyzed, and link/);
  expect(job.documents.map((d) => d.documentId).sort()).toEqual([docA, docB].sort());
});

test('a second job is refused with a link to the first', async ({ page }) => {
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}?tab=jobs`);
  await page.getByRole('button', { name: 'Start job' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Translate', exact: true }).click();
  await dialog.getByRole('button', { name: 'Start', exact: true }).click();
  const alert = dialog.getByRole('alert');
  await expect(alert).toContainText('This project already has a job.');
  await alert.getByRole('link', { name: 'Open it' }).click();
  await expect(page).toHaveURL(jobUrl(jobId));
});

test('the page, the tab and the banner follow the worker, on its document only', async ({
  page,
}) => {
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/jobs/${jobId}`);
  await expect(jobState(page)).toContainText('Waiting');

  const claimed = await worker.claim();
  expect(claimed.id).toBe(jobId);
  await worker.heartbeat(jobId, {
    phase: 'working',
    message: 'Sentences 1 to 5 of 10.',
    currentDocument: docA,
  });
  await worker.document(jobId, docA, { state: 'working', sentences: 10, targets: 10, done: 5 });

  // The page reads its job again while the job is active.
  const status = jobState(page);
  await expect(status).toContainText('Running', { timeout: 15000 });
  await expect(status).toContainText('Working');
  await expect(status).toContainText('Sentences 1 to 5 of 10.');
  await expect(page.getByRole('row', { name: /Story A/ })).toContainText('5 of 10');

  await page.goto(`/#/projects/${projectId}?tab=jobs`);
  await expect(page.getByRole('row', { name: /Running/ })).toBeVisible();

  await openDocument(page, docA);
  await expect(banner(page)).toContainText('Assistant job');
  await expect(banner(page)).toContainText('Sentences 1 to 5 of 10.');

  await openDocument(page, docB);
  await expect(page.getByRole('button', { name: 'Start job' })).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
});

test('Stop on the banner stops the job, and the page shows the report', async ({ page }) => {
  await seedAuth(page);
  await openDocument(page, docA);
  await banner(page).getByRole('button', { name: 'Stop' }).click();
  await confirmStop(page);
  await expect.poll(async () => (await client.jobs.get(jobId)).state).toBe('stopping');

  // The worker sees it on its next beat, and ends the job with its report.
  const beat = await worker.heartbeat(jobId, { message: 'Stopping.' });
  expect(beat.state).toBe('stopping');
  const job = await client.jobs.get(jobId);
  await worker.finish(jobId, {
    state: 'cancelled',
    reason: 'cancelled',
    report: stoppedReport({
      instructions: job.instructions,
      document: { id: docA, name: 'Story A', sentenceId: sentenceA },
      startedAt: job.startedAt,
    }),
  });
  await expect(banner(page)).toHaveCount(0, { timeout: 20000 });

  await page.goto(`/#/projects/${projectId}/jobs/${jobId}`);
  await expect(jobState(page)).toContainText('Stopped');
  const report = page.getByRole('region', { name: 'Report' });
  await expect(report).toContainText('Documents not reached');
  await expect(report).toContainText('Too long');
  await expect(report.getByRole('link', { name: 's3' })).toHaveAttribute(
    'href',
    `#/projects/${projectId}/documents/${docA}?tab=analyze&focusSentence=${sentenceA}`,
  );
  await page.goto(`/#/projects/${projectId}?tab=jobs`);
  await expect(page.getByRole('row', { name: /Stopped/ })).toBeVisible();
});

test('Start job on a document chooses it, and Stop on the page ends a waiting job', async ({
  page,
}) => {
  await seedAuth(page);
  await openDocument(page, docB);
  await page.getByRole('button', { name: 'Start job' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('radio', { name: 'Selected documents' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Story B' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Story A' })).not.toBeChecked();
  await dialog
    .getByRole('textbox', { name: 'Instructions' })
    .fill('Translate the empty translations.');
  await dialog.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page).toHaveURL(jobUrl());
  jobId = page.url().split('/jobs/')[1];
  expect((await client.jobs.get(jobId)).documents.map((d) => d.documentId)).toEqual([docB]);

  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await confirmStop(page);
  await expect(jobState(page)).toContainText('Stopped');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  expect((await client.jobs.get(jobId)).state).toBe('cancelled');
});

test('a reader sees the Jobs tab and a job, with no Start job and no Stop', async ({ page }) => {
  // A job waiting, so there is something a writer could stop.
  const waiting = await client.jobs.create(projectId, {
    app: 'igt',
    instructions: 'Translate the empty translations.',
  });
  try {
    const { token } = await PlaidClient.login(CORE, READER.email, READER.password);
    await seedAuth(page, { token, userId: READER.email, isAdmin: false });
    await page.goto(`/#/projects/${projectId}`);
    await expect(page.getByRole('tab', { name: 'Jobs' })).toBeVisible();
    await expect(page.getByRole('row', { name: /Story A/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start job' })).toHaveCount(0);

    await page.getByRole('tab', { name: 'Jobs' }).click();
    await expect(page.getByRole('row', { name: /Waiting/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start job' })).toHaveCount(0);
    await page
      .getByRole('row', { name: /Waiting/ })
      .getByRole('link')
      .first()
      .click();
    await expect(page).toHaveURL(jobUrl(waiting.id));
    await expect(jobState(page)).toContainText('Waiting');
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);

    await openDocument(page, docA);
    await expect(page.getByRole('button', { name: 'Start job' })).toHaveCount(0);
  } finally {
    await client.jobs.cancel(waiting.id).catch(() => {});
  }
});
