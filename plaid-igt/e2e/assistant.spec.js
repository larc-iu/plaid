import PlaidClient, { ROLES, uuidv7 } from '@larc-iu/plaid-client';
import { randomUUID } from 'node:crypto';
import { test, expect, seedAuth, readToken } from './fixtures.js';
import { getFixture } from './fixtureProject.js';
import { agentUnavailable, startIgtAssistant } from './assistantService.js';

// The Assistant tab, without a model: conversations are records in the
// user's key/value store that the service writes, so a plan can be seeded
// straight into one (the ops name real layers, tokens, and spans of the
// "E2E IGT Fixture" project) and the tab is driven from there. Applying a
// plan needs an `assist` service online: that test starts the real one
// against a scripted model (assistantService.js), and skips only where the
// plaid-agent Python env is missing.
//
// Covers: the plan card (grouped under the document, the word linked into
// the editor), Discard, a turn whose request is gone (Retry offered and the
// record settled), the tab opening on a new conversation with the sidebar
// linking each saved one, and Approve.

const CORE = 'http://localhost:8085';
const roleOf = (l) => l?.config?.plaid?.role;

let client;
let userId;
let projectId;
let doc; // {id, name, version, sentenceId, wordId, wordBegin, surface}
let pos; // the Part of Speech span layer on words
let posSpan; // {id, value} of the first word's current POS span, or null
const seeded = []; // conversation ids to delete
const key = (kind, id) => `igt:assistant:${projectId}:${kind}:${id}`;

const seedConversation = async ({
  display,
  messages = [],
  pending = null,
  title,
  updatedAt = new Date().toISOString(),
}) => {
  const id = randomUUID();
  seeded.push(id);
  await client.userData.put(userId, key('conv', id), { messages, display });
  await client.userData.put(userId, key('meta', id), {
    id,
    title,
    createdAt: updatedAt,
    updatedAt,
    serviceId: 'igt:assist:e2e',
    model: 'e2e/model',
    turns: 1,
    pending,
  });
  return id;
};

const planFor = (value) => ({
  // A UUIDv7, as a staged plan's is: an approved plan draws the ids of what
  // it creates from it.
  id: uuidv7(),
  summary: '1 field value',
  labels: [`${doc.name} s1.w1 "${doc.surface}": ${pos.name} = "${value}"`],
  ops: [
    {
      kind: 'set_span',
      layerId: pos.id,
      tokenId: doc.wordId,
      spanId: posSpan?.id ?? null,
      value,
      label: `${doc.name} s1.w1 "${doc.surface}": ${pos.name} = "${value}"`,
    },
  ],
  changes: [
    {
      label: `${doc.name} s1.w1 "${doc.surface}": ${pos.name} = "${value}"`,
      change: `${pos.name} = "${value}"`,
      where: {
        kind: 'token',
        documentId: doc.id,
        documentName: doc.name,
        sentenceId: doc.sentenceId,
        sentence: 1,
        word: 1,
        morpheme: null,
        begin: doc.wordBegin,
        surface: doc.surface,
      },
    },
  ],
  documents: [{ id: doc.id, name: doc.name, version: doc.version }],
});

const planConversation = (value) => ({
  title: `e2e plan ${value}`,
  messages: [
    { role: 'user', content: `set ${pos.name} to ${value}` },
    { role: 'assistant', content: 'Planned.' },
  ],
  display: [
    { kind: 'user', text: `set ${pos.name} to ${value}` },
    {
      kind: 'assistant',
      text: 'Here is the plan.',
      plan: planFor(value),
      citations: [],
      status: null,
      model: 'e2e/model',
      steps: [],
      stepsSummary: '',
    },
  ],
});

const readPos = async () => {
  const raw = await client.documents.get(doc.id, true);
  const word = raw.textLayers
    .find((l) => roleOf(l) === ROLES.BASELINE)
    .tokenLayers.find((l) => roleOf(l) === ROLES.WORD);
  const layer = word.spanLayers.find((s) => s.id === pos.id);
  const span = (layer.spans || []).find((s) => (s.tokens || []).includes(doc.wordId));
  return span ? { id: span.id, value: span.value } : null;
};

