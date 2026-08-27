import PlaidClient, { ROLES, cpLength } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';

// TEST_PLAN B13-02/03: two tabs on one document. The stale tab's write hits
// the document-version check (409), shows a humanized banner (no URL, no
// UUID), and the editor resyncs to the other tab's state; the same token
// linked from both tabs ends up with exactly ONE link. Throwaway document +
// throwaway lexicon entries in "E2E IGT Fixture", deleted afterwards.

const CORE = 'http://localhost:8085';
const roleOf = (l) => l?.config?.plaid?.role;
const BODY = 'uno dos tres';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let client;
let projectId;
let documentId;
let items = {};
let ids = {};

test.beforeAll(async () => {
  client = new PlaidClient(CORE, readToken().token);
  const project = (await client.projects.list()).find((p) => p.name === 'E2E IGT Fixture');
  if (!project) throw new Error('run node e2e/fixture.js first');
  projectId = project.id;
  const full = await client.projects.get(projectId);
  const textLayer = full.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const layer = (role) => textLayer.tokenLayers.find((l) => roleOf(l) === role);
  const vocab = full.vocabs.find((v) => v.name === 'IGT Lexicon');
  const stamp = Date.now();
  for (const f of ['occA', 'occB']) {
    const it = await client.vocabItems.create(vocab.id, `${f}-${stamp}`);
    items[f] = { id: it.id, form: `${f}-${stamp}` };
  }
  const created = await client.documents.create(projectId, `occ ${stamp}`);
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
  for (const it of Object.values(items)) await client.vocabItems.delete(it.id).catch(() => {});
});

async function openTab(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=analyze`);
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  await page.waitForLoadState('networkidle');
  return { ctx, page };
}
const opener = (page, tokenId) => page.locator(`button[data-vocab-opener="${tokenId}"]`);
const chip = (page, tokenId) =>
  page.locator(`button.igt-vocab__hint[data-vocab-opener="${tokenId}"]`);
async function linkVia(page, tokenId, form) {
  await opener(page, tokenId).click();
  await page.locator('.igt-vocab-pop').waitFor({ state: 'visible' });
  await page.locator('.igt-vocab-pop__search').fill(form);
  await page.locator('.igt-vocab-pop__item', { hasText: form }).first().click();
}
const linksTo = async (tokenId) => {
  const raw = await client.documents.get(documentId, true);
  return raw.textLayers
    .flatMap((t) => t.tokenLayers)
    .flatMap((l) => l.vocabs || [])
    .flatMap((v) => v.vocabLinks || [])
    .filter((l) => l.tokens[0] === tokenId);
};

test('B13-03: the same token linked from a stale tab conflicts; one link survives', async ({
  browser,
}) => {
  const A = await openTab(browser);
  const B = await openTab(browser);
  try {
    await linkVia(A.page, ids.w[0], items.occA.form);
    await expect(chip(A.page, ids.w[0])).toHaveText(items.occA.form);
    await A.page.waitForLoadState('networkidle');
    // B still holds the old document version.
    await linkVia(B.page, ids.w[0], items.occB.form);
    const status = B.page.locator('.igt-island__error');
    await expect(status).toContainText(/changed elsewhere/i);
    const text = await status.innerText();
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(UUID_RE);
    // B resynced to A's state: the chip shows A's item, and the server has exactly one link.
    await expect(chip(B.page, ids.w[0])).toHaveText(items.occA.form);
    const links = await linksTo(ids.w[0]);
    expect(links.length).toBe(1);
    expect(links[0].vocabItem.id).toBe(items.occA.id);
  } finally {
    await A.ctx.close();
    await B.ctx.close();
  }
});

test("B13-02: a gloss in A, then a link in stale B: banner, resync, A's gloss kept", async ({
  browser,
}) => {
  const A = await openTab(browser);
  const B = await openTab(browser);
  try {
    const gA = A.page.locator(`.igt-field[data-cell-key="ma:${ids.m[1]}:Gloss"]`);
    await gA.click();
    await A.page.keyboard.type('TWO');
    await A.page.keyboard.press('Enter');
    await A.page.waitForLoadState('networkidle');
    await linkVia(B.page, ids.w[2], items.occB.form);
    await expect(B.page.locator('.igt-island__error')).toContainText(/changed elsewhere/i);
    // After the resync B sees A's gloss; B's rejected link is not on the server.
    await expect(B.page.locator(`.igt-field[data-cell-key="ma:${ids.m[1]}:Gloss"]`)).toHaveValue(
      'TWO',
    );
    expect((await linksTo(ids.w[2])).length).toBe(0);
    // Redoing the link from the now-current B succeeds.
    await linkVia(B.page, ids.w[2], items.occB.form);
    await expect(chip(B.page, ids.w[2])).toHaveText(items.occB.form);
    await B.page.waitForLoadState('networkidle');
    expect((await linksTo(ids.w[2])).length).toBe(1);
  } finally {
    await A.ctx.close();
    await B.ctx.close();
  }
});
