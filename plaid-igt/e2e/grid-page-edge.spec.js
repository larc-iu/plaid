import PlaidClient, { ROLES } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken, CORE } from './fixtures.js';
import { getFixture, roleOf } from './fixtureProject.js';

// H2-2: Enter and Tab from the last cell of a row on an Analyze page go on to
// that row on the next page, and Shift+Tab back, instead of dropping focus.
// Throwaway document of 26 one-line sentences in "E2E IGT Fixture" (a page is
// 25), deleted afterwards.

let client;
let projectId;
let documentId;
let sentenceIds = [];

test.beforeAll(async () => {
  client = new PlaidClient(CORE, readToken().token);
  ({ projectId } = await getFixture());
  const full = await client.projects.get(projectId);
  const textLayer = full.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const layer = (role) => textLayer.tokenLayers.find((l) => roleOf(l) === role);
  const created = await client.documents.create(projectId, `page-edge ${Date.now()}`);
  documentId = created.id;
  const lines = Array.from({ length: 26 }, (_, i) => `pe${i + 1}a pe${i + 1}b`);
  const body = lines.join('\n');
  await client.texts.create(textLayer.id, documentId, body);
  const raw = await client.documents.get(documentId, true);
  const TEXT = raw.textLayers.find((l) => roleOf(l) === ROLES.BASELINE).text.id;
  const sentences = [];
  const words = [];
  let at = 0;
  lines.forEach((line, i) => {
    const end = at + line.length + (i < lines.length - 1 ? 1 : 0);
    sentences.push({ begin: at, end });
    for (const m of line.matchAll(/\S+/g)) {
      words.push({ begin: at + m.index, end: at + m.index + m[0].length });
    }
    at = end;
  });
  await client.tokens.bulkCreate(
    sentences.map((s) => ({ tokenLayerId: layer(ROLES.SENTENCE).id, text: TEXT, ...s })),
  );
  await client.tokens.bulkCreate(
    words.map((w) => ({ tokenLayerId: layer(ROLES.WORD).id, text: TEXT, ...w })),
  );
  await client.tokens.bulkCreate(
    words.map((w) => ({ tokenLayerId: layer(ROLES.MORPHEME).id, text: TEXT, ...w, precedence: 1 })),
  );
  const seeded = await client.documents.get(documentId, true);
  const sl = seeded.textLayers
    .find((l) => roleOf(l) === ROLES.BASELINE)
    .tokenLayers.find((l) => roleOf(l) === ROLES.SENTENCE);
  sentenceIds = [...sl.tokens].sort((a, b) => a.begin - b.begin).map((t) => t.id);
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

const inSentence = (page, n, tier) =>
  page.locator(`[data-sentence-id="${sentenceIds[n - 1]}"] .igt-field[data-tier^="${tier}"]`);
const focused = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return {
      tag: el?.tagName,
      tier: el?.dataset?.tier ?? null,
      sentence: el?.closest?.('[data-sentence-id]')?.dataset.sentenceId ?? null,
    };
  });

test('Tab from the last sentence field of a page goes to the next page, Shift+Tab back', async ({
  page,
}) => {
  await openAnalyze(page);
  const field = inSentence(page, 25, 'sa:').first();
  const tier = await field.getAttribute('data-tier');
  await field.click();
  await page.keyboard.press('Tab');
  await expect
    .poll(() => focused(page))
    .toEqual({
      tag: expect.any(String),
      tier,
      sentence: sentenceIds[25],
    });
  await expect(page.locator('.igt-pager__label').first()).toHaveText('26–26 of 26');
  await page.keyboard.press('Shift+Tab');
  await expect
    .poll(() => focused(page))
    .toEqual({
      tag: expect.any(String),
      tier,
      sentence: sentenceIds[24],
    });
});

test('Enter in the last word cell of a page goes on to the next page', async ({ page }) => {
  await openAnalyze(page);
  const cells = inSentence(page, 25, 'wa:');
  const last = cells.last();
  const tier = await last.getAttribute('data-tier');
  await last.click();
  await page.keyboard.press('Enter');
  await expect
    .poll(() => focused(page))
    .toEqual({
      tag: 'INPUT',
      tier,
      sentence: sentenceIds[25],
    });
});

// REV-HFT-R2-1: Tab and at once Shift+Tab, before the first turn's URL has
// come back, keep focus on the field (the late echo used to turn the page).
test('Tab then Shift+Tab at once comes back to the field, and focus stays', async ({ page }) => {
  await openAnalyze(page);
  const field = inSentence(page, 25, 'sa:').first();
  const tier = await field.getAttribute('data-tier');
  await field.click();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect
    .poll(() => focused(page))
    .toEqual({ tag: expect.any(String), tier, sentence: sentenceIds[24] });
  await expect(page.locator('.igt-pager__label').first()).toHaveText('1–25 of 26');
  await page.keyboard.type('stays');
  await expect(inSentence(page, 25, 'sa:').first()).toHaveValue(/stays$/);
});

// H2-14-1: the review keys go on across a page's edge too. A machine gloss in
// sentence 26 only (page 2): Ctrl+Shift+Down from sentence 25's last word turns
// the page, lands on it and tells the URL.
test('Ctrl+Shift+Down from the last word of a page goes to the next unverified word', async ({
  page,
}) => {
  const raw = await client.documents.get(documentId, true);
  const base = raw.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const morphs = base.tokenLayers.find((l) => roleOf(l) === ROLES.MORPHEME);
  const gloss = morphs.spanLayers[0];
  const first26 = [...morphs.tokens].sort((a, b) => a.begin - b.begin)[50];
  await client.spans.create(gloss.id, [first26.id], 'MACH', {
    prov: 'inferred',
    provSource: 'service:e2e',
  });
  await openAnalyze(page);
  const last = inSentence(page, 25, 'wa:').last();
  await last.click();
  await page.keyboard.press('ControlOrMeta+Shift+ArrowDown');
  await expect(page.locator('.igt-pager__label').first()).toHaveText('26–26 of 26');
  await expect.poll(() => focused(page)).toMatchObject({ sentence: sentenceIds[25] });
  await expect(page).toHaveURL(/page=2|page%3D2/);
});
