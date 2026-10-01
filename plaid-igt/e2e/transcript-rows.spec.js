import PlaidClient, { ROLES, cpLength, cpSlice } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';
import { createScratchProject } from './fixtureProject.js';
import { wavBytes } from './bugbash/harness.mjs';

// Two users edit the text of one transcript row. A row's text is saved as the
// edits typed in it, so its segment keeps its id and the words inside keep
// their morphemes and glosses (M1). The second user's edit, made over the
// text as it was, loses: the row shows the stored text with "Yours: X · Enter
// to keep yours" under it (Luke's ruling Q1), leaving it writes nothing, and
// Enter stores the second user's text. A throwaway project and a throwaway
// second user, both deleted afterwards.

const CORE = process.env.PLAID_CORE_URL || 'http://localhost:8085';
const roleOf = (l) => l?.config?.plaid?.role;
const BODY = 'uno dos tres';
const PASSWORD = 'rows-pass-123';

let admin;
let projectId;
let documentId;
let other; // { email, token }

// The document's baseline layer as the server has it.
const read = async () => {
  const raw = await admin.documents.get(documentId, true);
  return raw.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
};
const layerOf = (tl, role) => tl.tokenLayers.find((l) => roleOf(l) === role);
// Each segment as `[id, text]`, in text order.
const segments = async () => {
  const tl = await read();
  return layerOf(tl, ROLES.TIME_ALIGNMENT).tokens.map((t) => [
    t.id,
    cpSlice(tl.text.body, t.begin, t.end),
  ]);
};
// Each gloss as `morpheme:value`.
const glosses = async () => {
  const tl = await read();
  const morphemes = layerOf(tl, ROLES.MORPHEME);
  const gloss = morphemes.spanLayers.find((s) => s.name === 'Gloss');
  return gloss.spans.map((s) => {
    const m = morphemes.tokens.find((t) => t.id === s.tokens[0]);
    return `${m ? cpSlice(tl.text.body, m.begin, m.end) : '?'}:${s.value}`;
  });
};

test.beforeAll(async () => {
  admin = new PlaidClient(CORE, readToken().token);
  ({ projectId, documentId } = await createScratchProject({
    name: `transcript rows ${Date.now()}`,
    docName: 'rows',
    body: BODY,
  }));
  const tl = await read();
  const TEXT = tl.text.id;
  const words = layerOf(tl, ROLES.WORD).tokens;
  // One morpheme per word, glossed, and one segment per word, a second each.
  const morphemeLayer = layerOf(tl, ROLES.MORPHEME);
  const { ids } = await admin.tokens.bulkCreate(
    words.map((w) => ({
      tokenLayerId: morphemeLayer.id,
      text: TEXT,
      begin: w.begin,
      end: w.end,
      precedence: 1,
    })),
  );
  const gloss = morphemeLayer.spanLayers.find((s) => s.name === 'Gloss');
  for (const [i, id] of ids.entries()) await admin.spans.create(gloss.id, [id], `G${i + 1}`);
  for (const [i, w] of words.entries()) {
    await admin.tokens.create(
      layerOf(tl, ROLES.TIME_ALIGNMENT).id,
      TEXT,
      w.begin,
      w.end,
      undefined,
      {
        timeBegin: i,
        timeEnd: i + 1,
      },
    );
  }
  await admin.documents.uploadMedia(
    documentId,
    new File([wavBytes(6)], 'transcript-rows.wav', { type: 'audio/wav' }),
  );
  // The second user, a writer on the project.
  const email = `rows-${Date.now()}@example.com`;
  await admin.users.create(email, PASSWORD, false, 'Rows B');
  await admin.projects.addWriter(projectId, email);
  const signedIn = await PlaidClient.login(CORE, email, PASSWORD);
  other = { email, token: (await signedIn.apiTokens.create(email, 'e2e rows')).token };
});

test.afterAll(async () => {
  if (projectId) await admin.projects.delete(projectId).catch(() => {});
  if (other) await admin.users.delete(other.email).catch(() => {});
});

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const READ_POST = /\/api\/v1\/(query|login)(\?|$)/;
const isWrite = (req) => WRITE.has(req.method()) && !READ_POST.test(req.url());

