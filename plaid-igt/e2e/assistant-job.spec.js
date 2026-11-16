import PlaidClient, { ROLES } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken, CORE } from './fixtures.js';
import { createScratchProject, roleOf } from './fixtureProject.js';
import { runScriptedJobWorker, skipUnlessAgent, startIgtAssistant } from './assistantService.js';
import { fakeJobWorker } from './jobWorker.js';

// A job scoped in the chat (BRIEF-JB): the real IGT assistant on a scripted
// model reads the document and asks, then drafts the job with propose_job.
// The card shows what the job covers, what it fills and the brief to edit
// (an ordinary conversation's card binds the job as a job setup's does),
// Start job makes the job as the signed-in user under the card's id with the
// edited brief and the card's setup,
// the card says it started and links the job, the model is told so in the
// record, and the card reads the same after a reload. The worker is the
// spec's own (jobWorker.js): it takes the job and ends it with a report whose
// "Left blank" list links into the grid. Then a second card is drafted and
// discarded. A throwaway project, deleted afterwards with its jobs.
//
// Set up job (BRIEF-SU) opens the panel on a new conversation marked
// job-setup, whose every turn tells the model so. The model asks propose_job
// for the facts, asks the person about the rest, and drafts a card that shows
// what the job fills and whether it may edit the text. The job started from it
// carries them as its setup, which its page says, and plaid-agent's own worker
// on a scripted model (runScriptedJobWorker) holds its planner to it: a plan
// naming another field is refused with the setup's line, the next is kept and
// the job fills Gloss. The Jobs tab's "⋯" menu still opens the Start job
// form with an assistant online, and a window too narrow for the panel opens
// the Assistant tab on the new conversation.

const DOC = 'Story A';
const BRIEF = 'Gloss kai as "go".';
const EDITED = `${BRIEF} Leave pele unanalysed.`;

