import PlaidClient, { ROLES, cpLength } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken, collectClientErrors } from './fixtures.js';

// The split paths that depend on real timing, so a headless DOM cannot vouch
// for them: a split at the right edge of a form (nothing after the caret yet),
// and a segmentation typed faster than the server answers. In the second
// case which keys land while a split is in flight depends on the machine, and
// the point is that the stored result must not. Throwaway document in "E2E
// IGT Fixture", deleted afterwards.

const CORE = 'http://localhost:8085';
const roleOf = (l) => l?.config?.plaid?.role;
const NONCE = Date.now().toString(36);
const W1 = `ngoko${NONCE}`;
const W2 = `tatami${NONCE}`;
const BODY = `${W1} ${W2}`;

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

  const created = await client.documents.create(projectId, `split-timing ${Date.now()}`);
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
  ids = {
    w: words.map((x) => wl.tokens.find((t) => t.begin === x.begin).id),
    morphLayer: MORPH.id,
    words,
  };
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

// The stored forms of word `i`, in precedence order, straight from the server.
async function storedForms(i) {
  const raw = await client.documents.get(documentId, true);
  const ml = raw.textLayers.flatMap((t) => t.tokenLayers).find((l) => l.id === ids.morphLayer);
  const { begin, end } = ids.words[i];
  return ml.tokens
    .filter((t) => t.begin === begin && t.end === end)
    .sort((a, b) => (a.precedence ?? 0) - (b.precedence ?? 0))
    .map((t) => t.metadata?.form);
}

const formCells = (page, wordId) => page.locator(`.igt-morph-field[data-word="${wordId}"]`);

test('a split at the right edge leaves the new piece empty and focused, and typing fills it', async ({
  page,
}) => {
  const diag = collectClientErrors(page);
  await openAnalyze(page);
  const cells = formCells(page, ids.w[0]);
  await cells.first().click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('ngo');
  await page.keyboard.press('-');
  await expect(cells).toHaveCount(2);
  // The new piece shows nothing (not the whole word) and has the caret.
  await expect(cells.nth(1)).toBeFocused();
  await expect(cells.nth(1)).toHaveValue('');
  // A person types the rest at a human pace, then moves on.
  await page.keyboard.type('ko', { delay: 80 });
  await page.keyboard.press('Enter');
  await page.waitForLoadState('networkidle');
  await expect.poll(() => storedForms(0)).toEqual(['ngo', 'ko']);
  expect.soft(diag.failures, 'no API failures').toEqual([]);
});

test('a segmentation typed faster than the server answers lands piece by piece', async ({
  page,
}) => {
  const diag = collectClientErrors(page);
  await openAnalyze(page);
  const cells = formCells(page, ids.w[1]);
  await cells.first().click();
  await page.keyboard.press('Control+a');
  // No delay at all: the second and third "-" arrive while earlier splits are
  // still in flight on any real server.
  await page.keyboard.type('ta-ta-mi', { delay: 0 });
  await page.keyboard.press('Enter');
  await expect(cells).toHaveCount(3);
  await page.waitForLoadState('networkidle');
  await expect.poll(() => storedForms(1)).toEqual(['ta', 'ta', 'mi']);
  await expect(cells.nth(0)).toHaveValue('ta');
  await expect(cells.nth(1)).toHaveValue('ta');
  await expect(cells.nth(2)).toHaveValue('mi');
  expect.soft(diag.failures, 'no API failures').toEqual([]);
});
