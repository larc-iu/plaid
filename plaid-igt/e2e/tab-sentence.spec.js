import PlaidClient, { ROLES, cpLength } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken, CORE } from './fixtures.js';
import { getFixture, roleOf } from './fixtureProject.js';

// Switching between the Analyze and Baseline tabs keeps the sentence (R50).
// Analyze to Baseline: Baseline scrolls to the sentence the grid was on and
// lights it, nothing selected, and Edit text opens with the caret at its
// start. Baseline to Analyze: the grid opens on the page and sentence holding
// the caret. A throwaway document of 30 sentences in "E2E IGT Fixture", so the
// grid has two pages of 25.

let client;
let projectId;
let documentId;

const N = 30;
const lines = Array.from({ length: N }, (_, i) => `line${i + 1} word${i + 1}`);
const body = lines.join('\n');
// Code point offsets of each line (all ASCII here, so UTF-16 too).
const starts = lines.reduce(
  (acc, l, i) => [...acc, i ? acc[i - 1] + lines[i - 1].length + 1 : 0],
  [],
);

test.beforeAll(async () => {
  client = new PlaidClient(CORE, readToken().token);
  ({ projectId } = await getFixture());
  const full = await client.projects.get(projectId);
  const textLayer = full.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const layer = (role) => textLayer.tokenLayers.find((l) => roleOf(l) === role);
  ({ id: documentId } = await client.documents.create(projectId, `tab sentence ${Date.now()}`));
  const text = await client.texts.create(textLayer.id, documentId, body);
  await client.tokens.bulkCreate(
    lines.map((l, i) => ({
      tokenLayerId: layer(ROLES.SENTENCE).id,
      text: text.id,
      begin: starts[i],
      end: i === N - 1 ? cpLength(body) : starts[i + 1],
    })),
  );
  const words = [...body.matchAll(/\S+/g)].map((m) => ({
    begin: m.index,
    end: m.index + m[0].length,
  }));
  await client.tokens.bulkCreate(
    words.map((w) => ({ tokenLayerId: layer(ROLES.WORD).id, text: text.id, ...w })),
  );
  await client.tokens.bulkCreate(
    words.map((w) => ({
      tokenLayerId: layer(ROLES.MORPHEME).id,
      text: text.id,
      ...w,
      precedence: 1,
      metadata: { form: body.slice(w.begin, w.end) },
    })),
  );
});

test.afterAll(async () => {
  if (documentId) await client.documents.delete(documentId).catch(() => {});
});

const sentence = (page, n) =>
  page.locator('.igt-sentence[data-sentence-id]').filter({
    hasText: new RegExp(`\\bline${n}\\b`),
  });

test('Analyze and Baseline keep the sentence across the tab switch, both ways', async ({
  page,
}) => {
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=analyze`);
  await expect(page.locator('.igt-sentence[data-sentence-id]').first()).toBeVisible();
  await page.waitForLoadState('networkidle');

  // Page 2 of the grid, a cell of sentence 28 focused.
  await page.getByRole('button', { name: 'Next page' }).first().click();
  await expect(sentence(page, 28)).toBeVisible();
  await sentence(page, 28).locator('.igt-field').first().click();

  // To Baseline: sentence 28 lit and in view, nothing selected, no focus taken.
  await page.getByRole('tab', { name: 'Baseline' }).click();
  const lit = page.locator('.baseline-flash');
  await expect(lit).toHaveText(lines[27]);
  await expect(lit).toBeInViewport();
  expect(await page.evaluate(() => window.getSelection().toString())).toBe('');
  await expect(page.locator('p.whitespace-pre-wrap')).toHaveText(body);
  await expect(lit).toHaveCount(0, { timeout: 5000 });

  // Edit text opens with the caret at the sentence's start.
  await page.getByRole('button', { name: 'Edit text' }).click();
  const box = page.getByPlaceholder('Type or paste the text');
  await expect(box).toBeFocused();
  await expect
    .poll(() => box.evaluate((el) => [el.selectionStart, el.selectionEnd]))
    .toEqual([starts[27], starts[27]]);
  // The box is shorter than the text, and scrolled to the caret.
  expect(await box.evaluate((el) => el.scrollHeight > el.clientHeight && el.scrollTop > 0)).toBe(
    true,
  );

  // Back to Analyze untouched: page 2, sentence 28.
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('tab', { name: 'Analyze' }).click();
  await expect(sentence(page, 28)).toBeInViewport();
  await expect(sentence(page, 3)).toHaveCount(0);

  // The caret moved in Baseline to sentence 3: Analyze opens on page 1 there.
  await page.getByRole('tab', { name: 'Baseline' }).click();
  await page.getByRole('button', { name: 'Edit text' }).click();
  await box.evaluate((el, at) => {
    el.focus();
    el.setSelectionRange(at, at);
  }, starts[2] + 3);
  await box.press('ArrowRight');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('tab', { name: 'Analyze' }).click();
  await expect(sentence(page, 3)).toBeInViewport();
  await expect(sentence(page, 28)).toHaveCount(0);

  // A ?tab= link change within the document lands the same way.
  await sentence(page, 5).locator('.igt-field').first().click();
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=baseline`);
  await expect(page.locator('.baseline-flash')).toHaveText(lines[4]);
});

