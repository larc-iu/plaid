import PlaidClient, { ROLES, cpLength } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';

// TEST_PLAN A1: gloss guesses are placeholder suggestions from the document's
// own frequencies. They are written ONLY on Enter (born verified, with
// provenance); Tab, blur and typing over them never write the guess.
// Throwaway document in the "E2E IGT Fixture" project, deleted afterwards.

const CORE = 'http://localhost:8085';
const roleOf = (l) => l?.config?.plaid?.role;
const BODY = 'los los los los mesa';

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
  const WORD = layer(ROLES.WORD);
  const MORPH = layer(ROLES.MORPHEME);
  const gloss = MORPH.spanLayers.find((s) => s.name === 'Gloss');
  const pos = WORD.spanLayers.find((s) => s.name === 'Part of Speech');

  const created = await client.documents.create(projectId, `guess-spec ${Date.now()}`);
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
  await client.tokens.bulkCreate(words.map((w) => ({ tokenLayerId: WORD.id, text: TEXT, ...w })));
  await client.tokens.bulkCreate(
    words.map((w) => ({ tokenLayerId: MORPH.id, text: TEXT, ...w, precedence: 1 })),
  );
  const seeded = await client.documents.get(documentId, true);
  const tl = seeded.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const wl = tl.tokenLayers.find((l) => l.id === WORD.id);
  const ml = tl.tokenLayers.find((l) => l.id === MORPH.id);
  ids = {
    w: words.map((x) => wl.tokens.find((t) => t.begin === x.begin).id),
    m: words.map((x) => ml.tokens.find((t) => t.begin === x.begin).id),
    gloss: gloss.id,
  };
  // One human gloss + one human POS on the first `los`: every other `los` now
  // gets a guess in both fields.
  await client.spans.create(gloss.id, [ids.m[0]], 'DET.PL');
  await client.spans.create(pos.id, [ids.w[0]], 'DET');
});

test.afterAll(async () => {
  if (documentId) await client.documents.delete(documentId).catch(() => {});
});

async function openAnalyze(page) {
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=analyze`);
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  await page.waitForLoadState('networkidle');
}

const writes = (page) => {
  const seen = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET' && r.url().includes('/api/v1/'))
      seen.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  return seen;
};

const glossSpans = async () => {
  const raw = await client.documents.get(documentId, true);
  return raw.textLayers
    .flatMap((t) => t.tokenLayers)
    .flatMap((l) => l.spanLayers || [])
    .find((s) => s.id === ids.gloss).spans;
};

test('A1-01/02: a guessed cell is a placeholder; Enter adopts it born-verified and moves on', async ({
  page,
}) => {
  await openAnalyze(page);
  const cell = page.locator(`.igt-field[data-cell-key="ma:${ids.m[1]}:Gloss"]`);
  await expect(cell).toHaveClass(/igt-field--guess/);
  await expect(cell).toHaveValue('');
  await expect(cell).toHaveAttribute('data-guess-value', 'DET.PL');
  await expect(cell).toHaveAttribute('title', /Guess: DET\.PL/);
  const seen = writes(page);
  await cell.click();
  await page.keyboard.press('Enter');
  await expect(cell).toHaveValue('DET.PL');
  await expect(cell).toHaveClass(/igt-field--verified/);
  await expect(cell).not.toHaveClass(/igt-field--guess/);
  // Enter commits and moves to the next cell in the same row.
  await expect(page.locator(`.igt-field[data-cell-key="ma:${ids.m[2]}:Gloss"]`)).toBeFocused();
  await page.waitForLoadState('networkidle');
  expect(seen).toEqual(['POST /api/v1/spans']);
  const span = (await glossSpans()).find((s) => s.tokens[0] === ids.m[1]);
  expect(span?.value).toBe('DET.PL');
  expect(span?.metadata?.prov).toBe('inferred');
  expect(span?.metadata?.provSource).toMatch(/doc-frequency/);
  expect(span?.metadata?.provConfirmed).toBe(true);
});

test('A1-03/05: Tab and blur leave a guessed cell empty and write nothing', async ({ page }) => {
  await openAnalyze(page);
  const cell = page.locator(`.igt-field[data-cell-key="ma:${ids.m[2]}:Gloss"]`);
  await expect(cell).toHaveClass(/igt-field--guess/);
  const seen = writes(page);
  await cell.click();
  await page.keyboard.press('Tab');
  await expect(cell).not.toBeFocused();
  await expect(cell).toHaveValue('');
  await cell.click();
  await page.locator('h1, .igt-toolbar').first().click({ force: true });
  await expect(cell).not.toBeFocused();
  await expect(cell).toHaveValue('');
  await page.waitForTimeout(500);
  expect(seen).toEqual([]);
  expect((await glossSpans()).some((s) => s.tokens[0] === ids.m[2])).toBe(false);
  await expect(cell).toHaveClass(/igt-field--guess/);
});

test('A1-04: typing over a guess makes a plain human span', async ({ page }) => {
  await openAnalyze(page);
  const cell = page.locator(`.igt-field[data-cell-key="ma:${ids.m[3]}:Gloss"]`);
  await expect(cell).toHaveClass(/igt-field--guess/);
  await cell.click();
  await page.keyboard.type('X');
  await page.keyboard.press('Enter');
  await expect(cell).toHaveValue('X');
  await expect(cell).not.toHaveClass(/igt-field--(machine|verified|guess)/);
  await page.waitForLoadState('networkidle');
  const span = (await glossSpans()).find((s) => s.tokens[0] === ids.m[3]);
  expect(span?.value).toBe('X');
  expect(span?.metadata?.prov).toBeUndefined();
});

test('A1-10: word-scope fields guess the same way', async ({ page }) => {
  await openAnalyze(page);
  const cell = page.locator(`.igt-field[data-cell-key="wa:${ids.w[2]}:Part of Speech"]`);
  await expect(cell).toHaveClass(/igt-field--guess/);
  await expect(cell).toHaveAttribute('data-guess-value', 'DET');
  await cell.click();
  await page.keyboard.press('Enter');
  await expect(cell).toHaveValue('DET');
  await expect(cell).toHaveClass(/igt-field--verified/);
  // The unrelated word `mesa` never gets a guess.
  await expect(
    page.locator(`.igt-field[data-cell-key="wa:${ids.w[4]}:Part of Speech"]`),
  ).not.toHaveClass(/igt-field--guess/);
});
