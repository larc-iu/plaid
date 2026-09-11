// Item 8, parts 1 and 2: a vocabulary can be a rule rather than a suggestion,
// and every value can say what it is for.
//
// The enforcement is deliberately narrow: the annotation cells and the Grew
// rewrite, and nowhere else. An import, a parser, the assistant and the API all
// still write whatever they like, which is the whole point — off-list machine
// output is a signal worth seeing, and the Validation tab is the cleanup path.
import { test, expect, seedAuth } from './fixtures.js';
import { seedUdDoc } from './seedUdDoc.js';

const S = {};

test.beforeAll(async () => {
  Object.assign(
    S,
    await seedUdDoc(`Vocab mode ${Date.now()}`, 'the dog runs', [
      [0, 3],
      [4, 7],
      [8, 12],
    ]),
  );
  S.lemmaIds = [];
  for (const [i, lemma] of ['the', 'dog', 'run'].entries()) {
    S.lemmaIds.push((await S.client.spans.create(S.layers.lemma, [S.morphIds[i]], lemma)).id);
  }
  S.relationId = (
    await S.client.relations.create(S.layers.relation, S.lemmaIds[2], S.lemmaIds[0], 'det')
  ).id;
});

test.afterAll(async () => {
  if (S.client && S.projectId) {
    await S.client.projects
      .delete(S.projectId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

const close = async (layerId, relation = false) => {
  const layers = relation ? S.client.relationLayers : S.client.spanLayers;
  await layers.setConfig(layerId, 'ud', 'vocabMode', 'closed');
};
const open = async (layerId, relation = false) => {
  const layers = relation ? S.client.relationLayers : S.client.spanLayers;
  await layers.setConfig(layerId, 'ud', 'vocabMode', 'open');
};

const uposValues = async () => {
  const doc = await S.client.documents.get(S.documentId, true);
  const words = doc.textLayers[0].tokenLayers.find((l) => l.name === 'Words');
  const upos = words.spanLayers.find((l) => l.name === 'UPOS');
  return (upos.spans || []).map((s) => s.value);
};
const deprels = async () => {
  const doc = await S.client.documents.get(S.documentId, true);
  const words = doc.textLayers[0].tokenLayers.find((l) => l.name === 'Words');
  const lemma = words.spanLayers.find((l) => l.name === 'Lemma');
  return (lemma.relationLayers[0].relations || []).map((r) => r.value);
};

const openAnnotate = async (page) => {
  await seedAuth(page);
  await page.addInitScript(() => {
    localStorage.setItem(
      'ud-annotation-visible-fields',
      JSON.stringify({ lemma: true, xpos: true, upos: true, feats: true, meta: false }),
    );
  });
  await page.goto(`/#/projects/${S.projectId}/documents/${S.documentId}/annotate`);
  await expect(page.locator('.token-form', { hasText: 'dog' }).first()).toBeVisible({
    timeout: 15000,
  });
};

test('an OPEN vocabulary takes anything, as it always has', async ({ page }) => {
  await open(S.layers.upos);
  await openAnnotate(page);

  const cell = page.locator(`[id="${S.morphIds[1]}-upos"]`);
  await cell.click();
  await cell.fill('WIDGET');
  await cell.press('Enter');

  await expect.poll(uposValues, { timeout: 8000 }).toContain('WIDGET');
  // Put it back.
  await S.client.spans.delete(
    (await S.client.documents.get(S.documentId, true)).textLayers[0].tokenLayers
      .find((l) => l.name === 'Words')
      .spanLayers.find((l) => l.name === 'UPOS')
      .spans.find((s) => s.value === 'WIDGET').id,
  );
});

test('a CLOSED vocabulary refuses an off-list tag and keeps what was saved', async ({ page }) => {
  await close(S.layers.upos);
  await S.client.spans.create(S.layers.upos, [S.morphIds[1]], 'NOUN');
  await openAnnotate(page);

  const cell = page.locator(`[id="${S.morphIds[1]}-upos"]`);
  await cell.click();
  await cell.fill('WIDGET');
  await cell.press('Enter');

  await expect(page.getByText("WIDGET is not in this project's UPOS list.")).toBeVisible({
    timeout: 8000,
  });
  // The SAVED value is what stays, not the typed one: an annotator who meant a
  // tag the project does not have wants to see what is actually stored.
  await expect(cell).toHaveValue('NOUN');
  await expect.poll(uposValues, { timeout: 8000 }).not.toContain('WIDGET');

  await S.client.spans.delete(
    (await S.client.documents.get(S.documentId, true)).textLayers[0].tokenLayers
      .find((l) => l.name === 'Words')
      .spanLayers.find((l) => l.name === 'UPOS')
      .spans.find((s) => s.value === 'NOUN').id,
  );
  await open(S.layers.upos);
});

test('a CLOSED relation list judges a subtype by its base', async ({ page }) => {
  await close(S.layers.relation, true);
  await openAnnotate(page);

  // `det:predet` is legal wherever `det` is: subtypes are language-specific and
  // open-ended, and a project listing every one it used would re-list the
  // language.
  await page.locator('.tree-deprel-text').first().click();
  const editor = page.locator('.deprel-edit-input');
  await expect(editor).toBeVisible({ timeout: 8000 });
  await editor.fill('det:predet');
  await page.getByRole('option', { name: /as typed/ }).click();
  await expect.poll(deprels, { timeout: 8000 }).toContain('det:predet');

  // A base nobody listed is refused, and the arc keeps the label it had.
  await page.locator('.tree-deprel-text').first().click();
  await expect(editor).toBeVisible({ timeout: 8000 });
  await editor.fill('zzz');
  await page.getByRole('option', { name: /as typed/ }).click();
  await expect(
    page.getByText("zzz is not in this project's dependency relation list."),
  ).toBeVisible({ timeout: 8000 });
  await expect.poll(deprels, { timeout: 8000 }).toEqual(['det:predet']);

  await S.client.relations.update(S.relationId, 'det');
  await open(S.layers.relation, true);
});

test('the pickers say what each tag is for', async ({ page }) => {
  await openAnnotate(page);

  await page.locator(`[id="${S.morphIds[1]}-upos"]`).click();
  await expect(
    page.getByRole('option', { name: /Common noun\. A person, place or thing/ }),
  ).toBeVisible({ timeout: 8000 });

  await page.keyboard.press('Escape');
  await page.locator('.tree-deprel-text').first().click();
  await expect(page.getByRole('option', { name: /Determiner attached to its noun/ })).toBeVisible({
    timeout: 8000,
  });
});

test('a maintainer can close a vocabulary and describe its values', async ({ page }) => {
  await seedAuth(page);
  await page.goto(`/#/projects/${S.projectId}/customization`);

  const toggle = page.locator('#xpos-closed');
  await expect(toggle).toBeVisible({ timeout: 15000 });
  await expect(toggle).toHaveAttribute('data-state', 'unchecked');

  // Give XPOS a value, a description, and a closed list.
  const tagInput = page.getByLabel('XPOS tags');
  await tagInput.fill('NN');
  await tagInput.press('Enter');
  await page.getByLabel('NN description').fill('Singular common noun.');
  await toggle.click();
  await page.getByRole('button', { name: /^Save/ }).click();

  await expect
    .poll(
      async () => {
        const project = await S.client.projects.get(S.projectId);
        const words = project.textLayers[0].tokenLayers.find((l) => l.name === 'Words');
        const xpos = words.spanLayers.find((l) => l.name === 'XPOS');
        return JSON.stringify(xpos.config?.ud || {});
      },
      { timeout: 10000 },
    )
    .toContain('closed');

  const project = await S.client.projects.get(S.projectId);
  const words = project.textLayers[0].tokenLayers.find((l) => l.name === 'Words');
  const xpos = words.spanLayers.find((l) => l.name === 'XPOS');
  expect(xpos.config.ud.vocab).toEqual(['NN']);
  expect(xpos.config.ud.vocabDescriptions).toEqual({ NN: 'Singular common noun.' });

  await S.client.spanLayers.setConfig(S.layers.xpos, 'ud', 'vocabMode', 'open');
  await S.client.spanLayers.setConfig(S.layers.xpos, 'ud', 'vocab', []);
});
