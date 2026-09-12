// Item 16: Alt+Down asks what this project has said before about a word like
// this one.
//
// The parser writes a first draft of most things, so this is not how a document
// gets annotated: it is consistency help for the parts done by hand, and for
// the moment before you type the second `NNS` for a word you already tagged
// `NN` somewhere else.
import { test, expect, seedAuth } from './fixtures.js';
import { seedUdDoc } from './seedUdDoc.js';

const BODY = 'the dogs run the dog runs a dog sleeps';
const WORDS = [
  [0, 3],
  [4, 8],
  [9, 12],
  [13, 16],
  [17, 20],
  [21, 25],
  [26, 27],
  [28, 31],
  [32, 38],
];

const S = {};

test.beforeEach(async () => {
  // A project per test: each one writes an annotation, and precedent is a
  // question about what the project holds.
  Object.assign(S, await seedUdDoc(`Precedent ${Date.now()}`, BODY, WORDS));
  const { client, layers, morphIds } = S;
  // "dog" is lemmatised twice as `dog` and once, wrongly, as `Dog`.
  const lemmas = ['the', 'dog', 'run', 'the', 'dog', 'run', 'a', 'Dog', 'sleep'];
  const xpos = ['DT', 'NNS', 'VBP', 'DT', 'NN', 'VBZ', 'DT', 'NN', 'VBZ'];
  S.lemmaSpans = [];
  for (const [i, lemma] of lemmas.entries()) {
    S.lemmaSpans.push((await client.spans.create(layers.lemma, [morphIds[i]], lemma)).id);
  }
  for (const [i, tag] of xpos.entries()) await client.spans.create(layers.xpos, [morphIds[i]], tag);
  for (const i of [1, 4]) await client.spans.create(layers.features, [morphIds[i]], 'Number=Plur');
});

