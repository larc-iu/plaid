import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken, CORE } from './fixtures.js';
import { getFixture } from './fixtureProject.js';
import { skipUnlessAgent, startIgtAssistant } from './assistantService.js';

// A model whose key has every request slot in use answers HTTP 429. The real
// IGT assistant waits for a free slot and the panel says so (FX-BUSY,
// PROD-CLASS 2026-11-11): the turn goes on once the model answers, and Stop
// ends the wait at once.

let client;
let userId;
let projectId;

test.beforeAll(async () => {
  ({ userId } = readToken());
  client = new PlaidClient(CORE, readToken().token);
  ({ projectId } = await getFixture());
});

test.beforeEach(async ({ page }) => {
  await seedAuth(page);
});

const WAITING = 'The model is busy. Waiting for a free slot…';

async function withAssistant(page, serviceId, script, body) {
  skipUnlessAgent(test);
  const service = await startIgtAssistant({
    token: readToken().token,
    projectId,
    serviceId,
    script,
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
    await body(box);
    convId = new URL(page.url().replace('/#/', '/')).searchParams.get('conversation');
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
}

test('a busy model is waited for, the panel says so, and the turn answers', async ({ page }) => {
  await withAssistant(
    page,
    'igt:assist:e2e-busy',
    [{ busy: 4 }, { content: 'Here is the answer.' }],
    async (box) => {
      await box.fill('How many documents are there?');
      await box.press('Enter');
      await expect(page.getByRole('status').filter({ hasText: WAITING })).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText('Here is the answer.')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText(WAITING)).toHaveCount(0);
    },
  );
});

test('Stop ends the wait for a busy model at once', async ({ page }) => {
  await withAssistant(
    page,
    'igt:assist:e2e-busy-stop',
    [{ busy: 120 }, { content: 'Never asked for.' }],
    async (box) => {
      await box.fill('How many documents are there?');
      await box.press('Enter');
      await expect(page.getByRole('status').filter({ hasText: WAITING })).toBeVisible({
        timeout: 30_000,
      });
      const pressed = Date.now();
      await page.getByRole('button', { name: 'Stop' }).click();
      await expect(page.getByText('Stopped.').first()).toBeVisible({ timeout: 15_000 });
      expect(Date.now() - pressed).toBeLessThan(15_000);
      await expect(page.getByText(WAITING)).toHaveCount(0);
      await expect(page.getByText('Never asked for.')).toHaveCount(0);
    },
  );
});
