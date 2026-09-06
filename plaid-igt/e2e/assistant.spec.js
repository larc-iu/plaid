import PlaidClient, { ROLES } from '@larc-iu/plaid-client';
import { randomUUID } from 'node:crypto';
import { test, expect, seedAuth, readToken } from './fixtures.js';

// The Assistant tab, without a model: conversations are records in the
// user's key/value store that the service writes, so a plan can be seeded
// straight into one (the ops name real layers, tokens, and spans of the
// "E2E IGT Fixture" project) and the tab is driven from there. Applying a
// plan needs an `assist` service online; that test skips when none is.
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

const seedConversation = async ({ display, messages = [], pending = null, title }) => {
  const id = randomUUID();
  seeded.push(id);
  await client.userData.put(userId, key('conv', id), { messages, display });
  await client.userData.put(userId, key('meta', id), {
    id,
    title,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    serviceId: 'igt:assist:e2e',
    model: 'e2e/model',
    turns: 1,
    pending,
  });
  return id;
};

const planFor = (value) => ({
  id: randomUUID(),
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
  const project = (await client.projects.list()).find((p) => p.name === 'E2E IGT Fixture');
  if (!project) throw new Error('run node e2e/fixture.js first');
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

test('a turn whose request is gone offers Retry and clears the pending marker', async ({
  page,
}) => {
  const id = await seedConversation({
    title: 'e2e lost turn',
    messages: [{ role: 'user', content: 'Anything there?' }],
    display: [{ kind: 'user', text: 'Anything there?' }],
    pending: {
      kind: 'turn',
      requestId: randomUUID(), // the server has never heard of it
      serviceId: 'igt:assist:e2e',
      startedAt: new Date().toISOString(),
    },
  });
  await page.goto(`/#/projects/${projectId}?tab=assistant&conversation=${id}`);
  await expect(page.getByText('No answer came back for this message.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect
    .poll(async () => (await client.userData.get(userId, key('meta', id))).value.pending)
    .toBeNull();
  // Not listed as unfinished any more.
  await expect(page.getByText('unfinished')).toHaveCount(0);
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

test('approving a plan applies it under the user and settles the card', async ({ page }) => {
  const services = await client.messages.discoverServices(projectId);
  const assistant = services.find((s) => s.online && (s.extras?.tasks || []).includes('assist'));
  test.skip(!assistant, 'no assist service online on the fixture project');
  const value = `E2E-${Date.now()}`;
  const id = await seedConversation({
    ...planConversation(value),
    // The service refuses a plan whose assistant is not the one asked; the
    // conversation names the one online.
  });
  await client.userData.put(userId, key('meta', id), {
    ...(await client.userData.get(userId, key('meta', id))).value,
    serviceId: assistant.serviceId,
  });
  await page.goto(`/#/projects/${projectId}?tab=assistant&conversation=${id}`);
  await page.getByRole('button', { name: 'Approve and apply' }).click();
  await expect(page.getByText('Applied', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await readPos())?.value).toBe(value);
  const record = (await client.userData.get(userId, key('conv', id))).value;
  expect(record.display[1].status).toBe('applied');
  expect(record.messages.at(-1).content).toMatch(/approved and applied/);
  expect((await client.userData.get(userId, key('meta', id))).value.pending).toBeNull();
});
