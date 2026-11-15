import PlaidClient, { ROLES } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken, CORE } from './fixtures.js';
import { createScratchProject, roleOf } from './fixtureProject.js';
import { skipUnlessAgent, startIgtAssistant } from './assistantService.js';
import { fakeJobWorker } from './jobWorker.js';

// A job scoped in the chat (BRIEF-JB): the real IGT assistant on a scripted
// model reads the document and asks, then drafts the job with propose_job.
// The card shows what the job covers and the brief to edit, Start job makes
// the job as the signed-in user under the card's id with the edited brief,
// the card says it started and links the job, the model is told so in the
// record, and the card reads the same after a reload. The worker is the
// spec's own (jobWorker.js): it takes the job and ends it with a report whose
// "Left blank" list links into the grid. Then a second card is drafted and
// discarded. A throwaway project, deleted afterwards with its jobs.
//
// Set up job (BRIEF-SU) opens the panel on a new conversation marked
// job-setup, whose card shows what the job fills and whether it may edit the
// text, and the job started from it carries them as its setup, which its page
// says. The Jobs tab's "⋯" menu still opens the Start job form with an
// assistant online, and a window too narrow for the panel opens the
// Assistant tab on the new conversation.

const DOC = 'Story A';
const BRIEF = 'Gloss kai as "go".';
const EDITED = `${BRIEF} Leave pele unanalysed.`;

const draft = (brief) => [
  {
    content: '',
    calls: [
      {
        name: 'propose_job',
        arguments: { action: 'draft', documents: [DOC], brief },
      },
    ],
  },
  { content: 'Here is the job. Start it from the card when the instructions read right.' },
];

const SCRIPT = [
  // Turn 1: read, then the question the data raised.
  { content: '', calls: [{ name: 'read_document', arguments: { document: DOC } }] },
  {
    content:
      'Story A has three unanalysed words. Should the job gloss kai as "go" here, and what of pele? ' +
      'I can analyse sentence 1 here first if you want.',
  },
  // Turn 2: the user answered, the draft.
  ...draft(BRIEF),
  // Turn 3: another draft, which the user discards.
  ...draft('Gloss tuna as "fish".'),
];

let client;
let userId;
let projectId;
let documentId;
let sentenceId;

test.beforeAll(async () => {
  ({ userId } = readToken());
  client = new PlaidClient(CORE, readToken().token);
  ({ projectId, documentId } = await createScratchProject({
    name: `assistant job ${Date.now()}`,
    docName: DOC,
    body: 'kai pele tuna',
  }));
  const raw = await client.documents.get(documentId, true);
  sentenceId = raw.textLayers
    .find((l) => roleOf(l) === ROLES.BASELINE)
    .tokenLayers.find((l) => roleOf(l) === ROLES.SENTENCE).tokens[0].id;
});

test.afterAll(async () => {
  if (projectId) await client.projects.delete(projectId).catch(() => {});
});

const send = async (page, text) => {
  const box = page.getByRole('textbox', { name: 'Message' });
  await expect(box).toBeEditable({ timeout: 60_000 });
  await box.fill(text);
  await box.press('Enter');
};

