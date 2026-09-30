import PlaidClient, {
  ROLES,
  PLAIN_EDITS_KEY,
  PLAID_NAMESPACE,
  cpLength,
} from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';

// The Baseline tab saves the edits typed in the box as edits at the caret
// (texts.edit with the digest of the body they were typed over), so each one
// stands where it was typed. igt's word, morpheme and alignment layers take an
// edit plainly (Luke, 2026-09-30): a space typed inside a word leaves one word
// holding the space with its morphemes and glosses, letters typed at a word's
// end join it, and Backspace over a space keeps both words. Two tabs editing
// different passages both land, and the same passage is refused for the
// second with its draft kept. After each save the screen shows what a reload
// shows. Throwaway documents in "E2E IGT Fixture".

const CORE = 'http://localhost:8085';
const roleOf = (l) => l?.config?.plaid?.role;

let client;
let projectId;
let textLayer;
const documents = [];

const layer = (role) => textLayer.tokenLayers.find((l) => roleOf(l) === role);

test.beforeAll(async () => {
  client = new PlaidClient(CORE, readToken().token);
  const project = (await client.projects.list()).find((p) => p.name === 'E2E IGT Fixture');
  if (!project) throw new Error('run node e2e/fixtureProject.js first');
  projectId = project.id;
  const full = await client.projects.get(projectId);
  textLayer = full.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  // what a maintainer's open back-fills, set here so the test does not race it
  for (const role of [ROLES.WORD, ROLES.MORPHEME, ROLES.TIME_ALIGNMENT]) {
    if (layer(role)) {
      await client.tokenLayers.setConfig(layer(role).id, PLAID_NAMESPACE, PLAIN_EDITS_KEY, true);
    }
  }
});

test.afterAll(async () => {
  for (const id of documents) await client.documents.delete(id).catch(() => {});
});

// A document holding `body`: one sentence, a word per run without spaces, and
// its morphemes as igt stores them, each over the whole word in order, with
// its form: those `cuts` makes (word index to the code points each cut stands
// after), one per word otherwise. Each morpheme is glossed with its form in
// capitals.
async function makeDocument(body, cuts = {}) {
  const { id } = await client.documents.create(projectId, `baseline edits ${Date.now()}`);
  documents.push(id);
  const text = await client.texts.create(textLayer.id, id, body);
  const words = [...body.matchAll(/\S+/g)].map((m) => ({
    begin: m.index,
    end: m.index + m[0].length,
  }));
  await client.tokens.bulkCreate([
    { tokenLayerId: layer(ROLES.SENTENCE).id, text: text.id, begin: 0, end: cpLength(body) },
  ]);
  await client.tokens.bulkCreate(
    words.map((w) => ({ tokenLayerId: layer(ROLES.WORD).id, text: text.id, ...w })),
  );
  const morphs = words.flatMap((w, i) => {
    const edges = [0, ...(cuts[i] || []), w.end - w.begin];
    const cps = [...body.slice(w.begin, w.end)];
    return edges.slice(1).map((e, j) => ({
      ...w,
      precedence: j + 1,
      form: cps.slice(edges[j], e).join(''),
    }));
  });
  const { ids } = await client.tokens.bulkCreate(
    morphs.map((m) => ({
      tokenLayerId: layer(ROLES.MORPHEME).id,
      text: text.id,
      begin: m.begin,
      end: m.end,
      precedence: m.precedence,
      metadata: { form: m.form },
    })),
  );
  const gloss = layer(ROLES.MORPHEME).spanLayers.find((s) => s.name === 'Gloss');
  await client.spans.bulkCreate(
    ids.map((mid, i) => ({
      spanLayerId: gloss.id,
      tokens: [mid],
      value: morphs[i].form.toUpperCase(),
    })),
  );
  return id;
}

// What the server holds: the body, each word's text, and each morpheme's form
// with its gloss.
async function stored(documentId) {
  const raw = await client.documents.get(documentId, true);
  const tl = raw.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const body = tl.text.body;
  const cps = [...body];
  const read = (t) => cps.slice(t.begin, t.end).join('');
  const of = (role) => tl.tokenLayers.find((l) => roleOf(l) === role);
  const gloss = of(ROLES.MORPHEME).spanLayers.find((s) => s.name === 'Gloss');
  return {
    body,
    words: of(ROLES.WORD).tokens.map(read).sort(),
    morphemes: of(ROLES.MORPHEME)
      .tokens.map(
        (m) =>
          `${m.metadata?.form ?? read(m)}:${gloss.spans.find((s) => s.tokens[0] === m.id)?.value ?? ''}`,
      )
      .sort(),
  };
}

