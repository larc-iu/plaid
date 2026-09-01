import PlaidClient, { ROLES, cpLength } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';

// TEST_PLAN C5 (grid navigation) auto rows + A4-08: Enter/Tab move along a
// tier, arrows move between tiers in the column band, the Translation
// textarea only lets the arrows out at its edges, Escape reverts, orthography
// cells persist, and Ctrl+Down with no machine chips leaves the browser
// default alone. Throwaway document in "E2E IGT Fixture", deleted afterwards.

const CORE = 'http://localhost:8085';
const roleOf = (l) => l?.config?.plaid?.role;
const BODY = 'uno dos tres';

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
  const created = await client.documents.create(projectId, `grid-nav ${Date.now()}`);
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
  const sl = tl.tokenLayers.find((l) => roleOf(l) === ROLES.SENTENCE);
  ids = {
    w: words.map((x) => wl.tokens.find((t) => t.begin === x.begin).id),
    m: words.map((x) => ml.tokens.find((t) => t.begin === x.begin).id),
    s: sl.tokens[0].id,
  };
});

test.afterAll(async () => {
  if (documentId) await client.documents.delete(documentId).catch(() => {});
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

test('C5-01: Enter and Tab walk the tier; the last cell commits on Enter and tabs out', async ({
  page,
}) => {
  await openAnalyze(page);
  const g = (i) => cell(page, `ma:${ids.m[i]}:Gloss`);
  await g(0).click();
  await page.keyboard.type('a');
  await page.keyboard.press('Enter');
  await expect(g(1)).toBeFocused();
  await page.keyboard.type('b');
  await page.keyboard.press('Tab');
  await expect(g(2)).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(g(1)).toBeFocused();
  await page.keyboard.press('Shift+Enter');
  await expect(g(0)).toBeFocused();
  await g(2).click();
  await page.keyboard.type('c');
  await page.keyboard.press('Enter'); // no next cell on the tier: commits (blur)
  expect(await focusedKey(page)).not.toBe(`ma:${ids.m[2]}:Gloss`);
  await page.waitForLoadState('networkidle');
  await expect(g(0)).toHaveValue('a');
  await expect(g(1)).toHaveValue('b');
  await expect(g(2)).toHaveValue('c');
  // Tab on the last cell of a tier falls out of the grid (browser default).
  await g(2).click();
  await page.keyboard.press('Tab');
  const k = await focusedKey(page);
  expect(k === null || !k.startsWith('ma:')).toBe(true);
});

test('C5-02: arrows move between tiers inside the column band', async ({ page }) => {
  await openAnalyze(page);
  await cell(page, `ma:${ids.m[1]}:Gloss`).click();
  await page.keyboard.press('ArrowUp');
  expect(await focusedKey(page)).toBe(`mf:${ids.m[1]}`);
  await page.keyboard.press('ArrowUp');
  expect(await focusedKey(page)).toBe(`wa:${ids.w[1]}:Part of Speech`);
  await page.keyboard.press('ArrowDown');
  expect(await focusedKey(page)).toBe(`mf:${ids.m[1]}`);
  await page.keyboard.press('ArrowDown');
  expect(await focusedKey(page)).toBe(`ma:${ids.m[1]}:Gloss`);
});

test('C5-10: left/right move along the tier from the ends of a value', async ({ page }) => {
  await openAnalyze(page);
  const set = async (key, value) => {
    const c = cell(page, key);
    await c.click();
    await page.keyboard.press('Control+a');
    if (value) await page.keyboard.type(value);
    else await page.keyboard.press('Backspace');
    await page.keyboard.press('Enter'); // commits (clearing deletes the span)
    await page.waitForLoadState('networkidle');
  };
  // Fixed starting point: this file's earlier rows leave values behind.
  await set(`ma:${ids.m[0]}:Gloss`, 'aa');
  await set(`ma:${ids.m[1]}:Gloss`, '');

  const g1 = cell(page, `ma:${ids.m[1]}:Gloss`);
  await g1.click();
  await expect(g1).toHaveValue('');
  // An empty cell has no caret to move, so the arrow leaves at once — the case
  // that read as a dead editor before.
  await page.keyboard.press('ArrowLeft');
  expect(await focusedKey(page)).toBe(`ma:${ids.m[0]}:Gloss`);
  // Landing on a cell selects its value, so the first ArrowRight only collapses
  // that selection. Editing keeps the arrows until the caret is at the edge.
  await page.keyboard.press('ArrowRight');
  expect(await focusedKey(page)).toBe(`ma:${ids.m[0]}:Gloss`);
  await page.keyboard.press('ArrowRight');
  expect(await focusedKey(page)).toBe(`ma:${ids.m[1]}:Gloss`);

  await page.keyboard.type('ab');
  await page.keyboard.press('ArrowLeft'); // between a and b
  expect(await focusedKey(page)).toBe(`ma:${ids.m[1]}:Gloss`);
  await page.keyboard.press('ArrowLeft'); // start of the value
  expect(await focusedKey(page)).toBe(`ma:${ids.m[1]}:Gloss`);
  await page.keyboard.press('ArrowLeft'); // now it leaves, committing "ab"
  expect(await focusedKey(page)).toBe(`ma:${ids.m[0]}:Gloss`);
  await page.waitForLoadState('networkidle');
  await expect(g1).toHaveValue('ab');

  await set(`ma:${ids.m[1]}:Gloss`, '');
  await set(`ma:${ids.m[0]}:Gloss`, '');
});

test('C5-03: the Translation textarea lets arrows out only at its edges', async ({ page }) => {
  await openAnalyze(page);
  const tr = cell(page, `sa:${ids.s}:Translation`);
  await tr.click();
  await page.keyboard.type('hello world');
  // Caret at the end: ArrowUp stays inside (caret not at the start).
  await page.keyboard.press('ArrowUp');
  expect(await focusedKey(page)).toBe(`sa:${ids.s}:Translation`);
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowUp');
  const k = await focusedKey(page);
  expect(k, 'left the textarea upward').not.toBe(`sa:${ids.s}:Translation`);
  expect(k).toMatch(/^(ma|mf|wa|or):/);
  await page.waitForLoadState('networkidle');
  await expect(tr).toHaveValue('hello world');
});

test('C5-04: Escape mid-edit reverts and writes nothing', async ({ page }) => {
  await openAnalyze(page);
  const g0 = cell(page, `ma:${ids.m[0]}:Gloss`);
  const before = await g0.inputValue();
  const seen = writes(page);
  await g0.click();
  await page.keyboard.press('End');
  await page.keyboard.type('zzz');
  await expect(g0).toHaveValue(`${before}zzz`);
  await page.keyboard.press('Escape');
  await expect(g0).toHaveValue(before);
  await expect(g0).not.toBeFocused();
  await page.waitForTimeout(400);
  expect(seen).toEqual([]);
});

test('C5-08: orthography cells edit and persist', async ({ page }) => {
  await openAnalyze(page);
  const o = cell(page, `or:${ids.w[0]}:IPA`);
  await o.click();
  await page.keyboard.type('ˈuno');
  await page.keyboard.press('Enter');
  await page.waitForLoadState('networkidle');
  await openAnalyze(page);
  await expect(cell(page, `or:${ids.w[0]}:IPA`)).toHaveValue('ˈuno');
});

test('A4-08: Ctrl+Down with no machine chips is not hijacked', async ({ page }) => {
  await openAnalyze(page);
  await expect(page.locator('button.igt-vocab__hint--machine')).toHaveCount(0);
  const g0 = cell(page, `ma:${ids.m[0]}:Gloss`);
  await g0.click();
  const prevented = await page.evaluate(() => {
    const ev = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    return !document.activeElement.dispatchEvent(ev);
  });
  expect(prevented).toBe(false);
});
