import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';
import { getFixture } from './fixtureProject.js';
import { agentUnavailable, startIgtAssistant } from './assistantService.js';

// What the assistant did, on screen (design/TRANSPARENCY.md): the real IGT
// assistant on a scripted model writes text, reads the fixture document
// twice, runs code, and answers. The text before each call stays on screen,
// each step opens to its input and exactly what the tool returned (the
// round stored beside the conversation), the same after a reload.

const CORE = process.env.PLAID_CORE_URL || 'http://localhost:8085';
const DOC = 'Sample IGT Document';
const CODE = 'print(len(documents()))';

let client;
let userId;
let projectId;

test.beforeAll(async () => {
  ({ userId } = readToken());
  client = new PlaidClient(CORE, readToken().token);
  await getFixture();
  projectId = (await client.projects.list()).find((p) => p.name === 'E2E IGT Fixture').id;
});

test.beforeEach(async ({ page }) => {
  await seedAuth(page);
});

const SCRIPT = [
  {
    content: 'First I read the sample.',
    calls: [
      { name: 'read_document', arguments: { document: DOC, sentences: [1] } },
      { name: 'read_document', arguments: { document: DOC } },
    ],
  },
  {
    content: 'Now I count the documents.',
    calls: [{ name: 'run_code', arguments: { code: CODE } }],
  },
  { content: 'The project has its documents read.' },
];

test('a turn keeps its text between calls and each step opens to what the tool returned', async ({
  page,
}) => {
  const unavailable = agentUnavailable();
  test.skip(!!unavailable, unavailable);
  const serviceId = 'igt:assist:e2e-trace';
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
    const box = page.getByRole('textbox', { name: 'Message' });
    await expect(box).toBeEditable({ timeout: 30_000 });
    await box.fill('Read the sample.');
    await box.press('Enter');
    await expect(page.getByText('The project has its documents read.')).toBeVisible({
      timeout: 60_000,
    });
    convId = new URL(page.url().replace('/#/', '/')).searchParams.get('conversation');
    // The tab that watched the turn keeps its work open, text and all.
    await expect(page.getByText('First I read the sample.')).toBeVisible();
    await expect(page.getByText('Now I count the documents.')).toBeVisible();

    const rounds = await client.userData.list(userId, {
      prefix: `igt:assistant:${projectId}:round:${convId}:`,
      includeValues: true,
    });
    const calls = rounds.flatMap((e) => e.value.calls);
    expect(calls.map((c) => c.name)).toEqual(['read_document', 'read_document', 'run_code']);

    await page.reload();
    await page.getByRole('button', { name: /3 steps/ }).click();
    await expect(page.getByText('First I read the sample.')).toBeVisible();
    // The name is isolated (FSI and PDI) so a right-to-left title cannot
    // reorder the label. Both reads of the one-sentence fixture match.
    const first = page
      .getByRole('button', { name: /^Read “\u2068?Sample IGT Document\u2069?”: sentence 1 of/ })
      .first();
    await expect(first).toHaveAttribute('aria-expanded', 'false');
    await first.click();
    await expect(first).toHaveAttribute('aria-expanded', 'true');
    const panel = page.locator(`[id="${await first.getAttribute('aria-controls')}"]`);
    await expect(panel.locator('pre').last()).toHaveText(calls[0].result);
    const code = page.getByRole('button', { name: /^Read across the corpus/ });
    await code.click();
    const codePanel = page.locator(`[id="${await code.getAttribute('aria-controls')}"]`);
    await expect(codePanel.locator('pre').first()).toHaveText(CODE);
    await expect(codePanel.locator('pre').last()).toHaveText(calls[2].result);
  } finally {
    await test.info().attach('assistant service log', {
      body: service.log(),
      contentType: 'text/plain',
    });
    await service.stop();
    if (convId) {
      const all = await client.userData.list(userId, { prefix: `igt:assistant:${projectId}:` });
      for (const e of all.filter((x) => x.key.includes(convId)))
        await client.userData.delete(userId, e.key).catch(() => {});
    }
    await client.messages.discardService(projectId, serviceId).catch(() => {});
  }
});
