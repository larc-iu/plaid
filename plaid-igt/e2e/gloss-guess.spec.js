import PlaidClient, { ROLES, cpLength, stampInferred } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';

// TEST_PLAN A1: gloss guesses are placeholder suggestions from precedent (this
// document and the rest of the project). They are written ONLY on Enter (born verified, with
// provenance); Tab, blur and typing over them never write the guess.
// Throwaway document in the "E2E IGT Fixture" project, deleted afterwards.

const CORE = 'http://localhost:8085';
const roleOf = (l) => l?.config?.plaid?.role;
// Guesses draw on precedent across the WHOLE project, and the fixture project
// is shared with other specs, so every form here is unique to this run.
const NONCE = Date.now().toString(36);
const LOS = `los${NONCE}`;
const MESA = `mesa${NONCE}`;
const SOL = `sol${NONCE}`;
const BODY = `${LOS} ${LOS} ${LOS} ${LOS} ${MESA}`;

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

// Extra throwaway documents for the tie / Shift+Enter / machine-source rows.
const extraDocs = [];
async function mkdoc(body) {
  const full = await client.projects.get(projectId);
  const textLayer = full.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const layer = (role) => textLayer.tokenLayers.find((l) => roleOf(l) === role);
  const d = await client.documents.create(projectId, `guess-spec-x ${Date.now()}`);
  extraDocs.push(d.id);
  await client.texts.create(textLayer.id, d.id, body);
  const raw = await client.documents.get(d.id, true);
  const TEXT = raw.textLayers.find((l) => roleOf(l) === ROLES.BASELINE).text.id;
  const words = [...body.matchAll(/\S+/g)].map((m) => ({
    begin: m.index,
    end: m.index + m[0].length,
  }));
  await client.tokens.bulkCreate([
    { tokenLayerId: layer(ROLES.SENTENCE).id, text: TEXT, begin: 0, end: cpLength(body) },
  ]);
  await client.tokens.bulkCreate(
    words.map((w) => ({ tokenLayerId: layer(ROLES.WORD).id, text: TEXT, ...w })),
  );
  await client.tokens.bulkCreate(
    words.map((w) => ({ tokenLayerId: layer(ROLES.MORPHEME).id, text: TEXT, ...w, precedence: 1 })),
  );
  const seeded = await client.documents.get(d.id, true);
  const tl = seeded.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const ml = tl.tokenLayers.find((l) => roleOf(l) === ROLES.MORPHEME);
  return { id: d.id, m: words.map((x) => ml.tokens.find((t) => t.begin === x.begin).id) };
}

test.afterAll(async () => {
  if (documentId) await client.documents.delete(documentId).catch(() => {});
  for (const id of extraDocs) await client.documents.delete(id).catch(() => {});
});

async function openAnalyze(page) {
  // A goto to the SAME hash URL is a same-document navigation (no reload), so
  // bounce through about:blank to guarantee a fresh load of the document.
  if (page.url() !== 'about:blank') await page.goto('about:blank');
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
  expect(span?.metadata?.provSource).toBe('gloss:precedent');
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

test('A1-06/09: Escape leaves a guessed cell empty; Shift+Enter adopts and moves back', async ({
  page,
}) => {
  const d = await mkdoc(`${LOS} ${LOS} ${LOS}`);
  await client.spans.create(ids.gloss, [d.m[0]], 'DET.PL');
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${d.id}?tab=analyze`);
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  const seen = writes(page);
  const c1 = page.locator(`.igt-field[data-cell-key="ma:${d.m[1]}:Gloss"]`);
  const c2 = page.locator(`.igt-field[data-cell-key="ma:${d.m[2]}:Gloss"]`);
  await expect(c2).toHaveClass(/igt-field--guess/);
  await c2.click();
  await page.keyboard.press('Escape');
  await expect(c2).not.toBeFocused();
  await expect(c2).toHaveValue('');
  await page.waitForTimeout(400);
  expect(seen).toEqual([]);
  // Shift+Enter adopts the guess (Enter semantics) and moves to the previous cell.
  await c2.click();
  await page.keyboard.press('Shift+Enter');
  await expect(c2).toHaveValue('DET.PL');
  await expect(c2).toHaveClass(/igt-field--verified/);
  await expect(c1).toBeFocused();
  await page.waitForLoadState('networkidle');
  expect(seen).toEqual(['POST /api/v1/spans']);
});

test('A1-07: a tie yields no guess; breaking the tie brings it back', async ({ page }) => {
  const d = await mkdoc(`${LOS} ${LOS} ${LOS} ${LOS}`);
  await client.spans.create(ids.gloss, [d.m[0]], 'DET.PL');
  await client.spans.create(ids.gloss, [d.m[1]], 'the.PL');
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${d.id}?tab=analyze`);
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  const c2 = page.locator(`.igt-field[data-cell-key="ma:${d.m[2]}:Gloss"]`);
  const c3 = page.locator(`.igt-field[data-cell-key="ma:${d.m[3]}:Gloss"]`);
  await expect(c2).not.toHaveClass(/igt-field--guess/);
  await expect(c3).not.toHaveClass(/igt-field--guess/);
  // Break the tie by glossing the third `los` by hand: the fourth now gets a guess.
  await c2.click();
  await page.keyboard.type('DET.PL');
  await page.keyboard.press('Enter');
  await expect(c3).toHaveClass(/igt-field--guess/);
  await expect(c3).toHaveAttribute('data-guess-value', 'DET.PL');
});

