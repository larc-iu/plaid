import PlaidClient, { ROLES } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';

// TEST_PLAN surrounding-workflow rows driven end to end on one throwaway
// document: Baseline save (C3-01 append without a confirm, C3-02 destructive
// edit with the confirm modal), the built-in tokenizer (C4-01), the Auto-analyze
// dialog (B15-01/02/03), Copy as IGT (C5-09), and rename/delete from the
// Metadata tab (C2-02). Lives in "E2E IGT Fixture"; the document is deleted by
// the last test (and again in afterAll, harmlessly).

const CORE = 'http://localhost:8085';
const roleOf = (l) => l?.config?.plaid?.role;
const STAMP = Date.now();
const FORMS = [`zork${STAMP}`, `blip${STAMP}`, `quux${STAMP}`];
const BODY = `${FORMS[0]} ${FORMS[1]}, ${FORMS[2]}. Adiós!`;

let client;
let projectId;
let documentId;
let glossLayerId;
let items = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  client = new PlaidClient(CORE, readToken().token);
  const project = (await client.projects.list()).find((p) => p.name === 'E2E IGT Fixture');
  if (!project) throw new Error('run node e2e/fixture.js first');
  projectId = project.id;
  const full = await client.projects.get(projectId);
  const textLayer = full.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  glossLayerId = textLayer.tokenLayers
    .find((l) => roleOf(l) === ROLES.MORPHEME)
    .spanLayers.find((s) => s.name === 'Gloss').id;
  const vocab = full.vocabs.find((v) => v.name === 'IGT Lexicon');
  for (const f of FORMS) items.push((await client.vocabItems.create(vocab.id, f)).id);
  const created = await client.documents.create(projectId, `workflow ${STAMP}`);
  documentId = created.id;
});

test.afterAll(async () => {
  if (documentId) await client.documents.delete(documentId).catch(() => {});
  for (const id of items) await client.vocabItems.delete(id).catch(() => {});
});