test.beforeAll(async () => {
  ({ userId } = readToken());
  client = new PlaidClient(CORE, readToken().token);
  await getFixture(); // builds the fixture project where the database lacks it
  const project = (await client.projects.list()).find((p) => p.name === 'E2E IGT Fixture');
  if (!project) throw new Error('run node e2e/fixtureProject.js first');
  projectId = project.id;
  const full = await client.projects.get(projectId);
  const textLayer = full.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const WORD = textLayer.tokenLayers.find((l) => roleOf(l) === ROLES.WORD);
  pos = WORD.spanLayers.find((s) => s.name === 'Part of Speech');
  const summary = (await client.projects.listDocuments(projectId)).find(
    (d) => d.name === 'Sample IGT Document',
  );
  const raw = await client.documents.get(summary.id, true);
  const tl = raw.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const body = tl.text.body;
  const byBegin = (a, b) => a.begin - b.begin;
  const sentence = [...tl.tokenLayers.find((l) => roleOf(l) === ROLES.SENTENCE).tokens].sort(
    byBegin,
  )[0];
  const word = [...tl.tokenLayers.find((l) => roleOf(l) === ROLES.WORD).tokens].sort(byBegin)[0];
  doc = {
    id: raw.id,
    name: raw.name,
    version: raw.version,
    sentenceId: sentence.id,
    wordId: word.id,
    wordBegin: word.begin,
    surface: body.slice(word.begin, word.end),
  };
  posSpan = await readPos();
});

test.afterAll(async () => {
  for (const id of seeded) {
    for (const k of [key('conv', id), key('meta', id)]) {
      await client.userData.delete(userId, k).catch(() => {});
    }
  }
  // Whatever the approve test wrote, the fixture goes back to how it was.
  const now = await readPos();
  if (now && !posSpan) await client.spans.delete(now.id);
  else if (now && posSpan && now.value !== posSpan.value)
    await client.spans.update(now.id, posSpan.value);
});

test.beforeEach(async ({ page }) => {
  await seedAuth(page);
});

