// Verification for the prediction-review UX in the Annotate view:
//  - the "Accept predictions" (sentence) button is subtle by default,
//  - each word with unconfirmed machine predictions gets a ✓ that reveals on
//    hover / keyboard focus and accepts that word (teaching Ctrl+Enter),
//  - accepting clears the inferred styling.
// Seeds 'the dog runs' with a machine-inferred UPOS span on "dog".
import { createUdLayers } from './seedUdDoc.js';
import { test, expect, seedAuth, readToken } from './fixtures.js';
import { PlaidClient, metadataOps } from '@larc-iu/plaid-client';

const BASE = 'http://localhost:8085';
const S = {};

test.beforeAll(async () => {
  const { token } = readToken();
  const client = new PlaidClient(BASE, token);
  S.client = client;

  const L = await createUdLayers(client, `Accept preds ${Date.now()}`);
  S.projectId = L.projectId;
  const { textLayerId, sentenceLayerId, wordLayerId, morphemeLayerId, byKey, relationLayerId } = L;

  const body = 'the dog runs';
  const doc = await client.documents.create(S.projectId, 'Preds Doc');
  S.documentId = doc.id;
  const text = await client.texts.create(textLayerId, doc.id, body);

  const words = [
    [0, 3],
    [4, 7],
    [8, 12],
  ];
  const bMorph = await client.batched(async (b) => {
    b.tokens.bulkCreate([
      { tokenLayerId: sentenceLayerId, text: text.id, begin: 0, end: body.length },
    ]);
    b.tokens.bulkCreate(
      words.map(([begin, end]) => ({ tokenLayerId: wordLayerId, text: text.id, begin, end })),
    );
    b.tokens.bulkCreate(
      words.map(([begin, end]) => ({
        tokenLayerId: morphemeLayerId,
        text: text.id,
        begin,
        end,
        precedence: 0,
      })),
    );
  });
  const morphIds = bMorph[2].body.ids;
  S.morphIds = morphIds; // [the, dog, runs]

  const lemThe = (await client.spans.create(byKey.lemma, [morphIds[0]], 'the')).id;
  await client.spans.create(byKey.lemma, [morphIds[1]], 'dog');
  const lemRuns = (await client.spans.create(byKey.lemma, [morphIds[2]], 'run')).id;
  // A machine prediction (unconfirmed) on "dog"'s UPOS — drives the review UI.
  const upos = await client.spans.create(byKey.upos, [morphIds[1]], 'NOUN', {
    prov: 'inferred',
    provSource: 'service:test',
  });
  S.uposSpanId = upos.id;
  // An unapproved (machine) dependency relation runs(head) -> the(dependent).
  // Targets "the", not "dog", so the per-word dog-accept tests leave it inferred.
  await client.relations.create(relationLayerId, lemRuns, lemThe, 'det', {
    prov: 'inferred',
    provSource: 'service:test',
  });
});

// Each accept test confirms the prediction, so reset it to unconfirmed first.
test.beforeEach(async () => {
  await S.client.spans.patchMetadata(
    S.uposSpanId,
    metadataOps({
      prov: 'inferred',
      provSource: 'service:test',
      provConfirmed: null,
    }),
  );
});

test.afterAll(async () => {
  if (S.client && S.projectId) {
    await S.client.projects
      .delete(S.projectId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
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

const opacityOf = (loc) => loc.evaluate((el) => getComputedStyle(el).opacity);
const dogAccept = (page) =>
  page
    .locator('.token-column', { has: page.locator(`[id="${S.morphIds[1]}-lemma"]`) })
    .locator('.word-accept');

test('the sentence "Accept predictions" button is quiet by its outline, readable at rest, filled on hover', async ({
  page,
}) => {
  await openAnnotate(page);
  const btn = page.locator('.accept-predictions-btn');
  await expect(btn).toBeVisible();
  // Full strength at rest, so its violet text passes AA contrast. The quiet
  // look is the transparent fill and the soft outline.
  expect(await opacityOf(btn)).toBe('1');
  await expect(btn).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  // The violet of the marks it accepts, plaid-ui's --plaid-machine.
  await expect(btn).toHaveCSS('color', 'rgb(109, 40, 217)');
  await btn.hover();
  await expect(btn).toHaveCSS('background-color', 'rgb(109, 40, 217)');
});

test('the per-word ✓ is hidden by default and reveals on keyboard focus', async ({ page }) => {
  await openAnnotate(page);

  // "dog"'s UPOS is a machine prediction → rendered inferred (violet).
  await expect(page.locator('.editable-field--machine')).toHaveCount(1);
  // Two ✓s: "dog" (UPOS span) and "the" (its incoming det relation is machine-made).
  await expect(page.locator('.word-accept')).toHaveCount(2);
  const accept = dogAccept(page);
  expect(await opacityOf(accept)).toBe('0'); // NOT always-visible

  // Focusing one of the word's cells reveals it (keyboard review). Use the lemma
  // cell — a plain input whose focus doesn't open a vocab dropdown.
  await page.locator(`[id="${S.morphIds[1]}-lemma"]`).focus();
  await expect.poll(() => opacityOf(accept)).toBe('1');
});

test('the per-word ✓ is reachable by mouse and accepts the word', async ({ page }) => {
  await openAnnotate(page);
  const accept = dogAccept(page);

  await page.locator(`[id="${S.morphIds[1]}-lemma"]`).hover(); // mouse reveal
  await expect.poll(() => opacityOf(accept)).toBe('1');

  // Must survive the trip up to it (across the tree SVG) and be clickable.
  await accept.click();
  await expect(page.locator('.editable-field--machine')).toHaveCount(0, { timeout: 8000 });
  await expect(dogAccept(page)).toHaveCount(0, { timeout: 8000 });
  await expect(page.locator('.word-accept')).toHaveCount(1); // "the" still pending
});

test('an unapproved dependency edge is violet + dashed', async ({ page }) => {
  await openAnnotate(page);
  const arc = page.locator('.tree-arc-path').first(); // the lone (unapproved) relation
  await expect(arc).toBeVisible();
  // Unapproved violet #6d28d9 = rgb(109, 40, 217), and a dashed stroke.
  await expect
    .poll(() => arc.evaluate((el) => getComputedStyle(el).stroke))
    .toBe('rgb(109, 40, 217)');
  expect(await arc.evaluate((el) => getComputedStyle(el).strokeDasharray)).not.toBe('none');
});

test('Ctrl+Enter accepts the word and moves to the next one', async ({ page }) => {
  await openAnnotate(page);
  // "dog" is the middle word; "runs" is the next.
  await page.locator(`[id="${S.morphIds[1]}-lemma"]`).focus();

  await page.keyboard.press('Control+Enter');

  await expect(page.locator('.editable-field--machine')).toHaveCount(0, { timeout: 8000 });
  // The review flow is glance, accept, glance, accept: focus lands on the next
  // word's cell after a beat, so the mark going away is visible first.
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.id), { timeout: 8000 })
    .toBe(`${S.morphIds[2]}-lemma`);
});

test('Ctrl+Enter on a settled word holds position', async ({ page }) => {
  await openAnnotate(page);
  // "runs" carries nothing unreviewed. A hop here would read exactly like a
  // confirmation that never happened.
  const lemmaId = `${S.morphIds[2]}-lemma`;
  await page.locator(`[id="${lemmaId}"]`).focus();

  await page.keyboard.press('Control+Enter');

  await page.waitForTimeout(600);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe(lemmaId);
  // And nothing was accepted anywhere.
  await expect(page.locator('.editable-field--machine')).toHaveCount(1);
});