test('a job scoped in the chat is started from its card, and a second card is discarded', async ({
  page,
}) => {
  skipUnlessAgent(test);
  await seedAuth(page);
  const serviceId = 'igt:assist:e2e-job';
  const service = await startIgtAssistant({
    token: readToken().token,
    projectId,
    serviceId,
    script: SCRIPT,
  });
  let convId = null;
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
    await page.goto(`/#/projects/${projectId}?tab=assistant`);

    // The question first, before any card.
    await send(page, 'Gloss Story A overnight.');
    await expect(page.getByText('Should the job gloss kai as "go" here')).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByTestId('job-card')).toHaveCount(0);

    // The answer, and the draft.
    await send(page, 'Yes, kai is "go". Leave pele. Draft it.');
    const card = page.getByTestId('job-card');
    await expect(card).toBeVisible({ timeout: 60_000 });
    convId = new URL(page.url().replace('/#/', '/')).searchParams.get('conversation');
    await expect(card).toContainText('Proposed job');
    await expect(card.getByRole('link', { name: DOC })).toBeVisible();
    await expect(card).not.toContainText('Tasks');
    const brief = card.getByRole('textbox', { name: 'Instructions' });
    await expect(brief).toHaveValue(BRIEF);
    await brief.fill(EDITED);
    await expect(card.getByTestId('job-instructions-count')).toContainText(
      `${EDITED.length} / 2,000`,
    );
    await card.getByRole('button', { name: 'Start job' }).click();
    await expect(card).toContainText('Started');
    await expect(card.getByTestId('job-card-brief')).toHaveText(EDITED);

    // Core holds the job under the card's id, started by the person, with the
    // brief as edited.
    const conv = (await client.userData.get(userId, `igt:assistant:${projectId}:conv:${convId}`))
      .value;
    const item = conv.display.find((d) => d.job);
    const jobId = item.job.id;
    const job = await client.jobs.get(jobId);
    expect(job).toMatchObject({
      state: 'waiting',
      instructions: EDITED,
      startedBy: userId,
    });
    expect(job.documents.map((d) => d.documentId)).toEqual([documentId]);
    await expect
      .poll(async () => {
        const c = (await client.userData.get(userId, `igt:assistant:${projectId}:conv:${convId}`))
          .value;
        return c.display.find((d) => d.job)?.job;
      })
      .toMatchObject({ status: 'started', jobId, sentBrief: EDITED });
    const stored = (await client.userData.get(userId, `igt:assistant:${projectId}:conv:${convId}`))
      .value;
    expect(stored.messages.at(-1).content).toBe(
      `(note) The user changed the brief and started the job. The brief as sent:\n${EDITED}`,
    );

    // The same after a reload.
    await page.reload();
    await expect(page.getByTestId('job-card')).toContainText('Started', { timeout: 30_000 });
    await expect(page.getByTestId('job-card-brief')).toHaveText(EDITED);

    // The worker takes it and ends it, and the report says what it left.
    const worker = fakeJobWorker(client);
    const claimed = await worker.claim();
    expect(claimed.id).toBe(jobId);
    await worker.finish(jobId, {
      state: 'done',
      report: {
        state: 'done',
        reason: null,
        instructions: EDITED,
        startedBy: userId,
        model: 'e2e-scripted',
        startedAt: claimed.startedAt,
        finishedAt: new Date().toISOString(),
        pausedForPeopleS: 0,
        pausedForModelS: 0,
        stopped: null,
        totals: { documentsDone: 1, sentences: 1, words: 1 },
        documents: [
          {
            documentId,
            name: DOC,
            state: 'done',
            sentences: 1,
            targets: 1,
            done: 1,
            counts: { words: 1, left: 1 },
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
          unlinked: [],
          createdMore: 0,
          unlinkedMore: 0,
          lexicons: [],
        },
      },
    });
    await page.getByTestId('job-card').getByRole('link', { name: 'Open job' }).click();
    await expect(page).toHaveURL(new RegExp(`#/projects/${projectId}/jobs/${jobId}$`));
    const report = page.getByRole('region', { name: 'Report' });
    await expect(report.getByRole('heading', { name: 'Left blank' })).toBeVisible();
    await expect(report.getByRole('link', { name: 's1.w2' })).toHaveAttribute(
      'href',
      `#/projects/${projectId}/documents/${documentId}?tab=analyze&focusSentence=${encodeURIComponent(sentenceId)}&focusWord=4`,
    );

    // A second card, discarded: nothing starts.
    await page.goto(`/#/projects/${projectId}?tab=assistant&conversation=${convId}`);
    await send(page, 'Now one for tuna.');
    const second = page.getByTestId('job-card').nth(1);
    await expect(second).toBeVisible({ timeout: 60_000 });
    await second.getByRole('button', { name: 'Discard' }).click();
    await expect(second).toContainText('Discarded');
    await page.reload();
    await expect(page.getByTestId('job-card').nth(1)).toContainText('Discarded', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('job-card').first()).toContainText('Started');
    expect((await client.jobs.list(projectId)).length).toBe(1);
  } finally {
    await test.info().attach('assistant service log', {
      body: service.log(),
      contentType: 'text/plain',
    });
    await service.stop();
    if (convId) {
      const all = await client.userData.list(userId, { prefix: `igt:assistant:${projectId}:` });
      for (const e of all) await client.userData.delete(userId, e.key).catch(() => {});
    }
    await client.messages.discardService(projectId, serviceId).catch(() => {});
  }
});

// The service's request to send a message, as the page made it.
const sendRequest = (page) =>
  page.waitForRequest(
    (r) =>
      r.method() === 'POST' &&
      /\/services\/[^/]+\/requests/.test(r.url()) &&
      (r.postData() || '').includes('"op":"send"'),
  );

const waitOnline = (serviceId, service) =>
  expect
    .poll(
      async () =>
        (await client.messages.discoverServices(projectId)).some(
          (s) => s.serviceId === serviceId && s.online,
        ),
      { timeout: 90_000, message: () => `the assistant never came online:\n${service.log()}` },
    )
    .toBe(true);

const cleanUp = async (service, serviceId) => {
  await test.info().attach('assistant service log', {
    body: service.log(),
    contentType: 'text/plain',
  });
  await service.stop();
  const all = await client.userData.list(userId, { prefix: `igt:assistant:${projectId}:` });
  for (const e of all) await client.userData.delete(userId, e.key).catch(() => {});
  await client.messages.discardService(projectId, serviceId).catch(() => {});
};

