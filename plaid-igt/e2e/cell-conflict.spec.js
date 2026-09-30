import PlaidClient, { ROLES, cpLength } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';
import { getFixture } from './fixtureProject.js';

// Luke's ruling Q1: a gloss edit refused because another tab stored another
// value first. The cell shows the stored value, with the refused one under
// it ("Yours: hound · Enter to keep yours"), and a toast names the change.
// Leaving the cell sends nothing, Enter back in it stores the refused value,
// and Escape lets it go. Tab B's write is held until tab A's has landed, so
// B's goes out on a document that has moved on and the server refuses it.
// A throwaway document in "E2E IGT Fixture", deleted afterwards.

const CORE = 'http://localhost:8085';
const roleOf = (l) => l?.config?.plaid?.role;
const BODY = 'uno dos tres';

let client;
let projectId;
let documentId;
let morphs = [];

test.beforeAll(async () => {
  client = new PlaidClient(CORE, readToken().token);
  await getFixture(); // builds the fixture project where the database lacks it
  const project = (await client.projects.list()).find((p) => p.name === 'E2E IGT Fixture');
  if (!project) throw new Error('run node e2e/fixtureProject.js first');
  projectId = project.id;
  const full = await client.projects.get(projectId);
  const textLayer = full.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const layer = (role) => textLayer.tokenLayers.find((l) => roleOf(l) === role);
  const created = await client.documents.create(projectId, `cell conflict ${Date.now()}`);
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
  const ml = seeded.textLayers
    .find((l) => roleOf(l) === ROLES.BASELINE)
    .tokenLayers.find((l) => roleOf(l) === ROLES.MORPHEME);
  morphs = words.map((x) => ml.tokens.find((t) => t.begin === x.begin).id);
});

test.afterAll(async () => {
  if (documentId) await client.documents.delete(documentId).catch(() => {});
});

const glossOf = async (morphId) => {
  const raw = await client.documents.get(documentId, true);
  const gloss = raw.textLayers
    .flatMap((t) => t.tokenLayers)
    .flatMap((l) => l.spanLayers || [])
    .find((s) => s.name === 'Gloss');
  return gloss.spans.find((s) => s.tokens[0] === morphId)?.value ?? null;
};

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const READ_POST = /\/api\/v1\/(query|login)(\?|$)/;
const isWrite = (req) => WRITE.has(req.method()) && !READ_POST.test(req.url());

// A tab whose writes can be held (`hold()` answers the release) and counted.
async function openTab(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const tab = { ctx, page, writes: 0, gate: null };
  await page.route(/\/api\/v1\//, async (route) => {
    const req = route.request();
    if (isWrite(req)) {
      tab.writes += 1;
      if (tab.gate) await tab.gate;
    }
    await route.continue().catch(() => {});
  });
  tab.hold = () => {
    let release;
    tab.gate = new Promise((r) => (release = r));
    return () => {
      tab.gate = null;
      release();
    };
  };
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=analyze`);
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  await page.waitForLoadState('networkidle');
  return tab;
}

const glossCell = (page, morphId) =>
  page.locator(`.igt-field[data-cell-key="ma:${morphId}:Gloss"]`);
const settled = (page) => expect(page.locator('.igt-status[data-state="saving"]')).toHaveCount(0);

// B types `mine` into the gloss of `morphId` with its write held, A stores
// `theirs` there, and B's write goes out after it.
async function loseTo(A, B, morphId, mine, theirs) {
  const release = B.hold();
  await glossCell(B.page, morphId).click();
  await B.page.keyboard.type(mine);
  await B.page.keyboard.press('Tab');
  await glossCell(A.page, morphId).click();
  await A.page.keyboard.type(theirs);
  await A.page.keyboard.press('Tab');
  await expect.poll(() => glossOf(morphId)).toBe(theirs);
  release();
  await settled(B.page);
}

test('a lost gloss shows the stored value and yours under it, and Enter keeps yours', async ({
  browser,
}) => {
  const A = await openTab(browser);
  const B = await openTab(browser);
  try {
    await loseTo(A, B, morphs[0], 'hound', 'dog.PL');
    const cell = glossCell(B.page, morphs[0]);
    await expect(cell).toHaveValue('dog.PL');
    await expect(cell).toHaveClass(/igt-field--conflict/);
    const note = B.page.locator('.igt-field-conflict');
    await expect(note).toHaveText('Yours: hound · Enter to keep yours');
    await expect(cell).toHaveAttribute('aria-describedby', await note.getAttribute('id'));
    await expect(
      B.page.locator('[data-sonner-toast]').filter({ hasText: /changed this to dog\.PL\./ }),
    ).toBeVisible();

    // Leaving the cell sends nothing.
    const before = B.writes;
    await cell.click();
    await B.page.keyboard.press('Tab');
    await B.page.waitForTimeout(500);
    await settled(B.page);
    expect(B.writes).toBe(before);
    expect(await glossOf(morphs[0])).toBe('dog.PL');
    await expect(note).toHaveText('Yours: hound · Enter to keep yours');

    // Enter back in the cell, with nothing typed, stores yours.
    await cell.click();
    await B.page.keyboard.press('Enter');
    await expect.poll(() => glossOf(morphs[0])).toBe('hound');
    await expect(cell).toHaveValue('hound');
    await expect(B.page.locator('.igt-field-conflict')).toHaveCount(0);
  } finally {
    await A.ctx.close();
    await B.ctx.close();
  }
});

test('Escape lets a lost gloss go, and the stored value stays', async ({ browser }) => {
  const A = await openTab(browser);
  const B = await openTab(browser);
  try {
    await loseTo(A, B, morphs[1], 'cat', 'feline');
    const cell = glossCell(B.page, morphs[1]);
    await expect(cell).toHaveValue('feline');
    await expect(B.page.locator('.igt-field-conflict')).toHaveText(
      'Yours: cat · Enter to keep yours',
    );
    const before = B.writes;
    await cell.click();
    await B.page.keyboard.press('Escape');
    await expect(B.page.locator('.igt-field-conflict')).toHaveCount(0);
    await expect(cell).not.toHaveClass(/igt-field--conflict/);
    await expect(cell).toHaveValue('feline');
    await B.page.waitForTimeout(500);
    await settled(B.page);
    expect(B.writes).toBe(before);
    expect(await glossOf(morphs[1])).toBe('feline');
  } finally {
    await A.ctx.close();
    await B.ctx.close();
  }
});
