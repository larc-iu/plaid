import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken, CORE } from './fixtures.js';
import { createScratchProject } from './fixtureProject.js';

// R51: respell one word in the Analyze grid. F2 on a cell of a glossed,
// linked, commented word that sits in a multi-word expression, on a text
// another app's tokens share, and everything on it survives on the server:
// the word's token, its morpheme and gloss, its lexicon link, the expression,
// the comment, and the other app's tokens and their spans. Baseline shows the
// new text and History the entry. Then what is refused: nothing typed, a
// space, and a past state.

let projectId;
let documentId;
let seeded;

const client = () => new PlaidClient(CORE, readToken().token);
const documentPath = (tab = 'analyze') =>
  `/#/projects/${projectId}/documents/${documentId}?tab=${tab}`;

const BODY = 'Alpha kat gamma delta';
const RESPELLED = 'Alpha cat gamma delta';

const layersOf = (raw) => raw.textLayers[0].tokenLayers;
const byRole = (raw, role) => layersOf(raw).find((l) => l.config?.plaid?.role === role);
const wordAt = (raw, begin) => byRole(raw, 'word').tokens.find((t) => t.begin === begin);

test.beforeAll(async () => {
  ({ projectId, documentId } = await createScratchProject({
    name: `E2E Respell ${Date.now()}`,
    docName: 'Respell Document',
    body: BODY,
  }));
  const c = client();
  const project = await c.projects.get(projectId);
  const tl = project.textLayers[0];
  const wordLayer = tl.tokenLayers.find((l) => l.config?.plaid?.role === 'word');
  const raw = await c.documents.get(documentId, true);
  const textId = raw.textLayers[0].text.id;
  const kat = wordAt(raw, 6);
  const gamma = wordAt(raw, 10);
  const morpheme = byRole(raw, 'morpheme').tokens.find((t) => t.begin === 6);
  const glossLayer = tl.tokenLayers
    .flatMap((t) => t.spanLayers || [])
    .find((s) => s.name === 'Gloss' && s.config?.igt?.scope === 'Morpheme');

  // Another app's words on the same text, as plaid-ud lays them out: two
  // syntactic words of the token's full width (a multi-word token), each with
  // a Form span. And a node layer beside the words, as plaid-umr's.
  const synt = await c.tokenLayers.create(tl.id, 'Syntactic words', 'any', wordLayer.id);
  await c.tokenLayers.setConfig(synt.id, 'plaid', 'role', 'syntactic-word');
  const form = await c.spanLayers.create(synt.id, 'Form');
  const nodes = await c.tokenLayers.create(tl.id, 'Nodes', 'any');

  const vocab = await c.vocabLayers.create(`E2E Respell Lexicon ${Date.now()}`);
  await c.projects.linkVocab(projectId, vocab.id);
  const entry = await c.vocabItems.create(vocab.id, 'kat', { morphType: 'stem' });
  const phrase = await c.vocabItems.create(vocab.id, 'kat gamma', { morphType: 'phrase' });

  let parts;
  let node;
  let gloss;
  let wordLink;
  let mweLink;
  await c.withOperation('Seed the analysis', async () => {
    gloss = await c.spans.create(glossLayer.id, [morpheme.id], 'CAT');
    wordLink = await c.vocabLinks.create(entry.id, [kat.id]);
    mweLink = await c.vocabLinks.create(phrase.id, [kat.id, gamma.id]);
    parts = await c.tokens.bulkCreate([
      { tokenLayerId: synt.id, text: textId, begin: 6, end: 9, precedence: 1 },
      { tokenLayerId: synt.id, text: textId, begin: 6, end: 9, precedence: 2 },
    ]);
    node = await c.tokens.create(nodes.id, textId, 6, 9);
  });
  const [de, el] = parts.ids;
  const formDe = await c.spans.create(form.id, [de], 'ka');
  const formEl = await c.spans.create(form.id, [el], 't');
  const comment = await c.comments.create('token', kat.id, 'Spelling?');
  seeded = {
    kat: kat.id,
    morpheme: morpheme.id,
    gloss: gloss.id,
    wordLink: wordLink.id,
    mweLink: mweLink.id,
    gamma: gamma.id,
    parts: [de, el],
    node: node.id,
    forms: [formDe.id, formEl.id],
    comment: comment.id,
  };
});

test.afterAll(async () => {
  if (!projectId) return;
  await client()
    .projects.delete(projectId)
    .catch((e) => console.error('cleanup failed:', e.message));
});

const cellOf = (page, wordId) => page.locator(`[data-word-col="${wordId}"] .igt-field`).first();
const respellBox = (page) => page.locator('.igt-respell__box');