test.afterEach(async () => {
  if (S.client && S.projectId) {
    await S.client.projects
      .delete(S.projectId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

const openAnnotate = async (page) => {
  await seedAuth(page);
  await page.addInitScript(() => {
    if (!localStorage.getItem('ud-annotation-visible-fields')) {
      localStorage.setItem(
        'ud-annotation-visible-fields',
        JSON.stringify({ lemma: true, xpos: true, upos: true, feats: true, meta: false }),
      );
    }
  });
  await page.goto(`/#/projects/${S.projectId}/documents/${S.documentId}/annotate`);
  await expect(page.locator('.token-form').first()).toBeVisible({ timeout: 15000 });
};

const lemmaValues = async () => {
  const doc = await S.client.documents.get(S.documentId, true);
  const words = doc.textLayers[0].tokenLayers.find((l) => l.name === 'Words');
  return (words.spanLayers.find((l) => l.name === 'Lemma').spans || []).map((s) => s.value).sort();
};

test('Alt+Down in a lemma cell lists the lemmas this FORM has had, with counts', async ({
  page,
}) => {
  await openAnnotate(page);
  // The third "dog" (index 7), the one lemmatised `Dog`.
  const cell = page.locator(`[id="${S.morphIds[7]}-lemma"]`);
  await cell.click();
  await cell.press('Alt+ArrowDown');

  // A lemma cell has no controlled list of its own and is a plain input the
  // rest of the time; this is the one thing that gives it a list.
  await expect(page.getByRole('option', { name: /^dog/ })).toBeVisible({ timeout: 8000 });
  await expect(page.getByRole('option', { name: /^Dog/ })).toBeVisible();
});

test('picking one commits it, through the swap from input to list', async ({ page }) => {
  await openAnnotate(page);
  const cell = page.locator(`[id="${S.morphIds[7]}-lemma"]`);
  await cell.click();
  await cell.press('Alt+ArrowDown');
  await expect(page.getByRole('option', { name: /^dog/ })).toBeVisible({ timeout: 8000 });

  // Showing the list replaces the input element. React fires no blur when it
  // unmounts a focused one, so a guard that waited for that blur would swallow
  // this commit and the pick would show on screen and never be saved.
  // The count rides in its own span, so the option's accessible name has no
  // space in it: match the value, not a rendered "dog 2".
  await page.getByRole('option', { name: /^dog/ }).first().click();

  await expect.poll(lemmaValues, { timeout: 8000 }).not.toContain('Dog');
});

test('Alt+Down in an XPOS cell asks about the LEMMA, not the form', async ({ page }) => {
  await openAnnotate(page);
  // "dogs" (NNS) and "dog" (NN) are both lemma `dog`. Asking from the second
  // offers both, because the question is what this LEMMA has been tagged: the
  // form would have offered only what "dog" itself was.
  const cell = page.locator(`[id="${S.morphIds[4]}-xpos"]`);
  await cell.click();
  await cell.press('Alt+ArrowDown');

  await expect(page.getByRole('option', { name: /^NNS/ })).toBeVisible({ timeout: 8000 });
  const options = await page.getByRole('option').allInnerTexts();
  expect(options.join(' ')).toContain('NN');
  // And NOT what a form-keyed question would have given: `VBZ` belongs to
  // "runs", which shares no lemma with this word.
  expect(options.join(' ')).not.toContain('VBZ');
});

test('Escape leaves the precedent list and keeps the value', async ({ page }) => {
  await openAnnotate(page);
  const cell = page.locator(`[id="${S.morphIds[7]}-lemma"]`);
  await cell.click();
  await cell.press('Alt+ArrowDown');
  await expect(page.getByRole('option', { name: /^dog/ })).toBeVisible({ timeout: 8000 });

  await cell.press('Escape');
  await expect(page.getByRole('option', { name: /^dog/ })).toHaveCount(0);
  await expect.poll(lemmaValues, { timeout: 8000 }).toContain('Dog');
});

test('leaving the precedent list leaves a cell you can still type in', async ({ page }) => {
  // A lemma cell has no list of its own, so showing precedent swaps the plain
  // input for a combobox and leaving swaps it back. React fires no blur when it
  // unmounts a focused element, so the cell was left thinking it was being
  // edited with nothing focused: the next character went nowhere and the cell
  // stopped following the stored value. The old test asserted the option count
  // and the value, which both survived it.
  await openAnnotate(page);
  const cell = page.locator(`[id="${S.morphIds[7]}-lemma"]`);
  await cell.click();
  await cell.press('Alt+ArrowDown');
  await expect(page.getByRole('option', { name: /^dog/ })).toBeVisible({ timeout: 8000 });

  await cell.press('Escape');
  await expect(cell).toBeFocused();

  await cell.fill('hound');
  await cell.press('Tab');
  await expect.poll(lemmaValues, { timeout: 8000 }).toContain('hound');
});

test('typing over the precedent list keeps the character you typed', async ({ page }) => {
  // The same swap, taken by typing instead of Escape.
  await openAnnotate(page);
  const cell = page.locator(`[id="${S.morphIds[7]}-lemma"]`);
  await cell.click();
  await cell.press('Alt+ArrowDown');
  await expect(page.getByRole('option', { name: /^dog/ })).toBeVisible({ timeout: 8000 });

  await cell.pressSequentially('wolf');
  await expect(cell).toBeFocused();
  await expect(cell).toHaveValue(/wolf/);
});

test('a word with no precedent gets no list, and says so by not changing', async ({ page }) => {
  await openAnnotate(page);
  // "sleeps" is the only word with that form, and its own lemma is the only
  // one. Nothing to offer is not a mode worth entering.
  const cell = page.locator(`[id="${S.morphIds[8]}-lemma"]`);
  await cell.click();
  await cell.press('Alt+ArrowDown');

  await page.waitForTimeout(1200);
  await expect(page.getByRole('option')).toHaveCount(1); // its own, and only its own
});

test('re-typing a machine lemma through the precedent list still confirms it', async ({ page }) => {
  // Re-entering a machine's own value is a human confirmation (the provenance
  // write contract), and `pristine` is what tells the blur that the annotator
  // typed. The swap back out of precedent mode re-runs the cell's focus
  // handler, which reset `pristine`, so the confirmation was skipped and
  // nothing was written at all.
  const { client, morphIds } = S;
  // The fixture's own lemma on the word the other precedent tests use, made to
  // look machine-written. That word HAS precedent, so the list really opens
  // and leaving it really swaps the element.
  const spanId = S.lemmaSpans[7];
  await client.spans.patchMetadata(spanId, { prov: 'inferred', provSource: 'service:test' });

  await openAnnotate(page);
  const cell = page.locator(`[id="${morphIds[7]}-lemma"]`);
  await cell.click();
  await cell.press('Alt+ArrowDown');
  await expect(page.getByRole('option', { name: /^dog/ })).toBeVisible({ timeout: 8000 });

  // Re-type the machine's own value, which leaves the list, and tab out.
  await cell.pressSequentially('Dog');
  await cell.press('Tab');

  await expect
    .poll(async () => (await client.spans.get(spanId)).metadata?.provConfirmed, { timeout: 8000 })
    .toBe(true);
});

test('leaving the precedent list without typing confirms nothing', async ({ page }) => {
  // The other half of the rule above. `pristine` was forced false whenever the
  // list closed, typed or not, so opening precedent on a machine value and
  // pressing Escape verified it on the way out: a provenance stamp nobody
  // earned, from a gesture that means "never mind".
  const { client, morphIds } = S;
  const spanId = S.lemmaSpans[7]; // "Dog", made to look machine-written
  const otherId = S.lemmaSpans[4]; // "dog", re-typed for real below
  for (const id of [spanId, otherId]) {
    await client.spans.patchMetadata(id, { prov: 'inferred', provSource: 'service:test' });
  }

  await openAnnotate(page);
  const cell = page.locator(`[id="${morphIds[7]}-lemma"]`);
  await cell.click();
  await cell.press('Alt+ArrowDown');
  await expect(page.getByRole('option', { name: /^dog/ })).toBeVisible({ timeout: 8000 });
  await cell.press('Escape');
  await cell.press('Tab');

  // A confirmation that IS earned, on another word, so the assertion below
  // cannot pass merely by running before anything was written.
  const other = page.locator(`[id="${morphIds[4]}-lemma"]`);
  await other.click();
  await other.pressSequentially('dog');
  await other.press('Tab');
  await expect
    .poll(async () => (await client.spans.get(otherId)).metadata?.provConfirmed, { timeout: 8000 })
    .toBe(true);

  expect((await client.spans.get(spanId)).metadata?.provConfirmed).toBeUndefined();
});