const open = async (page, tab) => {
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=${tab}`);
  if (tab === 'analyze') {
    await expect(page.locator('.igt-sentence[data-sentence-id]').first()).toBeVisible();
  }
  await page.waitForLoadState('networkidle');
};

// The line of the box's caret, and whether it shows inside the box.
const caretShown = (box) =>
  box.evaluate((el) => {
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight);
    const line = el.value.slice(0, el.selectionStart).split('\n').length - 1;
    const top = parseFloat(cs.paddingTop) + line * lh;
    return top >= el.scrollTop && top + lh <= el.scrollTop + el.clientHeight;
  });

// The line number of the sentence the grid flashed on landing, or null.
const flashed = (page) =>
  page.evaluate(
    () =>
      document.querySelector('.igt-sentence--flash')?.textContent.match(/line(\d+)/)?.[1] ?? null,
  );

test('Edit text shows the caret on the first lines of a long text', async ({ page }) => {
  await open(page, 'analyze');
  const box = page.getByPlaceholder('Type or paste the text');
  for (const n of [1, 2]) {
    await page.getByRole('tab', { name: 'Analyze' }).click();
    await sentence(page, n).locator('.igt-field').first().click();
    await page.getByRole('tab', { name: 'Baseline' }).click();
    await expect(page.locator('.baseline-flash')).toHaveText(lines[n - 1]);
    await page.getByRole('button', { name: 'Edit text' }).click();
    await expect.poll(() => box.evaluate((el) => el.selectionStart)).toBe(starts[n - 1]);
    expect(await caretShown(box)).toBe(true);
    await page.getByRole('button', { name: 'Cancel' }).click();
  }
});

// Scrolls sentence `n`'s top to `dy` px below the pinned tab strip's bottom
// (above it when negative), then presses Baseline by hand: Playwright's click
// scrolls the page first, which a reader's click does not.
async function scrollAndLeave(page, n, dy) {
  await page.evaluate(() => window.scrollBy(0, 800));
  const chrome = await page.evaluate(
    () => document.querySelector('[data-pinned]').getBoundingClientRect().bottom,
  );
  await sentence(page, n).evaluate(
    (el, to) => window.scrollBy(0, el.getBoundingClientRect().top - to),
    chrome + dy,
  );
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find(
      (t) => t.textContent.trim() === 'Baseline',
    );
    tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    tab.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    tab.click();
  });
}

test('a focused sentence scrolled away gives way to the sentence at the top of the screen', async ({
  page,
}) => {
  await open(page, 'analyze');
  await sentence(page, 2).locator('.igt-field').first().click();
  // Sentence 6 all but 30px under the strip: sentence 7 is the one on screen.
  await scrollAndLeave(page, 7, 30);
  await expect(page.locator('.baseline-flash')).toHaveText(lines[6]);
});

test('a sentence with its top 30px under the strip is still the one on screen', async ({
  page,
}) => {
  await open(page, 'analyze');
  await scrollAndLeave(page, 7, -30);
  await expect(page.locator('.baseline-flash')).toHaveText(lines[6]);
});

test('a handoff is for the next tab only', async ({ page }) => {
  // Analyze on 5, a word of 12 pressed on Tokenize, then Baseline: nothing
  // stale lands there, and Analyze after it opens with no landing.
  await open(page, 'analyze');
  await sentence(page, 5).locator('.igt-field').first().click();
  await page.getByRole('tab', { name: 'Tokenize' }).click();
  const word = page.locator(`span.token[data-begin="${starts[11]}"]`).first();
  await word.dispatchEvent('mousedown', { button: 0 });
  await page.mouse.up();
  await page.getByRole('tab', { name: 'Baseline' }).click();
  await expect(page.getByRole('button', { name: 'Edit text' })).toBeVisible();
  await expect(page.locator('.baseline-flash')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Analyze' }).click();
  await expect(sentence(page, 1)).toBeVisible();
  expect(await flashed(page)).toBe(null);

  // Tokenize straight to Analyze still lands on the word's sentence.
  await page.getByRole('tab', { name: 'Tokenize' }).click();
  await word.dispatchEvent('mousedown', { button: 0 });
  await page.mouse.up();
  await page.getByRole('tab', { name: 'Analyze' }).click();
  await expect.poll(() => flashed(page)).toBe('12');
});

test('a draft left unsaved hands Analyze the caret it last had in the saved text', async ({
  page,
}) => {
  await open(page, 'baseline');
  await page.getByRole('button', { name: 'Edit text' }).click();
  const box = page.getByPlaceholder('Type or paste the text');
  await box.evaluate((el, at) => {
    el.focus();
    el.setSelectionRange(at, at);
  }, starts[4]);
  await box.press('ArrowRight');
  await page.keyboard.type('new1\nnew2\nnew3\n');
  for (let i = 0; i < 10; i++) await box.press('ArrowDown');
  await page.getByRole('tab', { name: 'Analyze' }).click();
  await page.getByRole('button', { name: 'Leave' }).click();
  await expect.poll(() => flashed(page)).toBe('5');
});

// Last in the file: it saves, which moves every line after the third.
test('a save hands Analyze the caret the box had, in the text it saved', async ({ page }) => {
  await open(page, 'baseline');
  await page.getByRole('button', { name: 'Edit text' }).click();
  const box = page.getByPlaceholder('Type or paste the text');
  const typeAt = async (at, text) => {
    await box.evaluate((el, u) => {
      el.focus();
      el.setSelectionRange(u, u);
    }, at);
    await page.keyboard.type(text);
  };
  // A typo fixed in sentence 3, then one in sentence 25.
  await typeAt(starts[2] + 5, 'a');
  await typeAt(starts[24] + 1 + 6, 'b');
  await box.press('ArrowLeft');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('button', { name: 'Edit text' })).toBeVisible();
  await expect(page.locator('p.whitespace-pre-wrap')).toContainText('line25b');
  await page.getByRole('tab', { name: 'Analyze' }).click();
  await expect.poll(() => flashed(page)).toBe('25');
});
