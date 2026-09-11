// Item 7's review parity: the two provenance marks, and the keyboard gestures
// that sweep a document of them.
//
//  - machine material renders violet, a contributor's renders amber, and
//    anything confirmed renders plain;
//  - Ctrl/Cmd+Enter accepts a word and moves on (accept-predictions.spec.js);
//  - Ctrl/Cmd+Backspace discards the machine's work on a word and moves on;
//  - Ctrl/Cmd+Shift+Down / Up jumps between words that still need a look;
//  - the sentence's own Accept and Discard buttons do the whole sentence;
//  - the `?` legend names all of it, and shows the amber row only in a project
//    that actually reviews somebody.
import { test, expect, seedAuth } from './fixtures.js';
import { seedUdDoc } from './seedUdDoc.js';

const BODY = 'the dog runs fast';
const WORDS = [
  [0, 3],
  [4, 7],
  [8, 12],
  [13, 17],
];

const MACHINE = { prov: 'inferred', provSource: 'service:test' };
const CONTRIBUTED_BY = (userId) => ({ prov: 'contributed', provSource: `user:${userId}` });

const S = {};

test.beforeAll(async () => {
  Object.assign(S, await seedUdDoc(`Review gestures ${Date.now()}`, BODY, WORDS));
  const { client, layers, morphIds } = S;

  // Every word gets a lemma, so every word has a tree node.
  S.lemmaIds = [];
  for (const [i, word] of ['the', 'dog', 'run', 'fast'].entries()) {
    S.lemmaIds.push((await client.spans.create(layers.lemma, [morphIds[i]], word)).id);
  }

  // the  -> machine UPOS (violet, reviewable, discardable)
  S.theUpos = (await client.spans.create(layers.upos, [morphIds[0]], 'DET', { ...MACHINE })).id;
  // dog  -> a contributor's UPOS (amber, reviewable, NOT discardable)
  S.dogUpos = (
    await client.spans.create(layers.upos, [morphIds[1]], 'NOUN', CONTRIBUTED_BY('someone@x.com'))
  ).id;
  // runs -> a confirmed machine UPOS (plain, settled)
  S.runsUpos = (
    await client.spans.create(layers.upos, [morphIds[2]], 'VERB', {
      ...MACHINE,
      provConfirmed: true,
    })
  ).id;
  // fast -> a machine UPOS, so the sweep has somewhere to go past "dog"
  S.fastUpos = (await client.spans.create(layers.upos, [morphIds[3]], 'ADV', { ...MACHINE })).id;
});