async function openBaseline(page, documentId) {
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=baseline`);
  await page.getByRole('button', { name: 'Edit text' }).waitFor();
  await page.waitForLoadState('networkidle');
}

const box = (page) => page.getByPlaceholder('Type or paste the text');

// Put the caret at code point `at` of the box, as a click there would.
async function caretAt(page, at) {
  await box(page).click();
  await box(page).evaluate((el, cp) => {
    const u = [...el.value].slice(0, cp).join('').length;
    el.setSelectionRange(u, u);
  }, at);
}

async function save(page) {
  await page.getByRole('button', { name: 'Save changes' }).click();
  const confirm = page.getByRole('alertdialog');
  if (await confirm.isVisible().catch(() => false)) {
    await confirm.getByRole('button', { name: 'Save anyway' }).click();
  }
}

// After a save: the tab shows the stored body, and so does a reload.
async function showsStored(page, documentId) {
  await expect(page.getByRole('button', { name: 'Edit text' })).toBeVisible({ timeout: 10_000 });
  const { body } = await stored(documentId);
  await expect(page.locator('p.whitespace-pre-wrap')).toHaveText(body);
  await page.reload();
  await page.getByRole('button', { name: 'Edit text' }).waitFor();
  await expect(page.locator('p.whitespace-pre-wrap')).toHaveText(body);
}

test('a space typed in a glossed word of one morpheme keeps the word, the morpheme and its gloss', async ({
  page,
}) => {
  const doc = await makeDocument('uno pumpkin tres');
  await openBaseline(page, doc);
  await page.getByRole('button', { name: 'Edit text' }).click();
  await caretAt(page, 7);
  await page.keyboard.type(' ');
  await save(page);
  await expect.poll(async () => (await stored(doc)).body).toBe('uno pum pkin tres');
  const s = await stored(doc);
  expect(s.words).toEqual(['pum pkin', 'tres', 'uno']);
  expect(s.morphemes).toEqual(['pumpkin:PUMPKIN', 'tres:TRES', 'uno:UNO']);
  await showsStored(page, doc);
});

test('a space typed in a glossed word of two morphemes keeps both and their glosses', async ({
  page,
}) => {
  const doc = await makeDocument('hh pqmrs', { 1: [2] });
  await openBaseline(page, doc);
  await page.getByRole('button', { name: 'Edit text' }).click();
  await caretAt(page, 5);
  await page.keyboard.type(' ');
  await save(page);
  await expect.poll(async () => (await stored(doc)).body).toBe('hh pq mrs');
  const s = await stored(doc);
  expect(s.words).toEqual(['hh', 'pq mrs']);
  expect(s.morphemes).toEqual(['hh:HH', 'mrs:MRS', 'pq:PQ']);
  await showsStored(page, doc);
});

test('letters typed at the end of a word join it, and a word typed after a space does not', async ({
  page,
}) => {
  const doc = await makeDocument('uno dos tres');
  await openBaseline(page, doc);
  await page.getByRole('button', { name: 'Edit text' }).click();
  await caretAt(page, 3);
  await page.keyboard.type('s');
  await caretAt(page, 13);
  await page.keyboard.type(' cuatro');
  await save(page);
  await expect.poll(async () => (await stored(doc)).body).toBe('unos dos tres cuatro');
  const s = await stored(doc);
  expect(s.words).toContain('unos');
  expect(s.words).not.toContain('tres cuatro');
  expect(s.morphemes).toEqual(expect.arrayContaining(['dos:DOS', 'tres:TRES', 'uno:UNO']));
  await showsStored(page, doc);
});

test('Backspace over the space between two words keeps both words', async ({ page }) => {
  const doc = await makeDocument('uno dos tres');
  await openBaseline(page, doc);
  await page.getByRole('button', { name: 'Edit text' }).click();
  await caretAt(page, 4);
  await page.keyboard.press('Backspace');
  await save(page);
  await expect.poll(async () => (await stored(doc)).body).toBe('unodos tres');
  const s = await stored(doc);
  expect(s.words).toEqual(['dos', 'tres', 'uno']);
  expect(s.morphemes).toEqual(['dos:DOS', 'tres:TRES', 'uno:UNO']);
  await showsStored(page, doc);
});

test('two tabs editing different passages both land', async ({ browser }) => {
  const doc = await makeDocument('uno dos tres');
  const A = await (await browser.newContext()).newPage();
  const B = await (await browser.newContext()).newPage();
  await openBaseline(A, doc);
  await openBaseline(B, doc);
  await A.getByRole('button', { name: 'Edit text' }).click();
  await B.getByRole('button', { name: 'Edit text' }).click();
  await caretAt(A, 12);
  await A.keyboard.type(' cuatro');
  await caretAt(B, 0);
  await B.keyboard.type('la ');
  await save(A);
  await expect.poll(async () => (await stored(doc)).body).toBe('uno dos tres cuatro');
  await showsStored(A, doc);
  await save(B);
  await expect.poll(async () => (await stored(doc)).body).toBe('la uno dos tres cuatro');
  const s = await stored(doc);
  expect(s.morphemes).toEqual(['dos:DOS', 'tres:TRES', 'uno:UNO']);
  await showsStored(B, doc);
  await A.context().close();
  await B.context().close();
});

test('two tabs editing the same passage: the second is refused and keeps its draft', async ({
  browser,
}) => {
  const doc = await makeDocument('uno dos tres');
  const A = await (await browser.newContext()).newPage();
  const B = await (await browser.newContext()).newPage();
  await openBaseline(A, doc);
  await openBaseline(B, doc);
  await A.getByRole('button', { name: 'Edit text' }).click();
  await B.getByRole('button', { name: 'Edit text' }).click();
  await caretAt(A, 7);
  await A.keyboard.press('Backspace');
  await A.keyboard.type('z');
  await caretAt(B, 7);
  await B.keyboard.press('Backspace');
  await B.keyboard.type('x');
  await save(A);
  await expect.poll(async () => (await stored(doc)).body).toBe('uno doz tres');
  await save(B);
  await expect(
    B.getByText('The same passage was changed elsewhere.', { exact: false }),
  ).toBeVisible();
  await expect(box(B)).toHaveValue('uno dox tres');
  expect((await stored(doc)).body).toBe('uno doz tres');
  await A.context().close();
  await B.context().close();
});
