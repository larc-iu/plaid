import PlaidClient, { ROLES, TASKS, cpLength } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken, CORE } from './fixtures.js';
import { getFixture, roleOf } from './fixtureProject.js';

// A run's progress shows in one banner over the document (Luke, 2026-11-12),
// its dialog closes when it starts, and its opener turns. Leaving the
// document stops Auto-analyze after the step in flight, and coming back names
// the steps that did not run.
//
// The translation step is a service this spec serves itself, which reports
// progress and then holds its answer until the spec lets it go, so the run is
// as long as the spec needs. Throwaway document in the "E2E IGT Fixture"
// project, deleted afterwards.

const BODY = 'alpha beta gamma';
const SERVICE = {
  serviceId: `e2e-run-banner-${Date.now().toString(36)}`,
  serviceName: 'Banner probe',
  description: 'Holds a translation request until the spec lets it go.',
};

let client;
let projectId;
let documentId;
let registration;
// The requests the service has been sent and not answered, and their helpers.
const held = [];

const waitFor = async (check, what, ms = 15000) => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

test.beforeAll(async () => {
  client = new PlaidClient(CORE, readToken().token);
  ({ projectId } = await getFixture());
  const full = await client.projects.get(projectId);
  const textLayer = full.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const layer = (role) => textLayer.tokenLayers.find((l) => roleOf(l) === role);
  const created = await client.documents.create(projectId, `run-banner ${Date.now()}`);
  documentId = created.id;
  await client.texts.create(textLayer.id, documentId, BODY);
  const raw = await client.documents.get(documentId, true);
  const TEXT = raw.textLayers.find((l) => roleOf(l) === ROLES.BASELINE).text.id;
  const words = [...BODY.matchAll(/\S+/g)].map((m) => ({
    begin: m.index,
    end: m.index + m[0].length,
  }));
  await client.tokens.bulkCreate([
    { tokenLayerId: layer(ROLES.SENTENCE).id, text: TEXT, begin: 0, end: cpLength(BODY) },
  ]);
  await client.tokens.bulkCreate(
    words.map((w) => ({ tokenLayerId: layer(ROLES.WORD).id, text: TEXT, ...w })),
  );

  registration = client.messages.serve(
    projectId,
    SERVICE,
    (_data, helper) =>
      new Promise((resolve) => {
        helper.progress(40, 'Translating sentence 1 of 1');
        held.push({ helper, resolve });
      }),
    { tasks: [TASKS.TRANSLATE] },
  );
  await expect
    .poll(
      async () =>
        (await client.messages.discoverServices(projectId)).some(
          (s) => s.serviceId === SERVICE.serviceId && s.online,
        ),
      { timeout: 15000 },
    )
    .toBe(true);
});

test.afterAll(async () => {
  for (const h of held.splice(0)) h.resolve(h.helper.complete({ sentencesWritten: 0 }));
  registration?.stop();
  if (documentId) await client.documents.delete(documentId).catch(() => {});
  await client.messages.discardService(projectId, SERVICE.serviceId).catch(() => {});
});

// Let the oldest held request answer.
const answer = (data = { sentencesWritten: 0 }) => {
  const h = held.shift();
  h.helper.complete(data);
  h.resolve();
};

const open = async (page) => {
  if (page.url() !== 'about:blank') await page.goto('about:blank');
  await seedAuth(page);
  // Translate, then link. No analysis service is online here.
  await page.addInitScript(() =>
    localStorage.setItem(
      'plaid_igt_auto_analyze_steps',
      JSON.stringify({ translate: true, copy: false, analyze: true, link: true }),
    ),
  );
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=analyze`);
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
};

const opener = (page) => page.locator('.igt-toolbar__btn', { hasText: 'Auto-analyze' });
const banner = (page) => page.locator('[data-run-banner]');

const start = async (page) => {
  await opener(page).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(SERVICE.serviceName);
  await dialog.getByRole('button', { name: 'Run', exact: true }).click();
  await waitFor(() => held.length === 1, 'the translation request');
};

test('the banner shows the run, its dialog closes on Run and its opener turns', async ({
  page,
}) => {
  await open(page);
  await start(page);

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(banner(page)).toBeVisible();
  await expect(banner(page)).toHaveAttribute('data-tone', 'info');
  await expect(banner(page)).toContainText('Auto-analyze');
  await expect(banner(page)).toContainText('Editing paused.');
  await expect(banner(page).locator('ol li')).toHaveText([
    'Propose translations',
    'Link to the lexicon',
  ]);
  await expect(banner(page).getByRole('status')).toHaveText(
    'Step 1 of 2. Translating sentence 1 of 1',
  );
  await expect(banner(page).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '20');
  await expect(banner(page).getByRole('button', { name: 'Stop' })).toBeVisible();
  await expect(opener(page)).toBeDisabled();

  answer();
  await expect(banner(page)).toHaveCount(0, { timeout: 15000 });
  await expect(opener(page)).toBeEnabled();
});

test('leaving the document stops Auto-analyze after the step in flight, and coming back names the rest', async ({
  page,
}) => {
  await open(page);
  await start(page);
  await expect(banner(page)).toBeVisible();

  // Inside the app: the project's documents.
  await page.goto(`/#/projects/${projectId}`);
  await expect(banner(page)).toHaveCount(0);
  // The step in flight was not cancelled.
  expect(held).toHaveLength(1);

  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=analyze`);
  await expect(banner(page)).toBeVisible({ timeout: 15000 });
  await expect(banner(page)).toContainText('Auto-analyze');
  await expect(opener(page)).toBeDisabled();

  answer();
  await expect(banner(page)).toHaveCount(0, { timeout: 15000 });
  await expect(
    page.locator('[data-sonner-toast]', { hasText: 'Link to the lexicon did not run.' }),
  ).toBeVisible();
});

test('reloading mid-run asks first, and the reloaded page rejoins the run', async ({ page }) => {
  await open(page);
  await start(page);
  await expect(banner(page)).toBeVisible();

  const asked = [];
  page.on('dialog', async (d) => {
    asked.push(d.type());
    await d.accept();
  });
  await page.reload();
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  expect(asked).toEqual(['beforeunload']);
  await expect(banner(page)).toBeVisible({ timeout: 15000 });
  expect(held).toHaveLength(1);

  answer();
  await expect(banner(page)).toHaveCount(0, { timeout: 15000 });
});
