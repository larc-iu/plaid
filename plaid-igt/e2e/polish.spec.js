import PlaidClient, { ROLES, cpLength } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';

// The 2026-08-27 polish batch (ALPHA_TRIAGE "Polish"): rapid multi-hyphen
// splits, search click-through focusing the hit word, a failed save keeping
// focus + the typed value, the "session expired" note on the login page, and
// the built-in tokenizer's inline hint. Throwaway document in "E2E IGT
// Fixture", deleted afterwards.

const CORE = 'http://localhost:8085';
const roleOf = (l) => l?.config?.plaid?.role;
const STAMP = Date.now();
const UNIQUE = `zyx${STAMP}`;
const BODY = `alpha beta ${UNIQUE} delta`;

let client;
let projectId;
let documentId;
let ids = {};

test.beforeAll(async () => {
  client = new PlaidClient(CORE, readToken().token);
  const project = (await client.projects.list()).find((p) => p.name === 'E2E IGT Fixture');
  if (!project) throw new Error('run node e2e/fixture.js first');
  projectId = project.id;
  const full = await client.projects.get(projectId);
  const textLayer = full.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const layer = (role) => textLayer.tokenLayers.find((l) => roleOf(l) === role);
  const created = await client.documents.create(projectId, `polish ${STAMP}`);
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
  await client.tokens.bulkCreate(
    words.map((w) => ({ tokenLayerId: layer(ROLES.MORPHEME).id, text: TEXT, ...w, precedence: 1 })),
  );
  const seeded = await client.documents.get(documentId, true);
  const tl = seeded.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const wl = tl.tokenLayers.find((l) => roleOf(l) === ROLES.WORD);
  const ml = tl.tokenLayers.find((l) => roleOf(l) === ROLES.MORPHEME);
  ids = {
    w: words.map((x) => wl.tokens.find((t) => t.begin === x.begin).id),
    m: words.map((x) => ml.tokens.find((t) => t.begin === x.begin).id),
  };
});

test.afterAll(async () => {
  if (documentId) await client.documents.delete(documentId).catch(() => {});
});

async function openAnalyze(page) {
  if (page.url() !== 'about:blank') await page.goto('about:blank');
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=analyze`);
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  await page.waitForLoadState('networkidle');
}
const morphForms = async (wordId) => {
  const raw = await client.documents.get(documentId, true);
  const ml = raw.textLayers[0].tokenLayers.find((l) => roleOf(l) === ROLES.MORPHEME);
  const w = raw.textLayers[0].tokenLayers
    .find((l) => roleOf(l) === ROLES.WORD)
    .tokens.find((t) => t.id === wordId);
  return ml.tokens
    .filter((m) => m.begin === w.begin && m.end === w.end)
    .sort((a, b) => a.precedence - b.precedence)
    .map((m) => m.metadata?.form ?? null);
};

test('rapid multi-hyphen: every hyphen typed during a split becomes a split, never a literal', async ({
  page,
}) => {
  await openAnalyze(page);
  const cell = page.locator(`.igt-morph-field[data-word="${ids.w[0]}"]`).first();
  await cell.click();
  await page.keyboard.press('Control+a');
  // Typed as fast as Playwright can: the 2nd and 3rd hyphens land mid-flight.
  await page.keyboard.type('ab-cd-ef-gh', { delay: 0 });
  await expect
    .poll(() => morphForms(ids.w[0]), { timeout: 10_000 })
    .toEqual(['ab', 'cd', 'ef', 'gh']);
  await expect(page.locator(`.igt-morph-field[data-word="${ids.w[0]}"]`)).toHaveCount(4);
  const values = await page
    .locator(`.igt-morph-field[data-word="${ids.w[0]}"]`)
    .evaluateAll((els) => els.map((e) => e.value));
  expect(values.some((v) => v.includes('-'))).toBe(false);
});

test('search click-through focuses the hit word', async ({ page }) => {
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}`);
  await page.getByRole('tab', { name: 'Search' }).click();
  await page.getByPlaceholder(/Search this project/).fill(UNIQUE);
  await page.keyboard.press('Enter');
  await page.locator('mark', { hasText: UNIQUE }).first().click();
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.activeElement?.dataset?.word ??
          document.activeElement?.dataset?.confirmWord ??
          null,
      ),
    )
    .toBe(ids.w[2]);
});

test('a failed save keeps the typed value in the cell and the focus on it', async ({ page }) => {
  await openAnalyze(page);
  await page.route('**/api/v1/spans**', (route) => route.fulfill({ status: 503, body: '' }));
  await page.route('**/api/v1/batch**', (route) => route.fulfill({ status: 503, body: '' }));
  const cell = page.locator(`.igt-field[data-cell-key="ma:${ids.m[1]}:Gloss"]`);
  await cell.click();
  await page.keyboard.type('OFFLINE');
  await page.keyboard.press('Enter');
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: /Could not reach the server/ }),
  ).toBeVisible();
  await expect(cell).toHaveValue('OFFLINE');
  await expect(cell).toBeFocused();
  await page.unroute('**/api/v1/spans**');
  await page.unroute('**/api/v1/batch**');
  // Enter now retries and succeeds.
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => {
      const raw = await client.documents.get(documentId, true);
      const gl = raw.textLayers[0].tokenLayers
        .find((l) => roleOf(l) === ROLES.MORPHEME)
        .spanLayers.find((s) => s.name === 'Gloss');
      return gl.spans.find((s) => s.tokens[0] === ids.m[1])?.value ?? null;
    })
    .toBe('OFFLINE');
});

test('an expired session says so on the login page', async ({ page }) => {
  await seedAuth(page, {
    token: 'eyJhbGciOiJIUzI1NiJ9.eyJib2d1cyI6dHJ1ZX0.bad',
    userId: 'a@b.com',
    username: 'a@b.com',
    isAdmin: true,
  });
  await page.goto('/#/projects');
  await page.waitForURL(/#\/login/);
  await expect(page.getByRole('status')).toContainText('Your session has expired');
  // A real sign-in clears it.
  await page.getByLabel(/Username/i).fill('a@b.com');
  await page.getByLabel(/Password/i).fill('wrong-password');
  await page.getByRole('button', { name: /Login|Sign in/i }).click();
  await expect(page.getByRole('alert')).toBeVisible(); // wrong password: error shown, notice yields to it
  expect(await page.evaluate(() => sessionStorage.getItem('plaid:logout-reason'))).toBe('expired');
});

test('the built-in tokenizer says it leaves sentence boundaries alone', async ({ page }) => {
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=tokenize`);
  await expect(
    page.getByText('finds words only; sentence boundaries stay as they are'),
  ).toBeVisible();
});