test('the plan card groups a change under its document, links the word, and Discard settles it', async ({
  page,
}) => {
  const id = await seedConversation(planConversation('E2E-DISCARD'));
  await page.goto(`/#/projects/${projectId}?tab=assistant&conversation=${id}`);
  const card = page.locator('text=Proposed changes').locator('..').locator('..');
  await expect(card).toBeVisible();
  const docLink = card.getByRole('link', { name: doc.name });
  await expect(docLink).toHaveAttribute('href', new RegExp(`/documents/${doc.id}$`));
  const wordLink = card.getByRole('link', { name: doc.surface, exact: true });
  await expect(wordLink).toHaveAttribute(
    'href',
    new RegExp(`focusSentence=${doc.sentenceId}&focusWord=${doc.wordBegin}`),
  );
  await expect(card).toContainText('s1.w1');
  await expect(card).toContainText(`${pos.name} = "E2E-DISCARD"`);

  await card.getByRole('button', { name: 'Discard' }).click();
  await expect(card.getByText('Discarded')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Discard' })).toHaveCount(0);
  // The decision is in the record, and survives a reload.
  await expect
    .poll(async () => (await client.userData.get(userId, key('conv', id))).value.display[1].status)
    .toBe('discarded');
  await page.reload();
  await expect(page.getByText('Discarded')).toBeVisible();
});

// A marker names a request its page may not have sent yet (it claims the
// conversation first, then writes the message, then sends it), so a page that
// finds no such request asks again for up to 15 seconds from when the marker
// was set (`SUBMIT_GRACE_MS` in plaid-ui jobs.js) before it takes it as lost.
const lostTurn = (title, startedAt) =>
  seedConversation({
    title,
    messages: [{ role: 'user', content: 'Anything there?' }],
    display: [{ kind: 'user', text: 'Anything there?' }],
    pending: {
      kind: 'turn',
      requestId: randomUUID(), // the server has never heard of it
      serviceId: 'igt:assist:e2e',
      startedAt,
    },
  });

test('a turn whose request is gone offers Retry and clears the pending marker', async ({
  page,
}) => {
  // Left by a page that went away a minute ago.
  const id = await lostTurn('e2e lost turn', new Date(Date.now() - 60 * 1000).toISOString());
  await page.goto(`/#/projects/${projectId}?tab=assistant&conversation=${id}`);
  await expect(page.getByText('No answer came back for this message.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect
    .poll(async () => (await client.userData.get(userId, key('meta', id))).value.pending)
    .toBeNull();
  // Not listed as unfinished any more.
  await expect(page.getByText('unfinished')).toHaveCount(0);
});

test('a turn just marked whose request never comes ends the same way after the wait', async ({
  page,
}) => {
  const id = await lostTurn('e2e lost young turn', new Date().toISOString());
  await page.goto(`/#/projects/${projectId}?tab=assistant&conversation=${id}`);
  await expect(page.getByText('No answer came back for this message.')).toBeVisible({
    timeout: 25000,
  });
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect
    .poll(async () => (await client.userData.get(userId, key('meta', id))).value.pending)
    .toBeNull();
});

test('the tab opens on a new conversation, and the sidebar links each saved one', async ({
  page,
}) => {
  const id = await seedConversation(planConversation('E2E-LIST'));
  await page.goto(`/#/projects/${projectId}?tab=assistant`);
  await expect(page.getByText('Nothing sent yet')).toBeVisible();
  await expect(page.getByPlaceholder(/Message the assistant|No assistant online/)).toBeVisible();
  const row = page.getByRole('link', { name: /e2e plan E2E-LIST/ });
  await expect(row).toHaveAttribute('href', new RegExp(`conversation=${id}$`));
  await row.click();
  await expect(page).toHaveURL(new RegExp(`conversation=${id}`));
  await expect(page.getByText('Proposed changes')).toBeVisible();
  // "+" leaves the conversation: a new one, and no conversation in the URL.
  await page.getByRole('button', { name: 'New conversation' }).click();
  await expect(page).not.toHaveURL(/conversation=/);
  await expect(page.getByText('Nothing sent yet')).toBeVisible();
});

test('opening a conversation leaves the list in the order it was in', async ({ page }) => {
  // The list is ordered by when each conversation was last written to, and
  // opening one only reads it. The read used to hoist the row it read to the
  // top, which moved every other row out from under the pointer that had just
  // clicked one.
  const stamps = [
    '2021-01-01T00:00:00.000Z',
    '2022-01-01T00:00:00.000Z',
    '2023-01-01T00:00:00.000Z',
  ];
  const ids = [];
  for (const [i, updatedAt] of stamps.entries()) {
    ids.push(
      await seedConversation({
        title: `E2E-ORDER-${i}`,
        display: [{ kind: 'user', text: `ordered question ${i}` }],
        updatedAt,
      }),
    );
  }

  await page.goto(`/#/projects/${projectId}?tab=assistant`);
  const sidebar = page.getByRole('complementary').first();
  const rows = sidebar.getByRole('link');
  await expect(sidebar.getByRole('link', { name: /E2E-ORDER-2/ })).toBeVisible();
  // By href, not by text: a row says how long ago it was written, and the
  // draft row at the top is not a link at all.
  const order = () => rows.evaluateAll((els) => els.map((e) => e.getAttribute('href')));
  const before = await order();

  // The oldest of the three, which is the furthest it could be moved.
  await sidebar.getByRole('link', { name: /E2E-ORDER-0/ }).click();
  await expect(page.getByText('ordered question 0')).toBeVisible();
  expect(await order()).toEqual(before);
  expect(before.filter((h) => h.includes(ids[0]))).toHaveLength(1);
});

test('approving a plan applies it under the user and settles the card', async ({ page }) => {
  test.setTimeout(150_000);
  const unavailable = agentUnavailable();
  test.skip(!!unavailable, unavailable);
  const serviceId = 'igt:assist:e2e-fake';
  const service = await startIgtAssistant({ token: readToken().token, projectId, serviceId });
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
    const value = `E2E-${Date.now()}`;
    const conversation = planConversation(value);
    // The turn that staged a plan records the assistant that proposed it, and
    // the service refuses a plan that does not say (its writes are stamped
    // with that name).
    conversation.display[1].service = serviceId;
    const id = await seedConversation(conversation);
    // The service refuses a plan whose assistant is not the one asked; the
    // conversation names the one started here.
    await client.userData.put(userId, key('meta', id), {
      ...(await client.userData.get(userId, key('meta', id))).value,
      serviceId,
    });
    await page.goto(`/#/projects/${projectId}?tab=assistant&conversation=${id}`);
    await page.getByRole('button', { name: 'Approve and apply' }).click();
    await expect(page.getByText('Applied', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await readPos())?.value).toBe(value);
    const record = (await client.userData.get(userId, key('conv', id))).value;
    expect(record.display[1].status).toBe('applied');
    expect(record.messages.at(-1).content).toMatch(/approved and applied/);
    expect((await client.userData.get(userId, key('meta', id))).value.pending).toBeNull();
  } finally {
    await test.info().attach('assistant service log', {
      body: service.log(),
      contentType: 'text/plain',
    });
    await service.stop();
    // Forgotten once its channel has closed (a live one is refused, 409), so
    // no offline assistant is left on the fixture project.
    await expect
      .poll(
        () =>
          client.messages.discardService(projectId, serviceId).then(
            () => true,
            () => false,
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
  }
});