// A user's page on the document's Media tab, counting the writes it sends.
async function openAs(browser, auth = undefined) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const tab = { ctx, page, writes: 0 };
  await page.route(/\/api\/v1\//, async (route) => {
    if (isWrite(route.request())) tab.writes += 1;
    await route.continue().catch(() => {});
  });
  await seedAuth(page, auth);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}`);
  await page.waitForLoadState('networkidle');
  await page.getByRole('tab', { name: 'Media' }).click();
  await expect(page.getByLabel('Segment 3 text')).toBeVisible({ timeout: 15000 });
  return tab;
}

test("two users edit the same row: each edit keeps the segment and the word's gloss, and the later one shows the stored text with its own under it", async ({
  browser,
}) => {
  const before = await segments();
  const A = await openAs(browser);
  const B = await openAs(browser, {
    token: other.token,
    userId: other.email,
    displayName: 'Rows B',
    isAdmin: false,
  });
  try {
    // A types "!" at the end of row 2. The segment keeps its id, and the
    // word, which the "!" joins, keeps its morpheme and gloss (M1).
    const rowA = A.page.getByLabel('Segment 2 text');
    await rowA.click();
    await rowA.press('End');
    await A.page.keyboard.type('!');
    await rowA.press('Enter');
    await expect.poll(async () => (await segments())[1][1]).toBe('dos!');
    expect((await segments()).map(([id]) => id)).toEqual(before.map(([id]) => id));
    expect(await glosses()).toEqual(['uno:G1', 'dos!:G2', 'tres:G3']);

    // B, on the text as it was, types over row 2. Refused: the row shows
    // A's text with B's under it, on the same row.
    const row = B.page.getByLabel('Segment 2 text');
    await row.click();
    await row.press('ControlOrMeta+a');
    await B.page.keyboard.type('DOS');
    await row.press('Enter');
    await expect(row).toHaveValue('dos!', { timeout: 15000 });
    await expect(B.page.getByText('Yours: DOS · Enter to keep yours')).toBeVisible();
    await expect(B.page.getByRole('list', { name: 'Not saved' })).toHaveCount(0);
    expect(await segments()).toEqual([
      [before[0][0], 'uno'],
      [before[1][0], 'dos!'],
      [before[2][0], 'tres'],
    ]);

    // Leaving the row writes nothing.
    const writes = B.writes;
    await row.click();
    await row.press('Tab');
    await B.page.waitForTimeout(800);
    expect(B.writes).toBe(writes);
    expect((await segments())[1][1]).toBe('dos!');

    // Enter in it keeps B's text, over A's, on the same segment.
    await row.click();
    await row.press('Enter');
    await expect.poll(async () => (await segments())[1][1]).toBe('DOS');
    await expect(B.page.getByText('Enter to keep yours')).toHaveCount(0);
    expect((await segments()).map(([id]) => id)).toEqual(before.map(([id]) => id));
    // A sees it too once the page reads the document again.
    await A.page.reload();
    await A.page.getByRole('tab', { name: 'Media' }).click();
    await expect(A.page.getByLabel('Segment 2 text')).toHaveValue('DOS', { timeout: 15000 });
  } finally {
    await A.ctx.close();
    await B.ctx.close();
  }
});

test('a row whose segment the other user deleted is listed as not saved, and nothing is written', async ({
  browser,
}) => {
  const B = await openAs(browser, {
    token: other.token,
    userId: other.email,
    displayName: 'Rows B',
    isAdmin: false,
  });
  try {
    // Row 3's segment is deleted elsewhere, its text kept.
    const tl = await read();
    const third = layerOf(tl, ROLES.TIME_ALIGNMENT).tokens[2];
    const body = tl.text.body;
    await admin.tokens.delete(third.id);

    const row = B.page.getByLabel('Segment 3 text');
    await row.click();
    await row.press('End');
    await B.page.keyboard.type('s');
    await row.press('Enter');
    const notSaved = B.page.getByRole('list', { name: 'Not saved' });
    await expect(notSaved).toContainText(`${cpSlice(body, third.begin, third.end)}s`, {
      timeout: 15000,
    });
    expect((await read()).text.body).toBe(body);
    expect(cpLength((await read()).text.body)).toBe(cpLength(body));
  } finally {
    await B.ctx.close();
  }
});
