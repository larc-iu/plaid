import PlaidClient, { ROLES, cpLength } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';

// "Analyze every ‹again› in this text like this", through the real grid. The
// first word is analyzed by a person as a-gain / 3-take, and the two after it
// have no morpheme token at all, which is what an unanalyzed word is. One click
// on the popover row has to segment and gloss both, and the server has to hold
// it after a reload.
//
// Throwaway document in the "E2E IGT Fixture" project, deleted afterwards.

const CORE = 'http://localhost:8085';
const roleOf = (l) => l?.config?.plaid?.role;
const NONCE = Date.now().toString(36);
const FORM = `a${NONCE}`;
const BODY = `${FORM} ${FORM} ${FORM}`;

let client;
let projectId;
let documentId;

test.beforeAll(async () => {
  client = new PlaidClient(CORE, readToken().token);
  const project = (await client.projects.list()).find((p) => p.name === 'E2E IGT Fixture');
  if (!project) throw new Error('run node e2e/fixtureProject.js first');
  projectId = project.id;
  const full = await client.projects.get(projectId);
  const textLayer = full.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const layer = (role) => textLayer.tokenLayers.find((l) => roleOf(l) === role);
  const MORPH = layer(ROLES.MORPHEME);
  const gloss = MORPH.spanLayers.find((s) => s.name === 'Gloss');

  const created = await client.documents.create(projectId, `analyze-all-spec ${Date.now()}`);
  documentId = created.id;
  await client.texts.create(textLayer.id, documentId, BODY);
  const raw = await client.documents.get(documentId, true);
  const TEXT = raw.textLayers.find((l) => roleOf(l) === ROLES.BASELINE).text.id;
  await client.tokens.bulkCreate([
    { tokenLayerId: layer(ROLES.SENTENCE).id, text: TEXT, begin: 0, end: cpLength(BODY) },
  ]);
  const words = [...BODY.matchAll(/\S+/g)].map((m) => ({
    begin: m.index,
    end: m.index + m[0].length,
  }));
  await client.tokens.bulkCreate(
    words.map((w) => ({ tokenLayerId: layer(ROLES.WORD).id, text: TEXT, ...w })),
  );
  // The first word only: a- + the rest, glossed by a person (no stamp).
  const first = { tokenLayerId: MORPH.id, text: TEXT, ...words[0] };
  const { ids } = await client.tokens.bulkCreate([
    { ...first, precedence: 1, metadata: { form: 'a', morphType: 'prefix' } },
    { ...first, precedence: 2, metadata: { form: NONCE, morphType: 'stem' } },
  ]);
  await client.spans.create(gloss.id, [ids[0]], '3');
  await client.spans.create(gloss.id, [ids[1]], 'take');
});

test.afterAll(async () => {
  if (documentId) await client.documents.delete(documentId).catch(() => {});
});

const columns = (page) =>
  page.locator('.igt-token-col').evaluateAll((cols) =>
    cols.map((col) =>
      [...col.querySelectorAll('.igt-morph-col')].map((m) => {
        const read = (el) => (el?.value ?? el?.textContent ?? '').trim();
        return {
          form: read(m.querySelector('[data-tier="mf:"]')),
          gloss: read(m.querySelector('[data-tier="ma:Gloss"]')),
        };
      }),
    ),
  );

test('one row gives every unanalyzed twin the word’s analysis', async ({ page }) => {
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=analyze`);
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  await page.waitForLoadState('networkidle');

  expect((await columns(page)).map((c) => c.length)).toEqual([2, 1, 1]);

  await page.locator('.igt-morph-col .igt-vocab__opener').first().click();
  const row = page.getByRole('button', { name: /Analyze every/ });
  await expect(row).toContainText(`Analyze every “${FORM}” in this text like this`);
  await expect(row).toContainText('×2');
  await row.click();

  const want = [
    { form: 'a', gloss: '3' },
    { form: NONCE, gloss: 'take' },
  ];
  await expect.poll(() => columns(page)).toEqual([want, want, want]);

  // Human work, so nothing is left for anyone to confirm.
  await expect(page.locator('[class*="--machine"], [class*="--contributed"]')).toHaveCount(0);

  await page.reload();
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  await expect.poll(() => columns(page)).toEqual([want, want, want]);
  // Nothing left to offer.
  await page.locator('.igt-morph-col .igt-vocab__opener').first().click();
  await page.locator('.igt-vocab-pop').waitFor({ state: 'visible' });
  await expect(page.getByRole('button', { name: /Analyze every/ })).toHaveCount(0);
});