test.afterAll(async () => {
  if (S.client && S.projectId) {
    await S.client.projects
      .delete(S.projectId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

// Restore the seeded provenance, since most of these tests change it.
test.beforeEach(async () => {
  const { client } = S;
  await client.spans
    .delete(S.theUpos)
    .catch(() => {}) // discarded by a previous test
    .then(async () => {
      S.theUpos = (
        await client.spans.create(S.layers.upos, [S.morphIds[0]], 'DET', { ...MACHINE })
      ).id;
    });
  await client.spans.patchMetadata(S.dogUpos, {
    ...CONTRIBUTED_BY('someone@x.com'),
    provConfirmed: null,
  });
  await client.spans
    .delete(S.fastUpos)
    .catch(() => {})
    .then(async () => {
      S.fastUpos = (
        await client.spans.create(S.layers.upos, [S.morphIds[3]], 'ADV', { ...MACHINE })
      ).id;
    });
});

async function openAnnotate(page) {
  await seedAuth(page);
  await page.addInitScript(() => {
    localStorage.setItem(
      'ud-annotation-visible-fields',
      JSON.stringify({ lemma: true, xpos: true, upos: true, feats: true }),
    );
  });
  await page.goto(`/#/projects/${S.projectId}/documents/${S.documentId}/annotate`);
  await expect(page.locator('.token-form', { hasText: 'dog' }).first()).toBeVisible({
    timeout: 15000,
  });
}

const cell = (page, i, field) => page.locator(`[id="${S.morphIds[i]}-${field}"]`);
const activeId = (page) => page.evaluate(() => document.activeElement?.id);

test('machine material is violet, a contributor’s is amber, confirmed is plain', async ({
  page,
}) => {
  await openAnnotate(page);

  await expect(page.locator('.editable-field--machine')).toHaveCount(2); // the, fast
  await expect(page.locator('.editable-field--contributed')).toHaveCount(1); // dog

  // The hues are the ones plaid-igt uses, so a shared project reads alike.
  const colorOf = (loc) => loc.evaluate((el) => getComputedStyle(el).color);
  await expect.poll(() => colorOf(cell(page, 0, 'upos'))).toBe('rgb(109, 40, 217)');
  await expect.poll(() => colorOf(cell(page, 1, 'upos'))).toBe('rgb(180, 83, 9)');

  // "runs" was machine-made and confirmed, so it renders like anyone's work.
  await expect(cell(page, 2, 'upos')).not.toHaveClass(/editable-field--(machine|contributed)/);
});

test('Ctrl+Backspace discards the machine proposal and moves on', async ({ page }) => {
  await openAnnotate(page);
  await cell(page, 0, 'lemma').focus();

  await page.keyboard.press('Control+Backspace');

  // "the"'s machine UPOS is gone, "fast"'s remains.
  await expect(page.locator('.editable-field--machine')).toHaveCount(1, { timeout: 8000 });
  await expect(cell(page, 0, 'upos')).toHaveValue('');
  // And the caret moved to the next word, as accepting does, onto the cell
  // that needs a look there, which on "dog" is its contributed UPOS.
  await expect.poll(() => activeId(page), { timeout: 8000 }).toBe(`${S.morphIds[1]}-upos`);
});

test('Ctrl+Backspace leaves a contributor’s work alone', async ({ page }) => {
  await openAnnotate(page);
  await cell(page, 1, 'lemma').focus();

  await page.keyboard.press('Control+Backspace');

  // Nothing to discard on this word, so nothing happens and the caret holds.
  await page.waitForTimeout(600);
  expect(await activeId(page)).toBe(`${S.morphIds[1]}-lemma`);
  await expect(page.locator('.editable-field--contributed')).toHaveCount(1);
  await expect(cell(page, 1, 'upos')).toHaveValue('NOUN');
});

test('Ctrl+Backspace over a half-typed cell is the browser’s, not ours', async ({ page }) => {
  await openAnnotate(page);
  const lemma = cell(page, 0, 'lemma');
  await lemma.click();
  await lemma.fill('typed');

  await page.keyboard.press('Control+Backspace');

  // The gesture declined the chord, so the machine UPOS survives and the caret
  // never left. What the browser did to the text is its business.
  await page.waitForTimeout(400);
  expect(await activeId(page)).toBe(`${S.morphIds[0]}-lemma`);
  await expect(page.locator('.editable-field--machine')).toHaveCount(2);
});

test('Ctrl+Shift+Down and Up sweep the words that need a look', async ({ page }) => {
  await openAnnotate(page);
  // Wait for the marks themselves, not just the tokens: the sweep reads the
  // document's spans, and pressing the chord before they have arrived asks the
  // question of an empty document.
  await expect(page.locator('.editable-field--machine')).toHaveCount(2);
  await expect(page.locator('.editable-field--contributed')).toHaveCount(1);
  await cell(page, 0, 'lemma').focus();

  // the -> dog (amber counts: a verifier reviews contributed work too)
  await page.keyboard.press('Control+Shift+ArrowDown');
  await expect.poll(() => activeId(page), { timeout: 8000 }).toBe(`${S.morphIds[1]}-upos`);

  // dog -> fast, skipping "runs", which is settled
  await page.keyboard.press('Control+Shift+ArrowDown');
  await expect.poll(() => activeId(page), { timeout: 8000 }).toBe(`${S.morphIds[3]}-upos`);

  // Nothing past it, so the caret holds rather than wrapping.
  await page.keyboard.press('Control+Shift+ArrowDown');
  await page.waitForTimeout(400);
  expect(await activeId(page)).toBe(`${S.morphIds[3]}-upos`);

  // And back.
  await page.keyboard.press('Control+Shift+ArrowUp');
  await expect.poll(() => activeId(page), { timeout: 8000 }).toBe(`${S.morphIds[1]}-upos`);
});

test('the sweep lands on the cell that earned the stop', async ({ page }) => {
  await openAnnotate(page);
  // Start in a LEMMA cell; every stop here was earned by a UPOS.
  await expect(page.locator('.editable-field--contributed')).toHaveCount(1);
  await cell(page, 0, 'lemma').focus();
  await page.keyboard.press('Control+Shift+ArrowDown');
  await expect.poll(() => activeId(page), { timeout: 8000 }).toBe(`${S.morphIds[1]}-upos`);
});

test('the sentence buttons accept and discard the whole sentence', async ({ page }) => {
  await openAnnotate(page);
  await expect(page.locator('.accept-predictions-btn')).toBeVisible();
  await expect(page.locator('.discard-predictions-btn')).toBeVisible();

  // Discard first: it takes the two machine spans and spares the contributed one.
  await page.locator('.discard-predictions-btn').click();
  await expect(page.locator('.editable-field--machine')).toHaveCount(0, { timeout: 8000 });
  await expect(page.locator('.editable-field--contributed')).toHaveCount(1);
  // Nothing machine-made left, so the button that does it retires.
  await expect(page.locator('.discard-predictions-btn')).toHaveCount(0);

  // Accept clears the last mark, and then there is nothing to review at all.
  await page.locator('.accept-predictions-btn').click();
  await expect(page.locator('.editable-field--contributed')).toHaveCount(0, { timeout: 8000 });
  await expect(page.locator('.accept-predictions-btn')).toHaveCount(0);
});

test('the legend names the gestures, and shows amber only where work is reviewed', async ({
  page,
}) => {
  await openAnnotate(page);
  const legend = page.locator('details', { hasText: 'Gestures and marks' });
  await expect(legend).toBeVisible();
  // Closed until asked for: the tip line it replaced was always on screen.
  await expect(legend.getByText('accepts a word and moves to the next')).toBeHidden();

  await legend.locator('summary').click();
  await expect(legend.getByText('accepts a word and moves to the next')).toBeVisible();
  await expect(legend.getByText('machine-made')).toBeVisible();
  // This project reviews nobody, so there is no such thing as contributed work
  // in it and the row would be about a feature it does not have.
  await expect(legend.getByText('contributed')).toHaveCount(0);

  // Name somebody, and the row appears.
  await S.client.projects.setConfig(S.projectId, 'plaid', 'review', {
    users: ['someone@x.com'],
  });
  await page.reload();
  await expect(page.locator('.token-form', { hasText: 'dog' }).first()).toBeVisible({
    timeout: 15000,
  });
  await page.locator('details', { hasText: 'Gestures and marks' }).locator('summary').click();
  await expect(page.getByText('contributed', { exact: true })).toBeVisible();

  await S.client.projects.setConfig(S.projectId, 'plaid', 'review', { users: [] });
});
