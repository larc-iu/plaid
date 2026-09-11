// Item 8, parts 3 and 4: the Validation tab, and adopting what it finds.
//
// It exists because a closed list is enforced where a person types and nowhere
// else. An import, a parser, the assistant and a direct API call all reach the
// same span layer without passing that check, deliberately: off-list machine
// output is a signal. This is where you see what it said.
import { test, expect, seedAuth } from './fixtures.js';
import { seedUdDoc } from './seedUdDoc.js';

const S = {};

test.beforeEach(async () => {
  // A project per test: every one of these changes the project's vocabularies
  // or its stored values, and sharing one makes the order load-bearing.
  Object.assign(
    S,
    await seedUdDoc(`Validation ${Date.now()}`, 'the dog runs fast', [
      [0, 3],
      [4, 7],
      [8, 12],
      [13, 17],
    ]),
  );
  const { client, layers, morphIds } = S;
  const lemmas = [];
  for (const [i, lemma] of ['the', 'dog', 'run', 'fast'].entries()) {
    lemmas.push((await client.spans.create(layers.lemma, [morphIds[i]], lemma)).id);
  }
  // What a parser might have written past a closed list.
  await client.spans.create(layers.upos, [morphIds[0]], 'DET');
  await client.spans.create(layers.upos, [morphIds[1]], 'WIDGET');
  await client.spans.create(layers.upos, [morphIds[2]], 'WIDGET');
  await client.spans.create(layers.upos, [morphIds[3]], 'GIZMO');
  await client.spans.create(layers.features, [morphIds[1]], 'Number=Sing');
  await client.spans.create(layers.features, [morphIds[1]], 'Mood=Weird');
  await client.relations.create(layers.relation, lemmas[2], lemmas[0], 'det');
  // A subtype of a listed relation: legal, and must NOT be reported.
  await client.relations.create(layers.relation, lemmas[2], lemmas[1], 'nsubj:pass');
  await client.relations.create(layers.relation, lemmas[2], lemmas[3], 'zzz');
  await client.spanLayers.setConfig(layers.upos, 'ud', 'vocabMode', 'closed');
});

test.afterEach(async () => {
  if (S.client && S.projectId) {
    await S.client.projects
      .delete(S.projectId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

const openValidation = async (page) => {
  await seedAuth(page);
  await page.goto(`/#/projects/${S.projectId}/validate`);
  await expect(page.getByRole('heading', { name: 'Validation' })).toBeVisible({ timeout: 15000 });
};

test('it lists what is stored but not on the list, with counts', async ({ page }) => {
  await openValidation(page);

  await expect(page.getByText('WIDGET')).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('2 times')).toBeVisible();
  await expect(page.getByText('GIZMO')).toBeVisible();
  // A feature is reported per key and value.
  await expect(page.getByText('Mood')).toBeVisible();
  await expect(page.getByText('Weird', { exact: false })).toBeVisible();
});

test('a DEPREL subtype of a listed relation is not reported', async ({ page }) => {
  await openValidation(page);
  await expect(page.getByText('zzz')).toBeVisible({ timeout: 15000 });

  // `nsubj` is in the universal 37, so `nsubj:pass` is already legal and
  // offering to add it would start re-listing the language.
  await expect(page.getByText('nsubj:pass')).toHaveCount(0);
});

test('a value opens to the sentences it is in, each a link into the editor', async ({ page }) => {
  await openValidation(page);
  await page.getByRole('button', { name: /WIDGET/ }).click();

  const link = page.getByRole('link', { name: /sentence 1/ }).first();
  await expect(link).toBeVisible({ timeout: 15000 });
  // Landing on the document and leaving the reader to find the word is most of
  // the work not done, so the link carries the sentence.
  await expect(link).toHaveAttribute('href', /\/annotate\?sent=[0-9a-f-]+$/);
});

test('adding the values puts them on the list', async ({ page }) => {
  await openValidation(page);
  await page.getByRole('button', { name: /Add 2 values/ }).click();

  await expect
    .poll(
      async () => {
        const project = await S.client.projects.get(S.projectId);
        const words = project.textLayers[0].tokenLayers.find((l) => l.name === 'Words');
        return words.spanLayers.find((l) => l.name === 'UPOS').config?.ud?.vocab || [];
      },
      { timeout: 15000 },
    )
    .toEqual(expect.arrayContaining(['WIDGET', 'GIZMO']));

  // And then there is nothing left to report for that field.
  await expect(page.getByRole('button', { name: /Add 2 values/ })).toHaveCount(0, {
    timeout: 15000,
  });
});

test('a project whose values are all listed says so', async ({ page }) => {
  // Clear the off-list material, leaving only what the defaults already cover.
  const doc = await S.client.documents.get(S.documentId, true);
  const words = doc.textLayers[0].tokenLayers.find((l) => l.name === 'Words');
  const upos = words.spanLayers.find((l) => l.name === 'UPOS');
  for (const span of upos.spans) {
    if (span.value !== 'DET') await S.client.spans.delete(span.id);
  }
  const feats = words.spanLayers.find((l) => l.name === 'Features');
  for (const span of feats.spans) {
    if (span.value !== 'Number=Sing') await S.client.spans.delete(span.id);
  }
  const relations = words.spanLayers.find((l) => l.name === 'Lemma').relationLayers[0].relations;
  for (const relation of relations) {
    if (relation.value === 'zzz') await S.client.relations.delete(relation.id);
  }

  await openValidation(page);
  await expect(page.getByText('Everything stored is on the list.')).toHaveCount(4, {
    timeout: 15000,
  });
});