test('A1-11: a guess is offered even when its only source is machine-unverified', async ({
  page,
}) => {
  const d = await mkdoc(`${SOL} ${SOL}`);
  await client.spans.create(ids.gloss, [d.m[0]], 'SUN', stampInferred('service:test'));
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${d.id}?tab=analyze`);
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  const c1 = page.locator(`.igt-field[data-cell-key="ma:${d.m[1]}:Gloss"]`);
  await expect(c1).toHaveClass(/igt-field--guess/);
  await expect(c1).toHaveAttribute('data-guess-value', 'SUN');
});

test('A1-12: Alt+Down lists the values seen for the form, ranked with counts; picking writes it verified', async ({
  page,
}) => {
  const d = await mkdoc(`${LOS} ${LOS} ${LOS} ${LOS}`);
  await client.spans.create(ids.gloss, [d.m[0]], 'DET.PL');
  await client.spans.create(ids.gloss, [d.m[1]], 'DET.PL');
  await client.spans.create(ids.gloss, [d.m[2]], 'the.PL');
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${d.id}?tab=analyze`);
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  await page.waitForLoadState('networkidle');
  const c3 = page.locator(`.igt-field[data-cell-key="ma:${d.m[3]}:Gloss"]`);
  await expect(c3).toHaveClass(/igt-field--guess/); // DET.PL is the strict majority
  await expect(c3).toHaveClass(/igt-field--alts/);
  await c3.click();
  await page.keyboard.press('Alt+ArrowDown');
  const rows = page.locator('.igt-alts__item');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('DET.PL');
  await expect(rows.nth(0)).toContainText('×');
  await expect(rows.nth(1)).toContainText('the.PL');
  // Escape only closes the list; the cell stays focused and empty.
  await page.keyboard.press('Escape');
  await expect(page.locator('.igt-alts')).toHaveCount(0);
  await expect(c3).toBeFocused();
  await expect(c3).toHaveValue('');
  // Reopen, move to the second row, pick it.
  const seen = writes(page);
  await page.keyboard.press('Alt+ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(c3).toHaveValue('the.PL');
  await expect(c3).toHaveClass(/igt-field--verified/);
  await expect(c3).toBeFocused();
  await page.waitForLoadState('networkidle');
  expect(seen).toEqual(['POST /api/v1/spans']);
  const raw = await client.documents.get(d.id, true);
  const span = raw.textLayers
    .flatMap((t) => t.tokenLayers)
    .flatMap((l) => l.spanLayers || [])
    .find((s) => s.id === ids.gloss)
    .spans.find((s) => s.tokens[0] === d.m[3]);
  expect(span?.value).toBe('the.PL');
  expect(span?.metadata?.provSource).toBe('gloss:precedent');
  expect(span?.metadata?.provConfirmed).toBe(true);
  expect(span?.metadata?.provDetail?.value).toBe('the.PL');
});
