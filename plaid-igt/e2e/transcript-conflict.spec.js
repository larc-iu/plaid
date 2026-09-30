import PlaidClient, { ROLES, cpLength, cpSlice } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';
import { getFixture } from './fixtureProject.js';
import { wavBytes } from './bugbash/harness.mjs';

// Two tabs edit the text of one transcript segment. Tab A's edit lands first,
// and the segment keeps its id. Tab B's edit goes with the digest of the body
// it read and is refused as a conflict on that row (Luke's ruling Q1): the
// row shows A's text with B's under it, leaving the row writes nothing, and
// Enter stores B's. A throwaway document in "E2E IGT Fixture", deleted
// afterwards.

const CORE = process.env.PLAID_CORE_URL || 'http://localhost:8085';
const roleOf = (l) => l?.config?.plaid?.role;
const BODY = 'uno dos tres';

let client;
let projectId;
let documentId;

test.beforeAll(async () => {
  client = new PlaidClient(CORE, readToken().token);
  await getFixture(); // builds the fixture project where the database lacks it
  const project = (await client.projects.list()).find((p) => p.name === 'E2E IGT Fixture');
  if (!project) throw new Error('run node e2e/fixtureProject.js first');
  projectId = project.id;
  const full = await client.projects.get(projectId);
  const textLayer = full.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const layer = (role) => textLayer.tokenLayers.find((l) => roleOf(l) === role);
  const created = await client.documents.create(projectId, `transcript conflict ${Date.now()}`);
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
  // One segment per word, a second each.
  for (const [i, w] of words.entries()) {
    await client.tokens.create(layer(ROLES.TIME_ALIGNMENT).id, TEXT, w.begin, w.end, undefined, {
      timeBegin: i,
      timeEnd: i + 1,
    });
  }
  await client.documents.uploadMedia(
    documentId,
    new File([wavBytes(6)], 'transcript-conflict.wav', { type: 'audio/wav' }),
  );
});

test.afterAll(async () => {
  if (documentId) await client.documents.delete(documentId).catch(() => {});
});

// The text of the segment that starts at `timeBegin`, as the server has it.
const storedText = async (timeBegin) => {
  const raw = await client.documents.get(documentId, true);
  const textLayer = raw.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const segment = textLayer.tokenLayers
    .find((l) => roleOf(l) === ROLES.TIME_ALIGNMENT)
    .tokens.find((t) => t.metadata?.timeBegin === timeBegin);
  return segment ? cpSlice(textLayer.text.body, segment.begin, segment.end) : null;
};

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const READ_POST = /\/api\/v1\/(query|login)(\?|$)/;
const isWrite = (req) => WRITE.has(req.method()) && !READ_POST.test(req.url());

// A tab on the document's Media tab, counting the writes it sends.
async function openTab(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const tab = { ctx, page, writes: 0 };
  await page.route(/\/api\/v1\//, async (route) => {
    if (isWrite(route.request())) tab.writes += 1;
    await route.continue().catch(() => {});
  });
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}`);
  await page.waitForLoadState('networkidle');
  await page.getByRole('tab', { name: 'Media' }).click();
  await expect(page.getByLabel('Segment 3 text')).toBeVisible({ timeout: 15000 });
  return tab;
}

test("a row's edit that lost to another tab's edit of the same segment shows the stored text with its own under it, leaving writes nothing, and Enter stores it", async ({
  browser,
}) => {
  const A = await openTab(browser);
  const B = await openTab(browser);
  try {
    // A's edit lands first, on the same segment.
    const rowA = A.page.getByLabel('Segment 2 text');
    await rowA.click();
    await rowA.fill('dos!');
    await rowA.press('Enter');
    await expect.poll(() => storedText(1)).toBe('dos!');

    // B's edit is refused. The row shows the stored text with B's under it.
    const row = B.page.getByLabel('Segment 2 text');
    await row.click();
    await row.fill('DOS');
    await row.press('Enter');
    await expect(row).toHaveValue('dos!', { timeout: 15000 });
    await expect(B.page.getByText('Yours: DOS · Enter to keep yours')).toBeVisible();
    await expect(B.page.getByRole('list', { name: 'Not saved' })).toHaveCount(0);
    expect(await storedText(1)).toBe('dos!');

    // Leaving the row writes nothing over A's text.
    const before = B.writes;
    await row.click();
    await row.press('Tab');
    await B.page.waitForTimeout(800);
    expect(B.writes).toBe(before);
    expect(await storedText(1)).toBe('dos!');

    // Enter in it stores B's.
    await row.click();
    await row.press('Enter');
    await expect.poll(() => storedText(1)).toBe('DOS');
    await expect(B.page.getByText('Enter to keep yours')).toHaveCount(0);
    expect(await storedText(0)).toBe('uno');
    expect(await storedText(2)).toBe('tres');
  } finally {
    await A.ctx.close();
    await B.ctx.close();
  }
});

test('an edit of another segment made meanwhile does not stop a row saving', async ({
  browser,
}) => {
  const A = await openTab(browser);
  const B = await openTab(browser);
  try {
    const rowA = A.page.getByLabel('Segment 1 text');
    await rowA.click();
    await rowA.fill('uno uno');
    await rowA.press('Enter');
    await expect.poll(() => storedText(0)).toBe('uno uno');

    // B's body is out of date, but not where its edit writes.
    const row = B.page.getByLabel('Segment 3 text');
    await row.click();
    await row.fill('tres tres');
    await row.press('Enter');
    await expect.poll(() => storedText(2)).toBe('tres tres');
    expect(await storedText(0)).toBe('uno uno');
    await expect(B.page.getByLabel('Segment 1 text')).toHaveValue('uno uno');
    await expect(B.page.getByLabel('Segment 3 text')).toHaveValue('tres tres');
    await expect(B.page.getByText('Enter to keep yours')).toHaveCount(0);
  } finally {
    await A.ctx.close();
    await B.ctx.close();
  }
});
