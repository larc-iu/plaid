import PlaidClient, { ROLES, cpLength, stampInferred } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';

// TEST_PLAN A2-13 / A8-02 / B10-02: the Tokenize tab's delete and split
// confirms count machine-made material (spans, links) exactly like human
// material, and confirming actually removes it. Throwaway document in the
// "E2E IGT Fixture" project, deleted afterwards.

const CORE = 'http://localhost:8085';
const roleOf = (l) => l?.config?.plaid?.role;
const BODY = 'alpha beta gamma';

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
  const WORD = layer(ROLES.WORD);
  const MORPH = layer(ROLES.MORPHEME);
  const gloss = MORPH.spanLayers.find((s) => s.name === 'Gloss');
  const pos = WORD.spanLayers.find((s) => s.name === 'Part of Speech');
  const vocab = full.vocabs.find((v) => v.name === 'IGT Lexicon');
  const stamp = Date.now();
  for (const f of ['one', 'two']) {
    const it = await client.vocabItems.create(vocab.id, `${f}-${stamp}`);
    items[f] = it.id;
  }
  const created = await client.documents.create(projectId, `tokenize-confirm ${stamp}`);
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
  };
  // alpha (A2-13): machine POS span on the word + machine link on its morpheme.
  await client.spans.create(pos.id, [ids.w[0]], 'N', stampInferred('service:test'));
  await client.vocabLinks.create(items.one, [ids.m[0]], stampInferred('rule:precedent-or-unique'));
  // beta (A8-02 + B10-02): machine morpheme gloss + human word POS + human morpheme link.
  await client.spans.create(gloss.id, [ids.m[1]], 'MACH', stampInferred('service:test'));
  await client.spans.create(pos.id, [ids.w[1]], 'ADJ');
  await client.vocabLinks.create(items.two, [ids.m[1]]);
});

test.afterAll(async () => {
  if (documentId) await client.documents.delete(documentId).catch(() => {});
  for (const id of Object.values(items)) await client.vocabItems.delete(id).catch(() => {});
});

async function openTokenize(page) {
  if (page.url() !== 'about:blank') await page.goto('about:blank');
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=tokenize`);
  await page.locator('.token').first().waitFor({ state: 'visible' });
  await page.waitForLoadState('networkidle');
}
const rawDoc = () => client.documents.get(documentId, true);
const wordTokens = async () => {
  const r = await rawDoc();
  return r.textLayers[0].tokenLayers.find((l) => roleOf(l) === ROLES.WORD).tokens;
};

test('A2-13: deleting a word counts its machine span and link, then cascades them', async ({
  page,
}) => {
  await openTokenize(page);
  await page.locator('.token', { hasText: 'alpha' }).click({ button: 'right' });
  const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'));
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('1 annotation');
  await expect(dialog).toContainText('1 vocabulary link');
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('.token', { hasText: 'alpha' })).toHaveCount(0);
  await page.waitForLoadState('networkidle');
  const toks = await wordTokens();
  expect(toks.some((t) => t.id === ids.w[0])).toBe(false);
});

test('A8-02 + B10-02: splitting a word counts its machine morpheme gloss and link; word spans survive', async ({
  page,
}) => {
  await openTokenize(page);
  await page.locator('.token', { hasText: 'beta' }).click();
  await page.locator('.splitter-box').waitFor({ state: 'visible' });
  await page.locator('.splitter-split-point').nth(1).click(); // be | ta
  const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'));
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Split');
  await expect(dialog).toContainText('1 annotation');
  await expect(dialog).toContainText('1 vocabulary link');
  await dialog.getByRole('button', { name: /Split anyway/ }).click();
  await expect(page.locator('.token', { hasText: /^be$/ })).toHaveCount(1);
  await expect(page.locator('.token', { hasText: /^ta$/ })).toHaveCount(1);
  await page.waitForLoadState('networkidle');
  const r = await rawDoc();
  const tl = r.textLayers[0];
  const wl = tl.tokenLayers.find((l) => roleOf(l) === ROLES.WORD);
  const ml = tl.tokenLayers.find((l) => roleOf(l) === ROLES.MORPHEME);
  const be = wl.tokens.find((t) => t.id === ids.w[1]);
  expect(be, 'left part keeps the token id').toBeTruthy();
  expect(
    ml.tokens.some((m) => m.id === ids.m[1]),
    'morpheme material gone',
  ).toBe(false);
  const posSpans = wl.spanLayers.find((s) => s.name === 'Part of Speech').spans;
  expect(
    posSpans.some((s) => s.tokens[0] === ids.w[1] && s.value === 'ADJ'),
    'word-level span survives',
  ).toBe(true);
  const links = tl.tokenLayers.flatMap((l) => l.vocabs || []).flatMap((v) => v.vocabLinks || []);
  expect(
    links.some((l) => l.tokens[0] === ids.m[1]),
    'morpheme link gone',
  ).toBe(false);
});