test('Set up job opens a job setup conversation, and its card binds the job it starts', async ({
  page,
}) => {
  test.setTimeout(180_000);
  skipUnlessAgent(test);
  await seedAuth(page);
  const project = await client.projects.get(projectId);
  const glossId = project.textLayers
    .flatMap((t) => t.tokenLayers || [])
    .flatMap((t) => t.spanLayers || [])
    .find((l) => l.name === 'Gloss').id;
  const SETUP_SCRIPT = [
    {
      content: '',
      calls: [
        {
          name: 'propose_job',
          arguments: {
            action: 'draft',
            documents: [DOC],
            brief: BRIEF,
            fills: ['Gloss'],
            edits_text: false,
          },
        },
      ],
    },
    { content: 'Here is the job. It fills Gloss and leaves the text as it is.' },
  ];
  const serviceId = 'igt:assist:e2e-setup';
  const service = await startIgtAssistant({
    token: readToken().token,
    projectId,
    serviceId,
    script: SETUP_SCRIPT,
  });
  let jobId = null;
  try {
    await waitOnline(serviceId, service);
    await page.goto(`/#/projects/${projectId}`);

    // A new conversation for setting the job up, nothing sent by itself.
    await page.getByRole('button', { name: 'Set up job' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const panel = page.getByRole('complementary');
    await expect(panel.getByText('Say what the job should do.', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Past conversations' }).click();
    await expect(page.getByText('Job setup', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');

    // The send that creates it carries the purpose.
    const box = panel.getByRole('textbox', { name: 'Message' });
    await expect(box).toBeEditable({ timeout: 60_000 });
    await box.fill('Gloss Story A. Leave the text as it is.');
    const sent = sendRequest(page);
    await box.press('Enter');
    const payload = JSON.parse((await sent).postData());
    expect(payload).toMatchObject({ op: 'send', create: true, purpose: 'job-setup' });
    const convId = payload['conversation-id'];

    const card = panel.getByTestId('job-card');
    await expect(card).toBeVisible({ timeout: 60_000 });
    const key = `igt:assistant:${projectId}:conv:${convId}`;
    // The card as the page receives it: `edits_text` read as `editsText`.
    const stored = (await client.userData.get(userId, key)).value.display.find((d) => d.job).job;
    expect(stored.fills).toEqual([{ id: glossId, name: 'Gloss' }]);
    expect(stored.editsText).toBe(false);
    const name = stored.fills[0].name;

    const shown = panel.getByTestId('job-card');
    await expect(shown).toBeVisible({ timeout: 30_000 });
    const row = (label) =>
      shown.locator(`xpath=.//dt[normalize-space()="${label}"]/following-sibling::dd[1]`);
    await expect(row('Fills')).toHaveText(name);
    await expect(row('Text')).toHaveText('Unchanged');
    await shown.getByRole('button', { name: 'Start job' }).click();
    await expect(shown).toContainText('Started', { timeout: 30_000 });

    // The job carries the card's setup and the conversation's id.
    jobId = stored.id;
    const job = await client.jobs.get(jobId);
    expect(job.setup).toEqual({
      fills: [{ id: glossId, name }],
      text: false,
      conversation: convId,
    });

    // Its page says so, and links the conversation for its starter.
    await shown.getByRole('link', { name: 'Open job' }).click();
    await expect(page).toHaveURL(new RegExp(`#/projects/${projectId}/jobs/${jobId}$`));
    const line = page.getByTestId('job-setup');
    await expect(line).toHaveText(`Set up to fill ${name}. Text unchanged. Open conversation`);
    await expect(line.getByRole('link', { name: 'Open conversation' })).toHaveAttribute(
      'href',
      `#/projects/${projectId}?tab=assistant&conversation=${convId}`,
    );
  } finally {
    if (jobId) await client.jobs.cancel(jobId).catch(() => {});
    await cleanUp(service, serviceId);
  }
});

test('with an assistant online, the Jobs tab still opens the Start job form, and a narrow window opens the Assistant tab', async ({
  page,
}) => {
  test.setTimeout(120_000);
  skipUnlessAgent(test);
  await seedAuth(page);
  const serviceId = 'igt:assist:e2e-setup-hatch';
  const service = await startIgtAssistant({ token: readToken().token, projectId, serviceId });
  try {
    await waitOnline(serviceId, service);
    await page.goto(`/#/projects/${projectId}?tab=jobs`);
    await expect(page.getByRole('button', { name: 'Set up job' })).toBeVisible();

    // The "⋯" menu, by keyboard.
    await page.getByRole('button', { name: 'More job actions' }).focus();
    await page.keyboard.press('Enter');
    const item = page.getByRole('menuitem', { name: 'Start without the assistant' });
    await expect(item).toBeFocused();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Start job' })).toBeVisible();
    await expect(dialog).toContainText('All documents (1)');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);

    // Too narrow for the panel: the Assistant tab, on a new job setup
    // conversation, and the address no longer asks for one.
    await page.setViewportSize({ width: 900, height: 800 });
    await page.getByRole('button', { name: 'Set up job' }).click();
    await expect(page).toHaveURL(new RegExp(`#/projects/${projectId}\\?tab=assistant$`));
    await expect(page.getByText('Say what the job should do.', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } finally {
    await cleanUp(service, serviceId);
  }
});