async function openTab(page, tab) {
  if (page.url() !== 'about:blank') await page.goto('about:blank');
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=${tab}`);
  await page.waitForLoadState('networkidle');
}
const rawDoc = () => client.documents.get(documentId, true);
const layerOf = async (role) =>
  (await rawDoc()).textLayers[0].tokenLayers.find((l) => roleOf(l) === role);
const wordContents = async () => {
  const r = await rawDoc();
  const body = [...r.textLayers[0].text.body];
  return (await layerOf(ROLES.WORD)).tokens
    .sort((a, b) => a.begin - b.begin)
    .map((t) => body.slice(t.begin, t.end).join(''));
};

test('C3 first save creates the sentence partition; C4-01 the built-in tokenizer separates punctuation', async ({
  page,
}) => {
  await openTab(page, 'baseline');
  // An empty document opens straight into the editor; one with text waits
  // behind Edit Text.
  await page.locator('textarea#baseline-text, button:has-text("Edit Text")').first().waitFor();
  const editButton = page.getByRole('button', { name: 'Edit Text' });
  if (await editButton.isVisible()) await editButton.click();
  await page.getByPlaceholder('Type or paste the text').fill(BODY);
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await page.waitForLoadState('networkidle');
  await expect.poll(async () => (await layerOf(ROLES.SENTENCE)).tokens.length).toBe(1);
  await openTab(page, 'tokenize');
  await page.getByRole('button', { name: 'Tokenize' }).click();
  await expect
    .poll(async () => (await wordContents()).length, { timeout: 15_000 })
    .toBeGreaterThan(3);
  const words = await wordContents();
  // Punctuation is left OUT of the word tokens (it stays baseline-only text).
  expect(words).toEqual([FORMS[0], FORMS[1], FORMS[2], 'Adiós']);
  await openTab(page, 'analyze');
  await expect(page.locator('[title=",: not part of any word"]')).toHaveCount(1);
});

test('B15-01/02/03: the Auto-analyze dialog cancels cleanly and links on Run', async ({ page }) => {
  await openTab(page, 'analyze');
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  const openDialog = async () => {
    await page.getByRole('button', { name: /Auto-analyze/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Auto-analyze');
    return dialog;
  };
  let dialog = await openDialog();
  // Four step toggles (translations, copy previous analyses, propose
  // segmentation and glosses, link to the lexicon); the linking method select
  // shows for the last one. The fixture project has a lexicon and no
  // translation or analysis service online, so those steps are disabled.
  await expect(dialog.getByRole('checkbox')).toHaveCount(4);
  await expect(dialog.getByRole('combobox')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  dialog = await openDialog();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.locator('button.igt-vocab__hint').count()).toBe(0);
  dialog = await openDialog();
  await dialog.getByRole('button', { name: 'Run' }).click();
  const toasts = [];
  page.on('console', () => {});
  const seenToasts = new Set();
  const poll = setInterval(async () => {
    try {
      for (const t of await page.locator('[data-sonner-toast]').allInnerTexts())
        seenToasts.add(t.replace(/\s+/g, ' '));
    } catch {
      /* page gone */
    }
  }, 100);
  await expect(page.locator('button.igt-vocab__hint--machine')).toHaveCount(3, { timeout: 15_000 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.waitForTimeout(300);
  clearInterval(poll);
  toasts.push(...seenToasts);
  expect(
    toasts.some((t) => /Auto-analyze/.test(t) && /linked 3/i.test(t)),
    JSON.stringify(toasts),
  ).toBe(true);
});

test('C5-09: Copy as IGT puts the interlinear text on the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openTab(page, 'analyze');
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  const copy = page.locator('.igt-copy__btn').first();
  await copy.click();
  await expect(copy).toHaveText(/Copied/);
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain(FORMS[1]);
  expect(text).toContain('Adiós');
});

test('C3-01/02: appending needs no confirm and extends the sentence; a mid-text edit confirms and drops affected annotations', async ({
  page,
}) => {
  const morph = (await layerOf(ROLES.MORPHEME)).tokens;
  const wl = await layerOf(ROLES.WORD);
  const body = [...(await rawDoc()).textLayers[0].text.body];
  const wordAt = (form) => wl.tokens.find((t) => body.slice(t.begin, t.end).join('') === form);
  const mOf = (w) => morph.find((m) => m.begin === w.begin && m.end === w.end);
  await client.spans.create(glossLayerId, [mOf(wordAt(FORMS[0])).id], 'DET');
  await client.spans.create(glossLayerId, [mOf(wordAt(FORMS[1])).id], 'HUMAN');

  await openTab(page, 'baseline');
  await page.getByRole('button', { name: 'Edit Text' }).click();
  const ta = page.getByPlaceholder('Type or paste the text');
  await ta.fill(`${BODY} equal`);
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect
    .poll(async () => (await layerOf(ROLES.SENTENCE)).tokens[0]?.end, { timeout: 10_000 })
    .toBe([...`${BODY} equal`].length);

  await page.getByRole('button', { name: 'Edit Text' }).click();
  await ta.fill(`a ${FORMS[1]}, ${FORMS[2]}. Adiós! equal`);
  await page.getByRole('button', { name: 'Save Changes' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('Save baseline changes?');
  await confirm.getByRole('button', { name: 'Save anyway' }).click();
  await page.waitForLoadState('networkidle');
  await expect
    .poll(async () => (await rawDoc()).textLayers[0].text.body)
    .toBe(`a ${FORMS[1]}, ${FORMS[2]}. Adiós! equal`);
  const spans = (await rawDoc()).textLayers[0].tokenLayers
    .find((l) => roleOf(l) === ROLES.MORPHEME)
    .spanLayers.find((s) => s.id === glossLayerId).spans;
  expect(
    spans.some((s) => s.value === 'HUMAN'),
    'gloss on an untouched word kept',
  ).toBe(true);
  expect(
    spans.some((s) => s.value === 'DET'),
    'gloss on the removed word gone',
  ).toBe(false);
});

test('C2-02: rename and delete from the Metadata tab', async ({ page }) => {
  await openTab(page, 'metadata');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const name = page.getByRole('textbox').first();
  await name.fill('Renamed workflow doc');
  await page.getByRole('button', { name: /^Save/ }).click();
  await page.waitForLoadState('networkidle');
  await expect
    .poll(async () => (await client.documents.get(documentId)).name)
    .toBe('Renamed workflow doc');
  await expect(page.getByText('Renamed workflow doc').first()).toBeVisible();
  // Delete lives in the edit toolbar.
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page
    .getByRole('button', { name: /Delete/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog').or(page.getByRole('alertdialog'));
  await expect(dialog).toContainText('Delete Document');
  await dialog.getByRole('button', { name: 'Delete Document' }).click();
  await page.waitForURL(/#\/projects\/[^/]+$/);
  const docs = await client.projects.listDocuments(projectId);
  expect(docs.some((d) => d.id === documentId)).toBe(false);
  documentId = null;
});
