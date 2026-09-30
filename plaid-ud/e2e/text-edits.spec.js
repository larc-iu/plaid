// The Text Editor saves the edits typed in the box, where they were typed,
// against the body they were typed on (PATCH /texts/:id with `edits` and
// `base`). A space typed inside a word cuts it, and the word's token goes
// with one half. Backspace over a space joins two words, and both tokens stay.
// Two tabs saving different passages both land, and a tab that changed the
// passage another tab saved first is refused with its text kept. After each
// save, what the screen shows is what a reload shows.
// Each test seeds its own throwaway project, deleted afterwards.
import { test, expect, seedAuth } from './fixtures.js';
import { seedUdDoc } from './seedUdDoc.js';
import { getUdLayerInfo } from '../src/utils/udLayerUtils.js';

const seeded = [];

test.afterAll(async () => {
  for (const S of seeded) {
    await S.client.projects
      .delete(S.projectId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

// A document holding `body`, one sentence, a word and a morpheme per range.
async function seed(name, body, words) {
  const S = await seedUdDoc(`Text edits ${name} ${Date.now()}`, body, words);
  seeded.push(S);
  return S;
}

// The stored body and the word tokens, as `[id, begin, end]` in text order.
async function stored(S) {
  const info = getUdLayerInfo(await S.client.documents.get(S.documentId, true));
  const words = (info.wordTokenLayer.tokens || [])
    .map((t) => [t.id, t.begin, t.end])
    .sort((a, b) => a[1] - b[1]);
  const morphemes = (info.morphemeTokenLayer.tokens || [])
    .map((t) => [t.id, t.begin, t.end])
    .sort((a, b) => a[1] - b[1]);
  return { body: info.textLayer.text.body, words, morphemes };
}

const boxOf = (page) => page.getByPlaceholder('Type or paste the text. One sentence per line.');

async function openEditor(page, S, body) {
  await seedAuth(page);
  await page.goto(`/#/projects/${S.projectId}/documents/${S.documentId}/edit`);
  await expect(boxOf(page)).toHaveValue(body, { timeout: 15000 });
  await page.waitForLoadState('networkidle');
}

async function openTab(browser, S, body) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await openEditor(page, S, body);
  return { ctx, page };
}

// Put the caret at code unit `at` (the seeds are ASCII) and select `length`
// characters after it.
async function caretAt(page, at, length = 0) {
  const box = boxOf(page);
  await box.focus();
  await box.evaluate((el, [s, e]) => el.setSelectionRange(s, e), [at, at + length]);
}

async function save(page) {
  await page.getByRole('button', { name: 'Save', exact: true }).click();
}

async function saved(page) {
  await expect(page.getByText(/^Saved: /)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('Saving…')).toHaveCount(0);
}

// What the tab shows: the box's text, and each sentence's word badges.
async function screenOf(page) {
  await expect(page.locator('[data-sentence-block]').first()).toBeVisible({ timeout: 15000 });
  return {
    text: await boxOf(page).inputValue(),
    sentences: await page
      .locator('[data-sentence-block]')
      .evaluateAll((blocks) =>
        blocks.map((b) => [...b.querySelectorAll('[data-sentence]')].map((w) => w.textContent)),
      ),
  };
}

// After a save, the screen equals what a reload of the document shows, and
// the box holds the stored body.
async function expectScreenIsStored(page, S) {
  const before = await screenOf(page);
  await page.reload();
  await expect(boxOf(page)).toHaveValue(before.text, { timeout: 15000 });
  expect(await screenOf(page)).toEqual(before);
  expect(before.text).toBe((await stored(S)).body);
  return before;
}

test('a space typed inside a word keeps its token on one half', async ({ page }) => {
  const body = 'the doghouse runs';
  const S = await seed('split', body, [
    [0, 3],
    [4, 12],
    [13, 17],
  ]);
  const [, [wordId]] = (await stored(S)).words;
  await openEditor(page, S, body);

  await caretAt(page, 7);
  await page.keyboard.type(' ');
  await expect(boxOf(page)).toHaveValue('the dog house runs');
  await save(page);
  await saved(page);

  await expect.poll(async () => (await stored(S)).body).toBe('the dog house runs');
  const { words, morphemes } = await stored(S);
  const word = words.find(([id]) => id === wordId);
  // The word is on "dog" or on "house", and the other half has no token.
  expect([
    [4, 7],
    [8, 13],
  ]).toContainEqual(word.slice(1));
  expect(words.map((w) => w.slice(1))).toEqual([[0, 3], word.slice(1), [14, 18]]);
  expect(morphemes.map((m) => m.slice(1))).toEqual([[0, 3], word.slice(1), [14, 18]]);

  const shown = await expectScreenIsStored(page, S);
  expect(shown.text).toBe('the dog house runs');
  expect(shown.sentences.flat()).toHaveLength(3);
});

test('Backspace over a space keeps both words', async ({ page }) => {
  const body = 'the dog runs';
  const S = await seed('join', body, [
    [0, 3],
    [4, 7],
    [8, 12],
  ]);
  const before = (await stored(S)).words;
  await openEditor(page, S, body);

  await caretAt(page, 8);
  await page.keyboard.press('Backspace');
  await expect(boxOf(page)).toHaveValue('the dogruns');
  await save(page);
  await saved(page);

  await expect.poll(async () => (await stored(S)).body).toBe('the dogruns');
  const { words } = await stored(S);
  expect(words).toEqual([
    [before[0][0], 0, 3],
    [before[1][0], 4, 7],
    [before[2][0], 7, 11],
  ]);

  const shown = await expectScreenIsStored(page, S);
  expect(shown.sentences).toEqual([['the', 'dog', 'runs']]);
});

test('two tabs editing different passages both land', async ({ browser }) => {
  const body = 'the dog runs. the cat sleeps.';
  const S = await seed('apart', body, [
    [0, 3],
    [4, 7],
    [8, 12],
    [12, 13],
    [14, 17],
    [18, 21],
    [22, 28],
    [28, 29],
  ]);
  const A = await openTab(browser, S, body);
  const B = await openTab(browser, S, body);
  try {
    // A types in the first sentence and saves.
    await caretAt(A.page, 7);
    await A.page.keyboard.type(' now');
    await save(A.page);
    await saved(A.page);
    await expect.poll(async () => (await stored(S)).body).toBe('the dog now runs. the cat sleeps.');

    // B, on the copy it read before A's save, types in the second sentence.
    await caretAt(B.page, 21);
    await B.page.keyboard.type(' soon');
    await expect(boxOf(B.page)).toHaveValue('the dog runs. the cat soon sleeps.');
    await save(B.page);
    await saved(B.page);

    const both = 'the dog now runs. the cat soon sleeps.';
    await expect.poll(async () => (await stored(S)).body).toBe(both);
    await expect(boxOf(B.page)).toHaveValue(both);
    await expect(B.page.getByText('Changed elsewhere in the same passage.')).toHaveCount(0);

    const shown = await expectScreenIsStored(B.page, S);
    expect(shown.text).toBe(both);
    expect(shown.sentences.flat()).toEqual([
      'the',
      'dog',
      'runs',
      '.',
      'the',
      'cat',
      'sleeps',
      '.',
    ]);
  } finally {
    await A.ctx.close();
    await B.ctx.close();
  }
});

test('a tab that changed the passage another tab saved first is refused, its text kept', async ({
  browser,
}) => {
  const body = 'the dog runs';
  const S = await seed('same', body, [
    [0, 3],
    [4, 7],
    [8, 12],
  ]);
  const A = await openTab(browser, S, body);
  const B = await openTab(browser, S, body);
  try {
    await caretAt(A.page, 4, 3);
    await A.page.keyboard.type('cat');
    await save(A.page);
    await saved(A.page);
    await expect.poll(async () => (await stored(S)).body).toBe('the cat runs');
    await expectScreenIsStored(A.page, S);

    await caretAt(B.page, 4, 3);
    await B.page.keyboard.type('cow');
    await save(B.page);

    await expect(B.page.getByText('Changed elsewhere in the same passage.')).toBeVisible({
      timeout: 15000,
    });
    await expect(boxOf(B.page)).toHaveValue('the cow runs');
    await expect(B.page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    // Nothing of B's reached the server.
    await B.page.waitForTimeout(800);
    expect((await stored(S)).body).toBe('the cat runs');

    // Discard shows what is stored, and that is what a reload shows.
    await B.page.getByRole('button', { name: 'Discard changes' }).click();
    await expect(boxOf(B.page)).toHaveValue('the cat runs');
    await expectScreenIsStored(B.page, S);
  } finally {
    await A.ctx.close();
    await B.ctx.close();
  }
});
