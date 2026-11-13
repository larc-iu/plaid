import PlaidClient, { ROLES } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken, CORE } from './fixtures.js';
import { createScratchProject, roleOf } from './fixtureProject.js';
import { skipUnlessAgent, startIgtAssistant } from './assistantService.js';
import { fakeJobWorker } from './jobWorker.js';

// A job discussed with the assistant (BRIEF-JD): the spec's worker
// (jobWorker.js) ends a job with a report whose "Left blank" lists pele. On the
// job's page, Discuss with the assistant opens the panel on a new conversation
// about the job. The real IGT assistant on a scripted model reads the report's
// "left" section with read_job and plans a gloss for pele, and the user
// approves it. The question is asked from the job: the service stamps it with
// the job and gives the model the job's summary, which the turn's Instructions
// show, and the record keeps only the job's id and name. A throwaway project,
// deleted afterwards with its job.

const DOC = 'Story A';

const script = (jobId) => [
  { content: '', calls: [{ name: 'read_job', arguments: { job: jobId, section: 'left' } }] },
  {
    content: '',
    calls: [
      {
        name: 'set_analysis',
        arguments: {
          document: DOC,
          ref: 's1.w2',
          morphemes: [{ form: 'pele', fields: { Gloss: 'fish' } }],
        },
      },
    ],
  },
  { content: 'The job left pele (s1.w2) blank. The plan glosses it as fish.' },
];

let client;
let userId;
let projectId;
let documentId;
let jobId;

const report = (startedAt, sentenceId) => ({
  state: 'done',
  reason: null,
  instructions: 'Gloss the words.',
  startedBy: userId,
  model: 'e2e-scripted',
  startedAt,
  finishedAt: new Date().toISOString(),
  pausedForPeopleS: 0,
  pausedForModelS: 0,
  stopped: null,
  totals: { documentsDone: 1, sentences: 1, words: 2 },
  documents: [
    {
      documentId,
      name: DOC,
      state: 'done',
      sentences: 1,
      targets: 1,
      done: 1,
      counts: { words: 2, left: 1 },
      skipped: [],
      glossGroup: null,
      harmonizeGroup: null,
      left: [{ ref: 's1.w2', sentenceId, begin: 4, form: 'pele' }],
      leftMore: 0,
    },
  ],
  harmonize: { changed: [], left: [], changedMore: 0, leftMore: 0 },
  entries: {
    created: [],
    deleted: [],
    unlinked: [],
    createdMore: 0,
    deletedMore: 0,
    unlinkedMore: 0,
    lexicons: [],
  },
});

test.beforeAll(async () => {
  ({ userId } = readToken());
  client = new PlaidClient(CORE, readToken().token);
  ({ projectId, documentId } = await createScratchProject({
    name: `assistant job discuss ${Date.now()}`,
    docName: DOC,
    body: 'kai pele tuna',
  }));
  const raw = await client.documents.get(documentId, true);
  const sentenceId = raw.textLayers
    .find((l) => roleOf(l) === ROLES.BASELINE)
    .tokenLayers.find((l) => roleOf(l) === ROLES.SENTENCE).tokens[0].id;
  jobId = (
    await client.jobs.create(projectId, {
      app: 'igt',
      instructions: 'Gloss the words.',
      documents: [documentId],
    })
  ).id;
  const worker = fakeJobWorker(client);
  const claimed = await worker.claim();
  expect(claimed.id).toBe(jobId);
  await worker.finish(jobId, { state: 'done', report: report(claimed.startedAt, sentenceId) });
});

test.afterAll(async () => {
  if (projectId) await client.projects.delete(projectId).catch(() => {});
});

// The word's morphemes, as {form, gloss}, read from core.
const analysisOf = async (wordBegin) => {
  const raw = await client.documents.get(documentId, true);
  const tokenLayers = raw.textLayers.find((l) => roleOf(l) === ROLES.BASELINE).tokenLayers;
  const morphs = tokenLayers.find((l) => roleOf(l) === ROLES.MORPHEME);
  const gloss = (morphs.spanLayers || []).find((s) => s.name === 'Gloss');
  return (morphs.tokens || [])
    .filter((t) => t.begin === wordBegin)
    .map((t) => ({
      form: t.metadata?.form,
      gloss: (gloss?.spans || []).find((s) => s.tokens.includes(t.id))?.value ?? null,
    }));
};