const draft = (brief) => [
  {
    content: '',
    calls: [
      {
        name: 'propose_job',
        // fills is required in every conversation, not only a job setup.
        arguments: { action: 'draft', documents: [DOC], brief, fills: ['Gloss'] },
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

// The Gloss field's id, as a card names it.
const glossIdOf = (project) =>
  project.textLayers
    .flatMap((t) => t.tokenLayers || [])
    .flatMap((t) => t.spanLayers || [])
    .find((l) => l.name === 'Gloss').id;

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
    // A card drafted in an ordinary conversation binds the job as a job
    // setup's does: what it fills, and the text left as it is.
    const row = (label) =>
      card.locator(`xpath=.//dt[normalize-space()="${label}"]/following-sibling::dd[1]`);
    await expect(row('Fills')).toHaveText('Gloss');
    await expect(row('Text')).toHaveText('Unchanged');
    const brief = card.getByRole('textbox', { name: 'Instructions' });
    await expect(brief).toHaveValue(BRIEF);
    await brief.fill(EDITED);
    await expect(card.getByTestId('job-instructions-count')).toContainText(
      `${EDITED.length} / 2,000`,
    );
    await card.getByRole('button', { name: 'Start job' }).click();
    // Started, and waiting in the queue until a worker claims it: the badge
    // says what the job page says (REV-RPF-P-7, REV-RPF2-0).
    await expect(card.getByTestId('job-card-state')).toHaveText('Waiting', { timeout: 30_000 });
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
    expect(job.setup).toEqual({
      fills: [{ id: glossIdOf(await client.projects.get(projectId)), name: 'Gloss' }],
      text: false,
      conversation: convId,
    });
    // No turn of an ordinary conversation is told of a job setup.
    for (const body of service.asked())
      expect(body.messages[0].content).not.toContain('This conversation sets up an assistant job.');
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
    const state = page.getByTestId('job-card').getByTestId('job-card-state');
    await expect(state).toHaveText('Waiting', { timeout: 30_000 });
    await expect(page.getByTestId('job-card-brief')).toHaveText(EDITED);

    // The worker takes it and ends it, and the report says what it left. Once
    // claimed, the card the page still shows reads Started.
    const worker = fakeJobWorker(client);
    const claimed = await worker.claim();
    expect(claimed.id).toBe(jobId);
    await expect(state).toHaveText('Started', { timeout: 30_000 });
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
    await expect(page.getByTestId('job-setup')).toHaveText(
      'Set up to fill Gloss. Text unchanged. Open conversation',
    );
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
    // Its job claimed and ended: Started.
    await expect(page.getByTestId('job-card').first().getByTestId('job-card-state')).toHaveText(
      'Started',
    );
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

test('Set up job: facts, a question, a card that binds the job, and a planner held to it', async ({
  page,
}) => {
  test.setTimeout(300_000);
  skipUnlessAgent(test);
  await seedAuth(page);
  const glossId = glossIdOf(await client.projects.get(projectId));
  const SETUP_SCRIPT = [
    // Turn 1: what the documents hold, then the question about the rest.
    {
      content: '',
      calls: [{ name: 'propose_job', arguments: { action: 'facts', documents: [DOC] } }],
    },
    { content: 'Gloss is empty on every word of Story A. Translation is empty too: fill it?' },
    // Turn 2: the person answered, the draft with what they agreed to.
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
  let worker = null;
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
    await box.fill('Gloss Story A.');
    const sent = sendRequest(page);
    await box.press('Enter');
    const payload = JSON.parse((await sent).postData());
    expect(payload).toMatchObject({ op: 'send', create: true, purpose: 'job-setup' });
    const convId = payload['conversation-id'];

    // The service kept the purpose and told the model what the conversation
    // is for, and facts answered the planner's own lines.
    await expect(panel.getByText('Translation is empty too: fill it?')).toBeVisible({
      timeout: 60_000,
    });
    await expect(panel.getByTestId('job-card')).toHaveCount(0);
    const turn1 = service.asked();
    expect(turn1).toHaveLength(2);
    for (const body of turn1)
      expect(body.messages[0].content).toContain('This conversation sets up an assistant job.');
    const factsAnswer = turn1[1].messages.find((m) => m.role === 'tool').content;
    expect(factsAnswer).toContain("What a job can fill (name them in propose_job's fills):");
    expect(factsAnswer).toContain('"Gloss"');
    expect(factsAnswer).toContain('- "Story A": 1 sentence');
    const meta = (await client.userData.get(userId, `igt:assistant:${projectId}:meta:${convId}`))
      .value;
    expect(meta.purpose).toBe('job-setup');

    // The answer, and the card. A later send carries no purpose.
    await box.fill('Only Gloss. Leave the text as it is.');
    const second = sendRequest(page);
    await box.press('Enter');
    expect(JSON.parse((await second).postData())).not.toHaveProperty('purpose');
    const card = panel.getByTestId('job-card');
    await expect(card).toBeVisible({ timeout: 60_000 });
    for (const body of service.asked().slice(2))
      expect(body.messages[0].content).toContain('This conversation sets up an assistant job.');
    const key = `igt:assistant:${projectId}:conv:${convId}`;
    // The card as the page receives it: `edits_text` read as `editsText`.
    const stored = (await client.userData.get(userId, key)).value.display.find((d) => d.job).job;
    expect(stored.fills).toEqual([{ id: glossId, name: 'Gloss' }]);
    expect(stored.editsText).toBe(false);

    const row = (label) =>
      card.locator(`xpath=.//dt[normalize-space()="${label}"]/following-sibling::dd[1]`);
    await expect(row('Fills')).toHaveText('Gloss');
    await expect(row('Text')).toHaveText('Unchanged');
    await card.getByRole('button', { name: 'Start job' }).click();
    // No worker has claimed it yet (REV-RPF2-0).
    await expect(card.getByTestId('job-card-state')).toHaveText('Waiting', { timeout: 30_000 });

    // The job carries the card's setup and the conversation's id.
    jobId = stored.id;
    const job = await client.jobs.get(jobId);
    expect(job.setup).toEqual({
      fills: [{ id: glossId, name: 'Gloss' }],
      text: false,
      conversation: convId,
    });

    // Its page says so from its creation on, and links the conversation for
    // its starter.
    await card.getByRole('link', { name: 'Open job' }).click();
    await expect(page).toHaveURL(new RegExp(`#/projects/${projectId}/jobs/${jobId}$`));
    const line = page.getByTestId('job-setup');
    await expect(line).toHaveText('Set up to fill Gloss. Text unchanged. Open conversation');

    // plaid-agent's worker takes it. Its planner names a field the setup
    // leaves out, is refused with the setup's line, plans within it, and the
    // job fills Gloss.
    worker = await runScriptedJobWorker({
      token: readToken().token,
      script: [
        {
          calls: [
            {
              name: 'plan_work',
              arguments: { pieces: 'sentences', fills: ['Gloss', 'Translation'] },
            },
          ],
        },
        { calls: [{ name: 'plan_work', arguments: { pieces: 'sentences', fills: ['Gloss'] } }] },
        { content: 'Planned.' },
        {
          calls: [
            {
              name: 'set_field',
              arguments: { document: DOC, refs: ['s1.w1.m1'], field: 'Gloss', value: 'go' },
            },
          ],
        },
        { content: 'Done.' },
      ],
    });
    expect(worker.code, worker.log).toBe(0);
    expect(worker.traces).toContain(
      'This job was set up to fill only \\"Gloss\\". It may not edit the text.',
    );
    expect(worker.traces).toContain(
      'fills: this job was set up to fill only \\"Gloss\\". Leave out \\"Translation\\".',
    );
    const ended = await client.jobs.get(jobId);
    expect(ended.state, JSON.stringify(ended.report)).toBe('done');
    expect(ended.report.plan.fillsNames).toEqual(['Gloss']);
    const doc = await client.documents.get(documentId, true);
    const glossed = doc.textLayers
      .flatMap((t) => t.tokenLayers || [])
      .flatMap((t) => t.spanLayers || [])
      .find((l) => l.id === glossId).spans;
    expect(glossed.map((s) => s.value)).toEqual(['go']);

    // The page of the ended job still says what it was set up to do, and its
    // link opens the conversation, its card started.
    await page.reload();
    await expect(page.getByRole('region', { name: 'Report' })).toBeVisible({ timeout: 30_000 });
    await expect(line).toHaveText('Set up to fill Gloss. Text unchanged. Open conversation');
    await line.getByRole('link', { name: 'Open conversation' }).click();
    await expect(page).toHaveURL(
      new RegExp(`#/projects/${projectId}\\?tab=assistant&conversation=${convId}$`),
    );
    // The worker claimed and ended it: Started.
    await expect(page.getByTestId('job-card').getByTestId('job-card-state')).toHaveText('Started', {
      timeout: 30_000,
    });
  } finally {
    if (worker) {
      await test.info().attach('job worker log', { body: worker.log, contentType: 'text/plain' });
      await test.info().attach('job worker traces', {
        body: worker.traces,
        contentType: 'text/plain',
      });
    }
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

// RP-2: a setup conversation's first reply staged a plan with Approve, and a
// later reply drafted the job card. The plan stayed approvable beside the job.
// A reply that carries a job card now marks every plan still waiting
// replaced (RPF-A, b012f7bac): the plan card reads Replaced with no Approve,
// in the record as on the page, and the box no longer asks about it.
test('a plan staged before a job card is drafted is replaced once the card appears', async ({
  page,
}) => {
  test.setTimeout(180_000);
  skipUnlessAgent(test);
  await seedAuth(page);
  const serviceId = 'igt:assist:e2e-plan-then-card';
  const service = await startIgtAssistant({
    token: readToken().token,
    projectId,
    serviceId,
    script: [
      {
        content: '',
        calls: [
          {
            // A value no earlier test writes: their jobs gloss kai "go".
            name: 'set_field',
            arguments: { document: DOC, refs: ['s1.w1.m1'], field: 'Gloss', value: 'walk' },
          },
        ],
      },
      { content: 'Here is kai glossed "walk" in sentence 1.' },
      ...draft(BRIEF),
    ],
  });
  try {
    await waitOnline(serviceId, service);
    await page.goto(`/#/projects/${projectId}`);
    await page.getByRole('button', { name: 'Set up job' }).click();
    const panel = page.getByRole('complementary');
    await expect(panel.getByText('Say what the job should do.', { exact: true })).toBeVisible();

    await send(page, 'Gloss kai as "walk".');
    const plan = panel.getByText('Proposed changes', { exact: true }).locator('xpath=../..');
    await expect(plan).toBeVisible({ timeout: 60_000 });
    await expect(plan.getByRole('button', { name: 'Approve as unverified' })).toBeVisible();
    const box = panel.getByRole('textbox', { name: 'Message' });
    await expect(box).toHaveAttribute('placeholder', /^Approve or discard the plan above/);

    await send(page, 'Make it a job.');
    await expect(panel.getByTestId('job-card')).toBeVisible({ timeout: 60_000 });
    await expect(plan).toContainText('Replaced');
    await expect(plan.getByRole('button', { name: /^Approve/ })).toHaveCount(0);
    await expect(box).not.toHaveAttribute('placeholder', /Approve or discard/);
    // The record, as the service settled it.
    const records = await Promise.all(
      (await client.userData.list(userId, { prefix: `igt:assistant:${projectId}:conv:` })).map(
        async (e) => (await client.userData.get(userId, e.key)).value,
      ),
    );
    const stored = records.find((c) => (c.display || []).some((d) => d.job));
    const staged = stored.display.find((d) => d.plan);
    expect(staged.status).toBe('replaced');
    expect(stored.display.find((d) => d.job).job.status ?? null).toBe(null);

    // The same after a reload.
    await page.reload();
    await expect(panel.getByTestId('job-card')).toBeVisible({ timeout: 30_000 });
    await expect(plan).toContainText('Replaced');
    await expect(plan.getByRole('button', { name: /^Approve/ })).toHaveCount(0);
  } finally {
    await cleanUp(service, serviceId);
  }
});