const openAnalyze = async (page) => {
  await seedAuth(page);
  await page.goto(documentPath());
  await expect(cellOf(page, seeded.kat)).toBeVisible({ timeout: 20_000 });
};

const tokenOf = (raw, id) =>
  layersOf(raw)
    .flatMap((l) => l.tokens || [])
    .find((t) => t.id === id);
const spanOf = (raw, id) =>
  layersOf(raw)
    .flatMap((l) => l.spanLayers || [])
    .flatMap((s) => s.spans || [])
    .find((s) => s.id === id);

test('F2 respells a glossed, linked, commented word, and all of it stays', async ({ page }) => {
  await openAnalyze(page);
  const cell = cellOf(page, seeded.kat);
  await cell.click();
  await cell.press('F2');
  const box = respellBox(page);
  await expect(box).toBeFocused();
  await expect(box).toHaveValue('kat');
  // Its text is selected: typing replaces it.
  await page.keyboard.type('cat');
  await box.press('Enter');
  await expect(box).toHaveCount(0);
  await expect(page.locator(`[data-word-col="${seeded.kat}"] .igt-token-form`)).toContainText(
    'cat',
  );

  const c = client();
  await expect
    .poll(async () => (await c.documents.get(documentId, true)).textLayers[0].text.body, {
      timeout: 15_000,
    })
    .toBe(RESPELLED);
  const raw = await c.documents.get(documentId, true);
  for (const id of [seeded.kat, seeded.morpheme, ...seeded.parts, seeded.node]) {
    const t = tokenOf(raw, id);
    expect(t, id).toBeTruthy();
    expect([t.begin, t.end]).toEqual([6, 9]);
  }
  expect(spanOf(raw, seeded.gloss)?.value).toBe('CAT');
  expect(seeded.forms.map((id) => spanOf(raw, id)?.value)).toEqual(['ka', 't']);
  const links = layersOf(raw)
    .flatMap((l) => l.vocabs || [])
    .flatMap((v) => v.vocabLinks || []);
  expect(links.find((l) => l.id === seeded.wordLink)?.tokens).toEqual([seeded.kat]);
  expect(links.find((l) => l.id === seeded.mweLink)?.tokens).toEqual([seeded.kat, seeded.gamma]);
  const comment = await c.comments.get(seeded.comment);
  expect(comment.entityId).toBe(seeded.kat);

  // One History entry for it.
  const entries = await c.documents.audit(documentId);
  expect(entries.filter((e) => e.message === 'Respell kat → cat')).toHaveLength(1);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByText('Respell kat → cat', { exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.keyboard.press('Escape');

  // Baseline shows the new text.
  await page.goto(documentPath('baseline'));
  await expect(page.getByText(RESPELLED).first()).toBeVisible({ timeout: 20_000 });
});

test('nothing typed and a space are refused in the box, which Escape closes', async ({ page }) => {
  await openAnalyze(page);
  // From the word's popover this time.
  await page.locator(`[data-pop-opener="vocab:${seeded.gamma}"]`).click();
  await page
    .locator('.igt-vocab-pop')
    .getByRole('button', { name: 'Respell', exact: true })
    .click();
  const box = respellBox(page);
  await expect(box).toBeFocused();
  await expect(box).toHaveValue('gamma');
  await box.fill('gam ma');
  await box.press('Enter');
  await expect(page.locator('.igt-respell__note')).toContainText('Use Tokenize to split a word');
  await box.fill('');
  await box.press('Enter');
  await expect(page.locator('.igt-respell__note')).toContainText('at least one character');
  await box.press('Escape');
  await expect(box).toHaveCount(0);
  // A plain click on a word never opens it.
  await page.locator(`[data-word-col="${seeded.gamma}"] .igt-token-form .igt-vocab__face`).click();
  await expect(box).toHaveCount(0);
  await page.waitForTimeout(500);
  const raw = await client().documents.get(documentId, true);
  expect(raw.textLayers[0].text.body).toBe(RESPELLED);
});

test('a past state of the document offers no respell', async ({ page }) => {
  await openAnalyze(page);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  // A grouped entry reads its count beside its label.
  await page
    .getByText(/Seed the analysis/)
    .first()
    .click();
  await expect(page.getByText('Historical state')).toBeVisible({ timeout: 15_000 });
  // The past state has the old spelling: find kat's column by its id.
  const cell = cellOf(page, seeded.kat);
  await expect(cell).toBeVisible({ timeout: 15_000 });
  await cell.focus();
  await cell.press('F2');
  await expect(respellBox(page)).toHaveCount(0);
});