test('a job is discussed from its page, and a gloss for the word it left blank is approved', async ({
  page,
}) => {
  test.setTimeout(180_000);
  skipUnlessAgent(test);
  await seedAuth(page);
  const serviceId = 'igt:assist:e2e-discuss';
  const service = await startIgtAssistant({
    token: readToken().token,
    projectId,
    serviceId,
    script: script(jobId),
  });
  try {
    await expect
      .poll(
        async () =>
          (await client.messages.discoverServices(projectId)).some(
            (s) => s.serviceId === serviceId && s.online,
          ),
        { timeout: 90_000, message: () => `the assistant never came online:\n${service.log()}` },
      )
      .toBe(true);
    await page.goto(`/#/projects/${projectId}/jobs/${jobId}`);
    const report = page.getByRole('region', { name: 'Report' });
    await expect(report.getByRole('heading', { name: 'Left blank' })).toBeVisible();

    // The panel opens on a new conversation about the job.
    await page.getByRole('button', { name: 'Discuss with the assistant' }).click();
    const panel = page.getByRole('complementary');
    await expect(
      panel.getByText(/^Ask about Job of .*, or about the rest of the project\.$/),
    ).toBeVisible();
    const box = panel.getByRole('textbox', { name: 'Message' });
    await expect(box).toBeEditable({ timeout: 60_000 });
    await box.fill('What did the job leave blank? Gloss it as fish.');
    await box.press('Enter');

    // The plan, approved.
    await panel.getByRole('button', { name: 'Approve as verified', exact: true }).click({
      timeout: 60_000,
    });
    await expect(panel.getByText('Applied', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => analysisOf(4)).toEqual([{ form: 'pele', gloss: 'fish' }]);

    // The record: the question asked from the job, its id and name only.
    const metas = await client.userData.list(userId, {
      prefix: `igt:assistant:${projectId}:meta:`,
      includeValues: true,
    });
    expect(metas).toHaveLength(1);
    const convId = metas[0].key.split(':').at(-1);
    expect(metas[0].value.about).toMatchObject({ jobId });
    const conv = (await client.userData.get(userId, `igt:assistant:${projectId}:conv:${convId}`))
      .value;
    expect(conv.display[0].where).toEqual({
      kind: 'job',
      id: jobId,
      name: expect.stringMatching(/^Job of /),
    });
    expect(conv.messages[0].content).toBe(
      `[Asked from the job "${jobId}"]\n\nWhat did the job leave blank? Gloss it as fish.`,
    );
    expect(JSON.stringify(conv)).not.toContain('Report sections and their rows');
    const read = conv.messages.find(
      (m) => m.role === 'tool' && m.content.includes('report section Left blank (left)'),
    );
    expect(read.content).toContain('"Story A" | ref: s1.w2 | form: pele');

    // The turn's Instructions show the job's summary the model was given.
    const prompts = await client.userData.list(userId, {
      prefix: `igt:assistant:${projectId}:prompt:${convId}:`,
      includeValues: true,
    });
    expect(prompts.some((p) => p.value.system.includes(`(job ${jobId}). Call it`))).toBe(true);

    // A reload comes back to the conversation, the message still placed on the job.
    await page.reload();
    await expect(panel.getByText('What did the job leave blank? Gloss it as fish.')).toBeVisible({
      timeout: 30_000,
    });
    await expect(panel.getByText(/^Job of /).first()).toBeVisible();
  } finally {
    await test.info().attach('assistant service log', {
      body: service.log(),
      contentType: 'text/plain',
    });
    await service.stop();
    const all = await client.userData.list(userId, { prefix: `igt:assistant:${projectId}:` });
    for (const e of all) await client.userData.delete(userId, e.key).catch(() => {});
    await client.messages.discardService(projectId, serviceId).catch(() => {});
  }
});
