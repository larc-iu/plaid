import PlaidClient, { ROLES, cpLength } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';

// The chords that changed on 2026-08-31 (Ctrl+Enter accepts everything proposed
// on a word, ← / → leave a cell at the ends of a value, Escape closes the row
// menu), plus the ones they sit next to. The rest of the keyboard model is
// covered where it lives: grid-nav (Enter/Tab/arrows/Escape), gloss-guess
// (Enter adopts, Alt+↓), morpheme-ops (- = ⌫), provenance (Ctrl+Enter over
// machine material, Ctrl+⌫), sentence-provenance (Ctrl+Shift+arrows, the
// translation field's own Ctrl+Enter), vocab-popover (the popover's keys).
// Throwaway document in "E2E IGT Fixture", deleted afterwards.

const CORE = 'http://localhost:8085';
const roleOf = (l) => l?.config?.plaid?.role;
// Precedent is project-wide and the fixture project is shared: unique forms.
const NONCE = Date.now().toString(36);
const SOL = `sol${NONCE}`;
const MESA = `mesa${NONCE}`;
const BODY = `${SOL} ${SOL} ${MESA}`;

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

  const created = await client.documents.create(projectId, `keyboard-sweep ${Date.now()}`);
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
    pos: pos.id,
  };
  // A person glossed the first `sol` in both scopes, so the second one shows a
  // guess in each — and `mesa` has no precedent anywhere, so it shows none.
  await client.spans.create(ids.gloss, [ids.m[0]], 'sun');
  await client.spans.create(ids.pos, [ids.w[0]], 'N');
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
const cell = (page, key) => page.locator(`.igt-field[data-cell-key="${key}"]`);
const focusedKey = (page) => page.evaluate(() => document.activeElement?.dataset?.cellKey ?? null);
const writes = (page) => {
  const seen = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET' && r.url().includes('/api/v1/'))
      seen.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  return seen;
};
const spansOf = async (layerId) => {
  const raw = await client.documents.get(documentId, true);
  return raw.textLayers
    .flatMap((t) => t.tokenLayers)
    .flatMap((l) => l.spanLayers || [])
    .find((s) => s.id === layerId).spans;
};

test('K-01: Ctrl+Enter writes every guess on the word, born verified, then hops', async ({
  page,
}) => {
  await openAnalyze(page);
  const g1 = cell(page, `ma:${ids.m[1]}:Gloss`);
  const p1 = cell(page, `wa:${ids.w[1]}:Part of Speech`);
  await expect(g1).toHaveClass(/igt-field--guess/);
  await expect(p1).toHaveClass(/igt-field--guess/);
  await g1.click();
  await page.keyboard.press('Control+Enter');
  // Both scopes of the word are written, not just the focused cell.
  await expect(g1).toHaveValue('sun');
  await expect(p1).toHaveValue('N');
  await expect(g1).toHaveClass(/igt-field--verified/);
  await page.waitForLoadState('networkidle');
  // The hop lands on the same tier of the next word.
  expect(await focusedKey(page)).toBe(`ma:${ids.m[2]}:Gloss`);
  const gs = (await spansOf(ids.gloss)).find((s) => s.tokens.includes(ids.m[1]));
  expect(gs.value).toBe('sun');
  expect(gs.metadata.provConfirmed).toBe(true);
  expect(gs.metadata.provSource).toBe('gloss:precedent');
  const ps = (await spansOf(ids.pos)).find((s) => s.tokens.includes(ids.w[1]));
  expect(ps.value).toBe('N');
  expect(ps.metadata.provConfirmed).toBe(true);
});

test('K-02: with nothing proposed, Ctrl+Enter holds position and says so', async ({ page }) => {
  await openAnalyze(page);
  const g2 = cell(page, `ma:${ids.m[2]}:Gloss`);
  await expect(g2).not.toHaveClass(/igt-field--guess/); // `mesa` has no precedent
  await g2.click();
  const seen = writes(page);
  await page.keyboard.press('Control+Enter');
  await expect(page.getByText('Nothing to accept on this word')).toBeVisible();
  expect(await focusedKey(page)).toBe(`ma:${ids.m[2]}:Gloss`);
  await page.waitForTimeout(400);
  expect(seen).toEqual([]);
});

test('K-03: left/right leave a morpheme form cell at its edges', async ({ page }) => {
  await openAnalyze(page);
  const f1 = page.locator(`.igt-morph-field[data-word="${ids.w[1]}"]`);
  await f1.click();
  // A morpheme form keeps the caret where you click it (unlike an annotation
  // cell, which selects on focus), so the arrows walk the form first.
  await page.keyboard.press('ArrowLeft');
  expect(await focusedKey(page)).toBe(`mf:${ids.m[1]}`);
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowLeft');
  expect(await focusedKey(page)).toBe(`mf:${ids.m[0]}`);
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowRight');
  expect(await focusedKey(page)).toBe(`mf:${ids.m[1]}`);
});

test('K-04: Tab closes the alternatives list and still moves on', async ({ page }) => {
  await openAnalyze(page);
  const g1 = cell(page, `ma:${ids.m[1]}:Gloss`);
  await g1.click();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page.locator('.igt-alts')).toHaveCount(1);
  await page.keyboard.press('Tab');
  await expect(page.locator('.igt-alts')).toHaveCount(0);
  expect(await focusedKey(page)).toBe(`ma:${ids.m[2]}:Gloss`);
});

test('K-06: the translation field holds position too when nothing is proposed', async ({
  page,
}) => {
  await openAnalyze(page);
  const tr = page.locator('textarea.igt-field--sentence').first();
  await tr.click();
  const key = await page.evaluate(() => document.activeElement?.dataset?.cellKey ?? null);
  const seen = writes(page);
  await page.keyboard.press('Control+Enter');
  await expect(page.getByText(/Nothing to accept in/)).toBeVisible();
  expect(await focusedKey(page)).toBe(key);
  await page.waitForTimeout(400);
  expect(seen).toEqual([]);
});

test('K-05: the row menu opens from the keyboard, closes on Escape, and Space does not scroll', async ({
  page,
}) => {
  await openAnalyze(page);
  const label = page.locator('.igt-row-label[role="button"]').first();
  await label.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.igt-rowmenu')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.igt-rowmenu')).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await label.focus();
  await page.keyboard.press(' ');
  await expect(page.locator('.igt-rowmenu')).toHaveCount(1);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});
