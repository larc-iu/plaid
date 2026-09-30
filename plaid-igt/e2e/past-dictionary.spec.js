import PlaidClient, { ROLES, cpLength } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';
import { getFixture } from './fixtureProject.js';

// A document viewed as it was in the past reads its vocabulary as it was at
// the same moment (audit-past-doc-dictionary, ruled b): an entry renamed since
// shows its old form on the word it was linked from. A throwaway vocabulary
// and document are made in the "E2E IGT Fixture" project and removed.

const CORE = 'http://localhost:8085';
const roleOf = (l) => l?.config?.plaid?.role;
const BODY = 'fono tama';

let client;
let projectId;
let documentId;
let vocab;
let wordId;

test.beforeAll(async () => {
  client = new PlaidClient(CORE, readToken().token);
  await getFixture(); // builds the fixture project where the database lacks it
  const project = (await client.projects.list()).find((p) => p.name === 'E2E IGT Fixture');
  if (!project) throw new Error('run node e2e/fixtureProject.js first');
  projectId = project.id;
  const full = await client.projects.get(projectId);
  const textLayer = full.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const layer = (role) => textLayer.tokenLayers.find((l) => roleOf(l) === role);
  const stamp = Date.now();
  vocab = await client.vocabLayers.create(`Past dictionary ${stamp}`);
  await client.projects.linkVocab(projectId, vocab.id);
  const entry = await client.vocabItems.create(vocab.id, 'fono', { gloss: 'sound' });

  documentId = (await client.documents.create(projectId, `past-dictionary ${stamp}`)).id;
  const text = (await client.texts.create(textLayer.id, documentId, BODY)).id;
  await client.tokens.bulkCreate([
    { tokenLayerId: layer(ROLES.SENTENCE).id, text, begin: 0, end: cpLength(BODY) },
  ]);
  const { ids } = await client.tokens.bulkCreate([
    { tokenLayerId: layer(ROLES.WORD).id, text, begin: 0, end: 4 },
    { tokenLayerId: layer(ROLES.WORD).id, text, begin: 5, end: 9 },
  ]);
  wordId = ids[0];
  await client.vocabLinks.create(entry.id, [wordId]);
  // After the document's last change: the entry is renamed.
  await client.vocabItems.bulkUpdate([{ id: entry.id, form: 'fonu' }]);
});

test.afterAll(async () => {
  if (documentId) await client.documents.delete(documentId).catch(() => {});
  if (vocab) {
    await client.projects.unlinkVocab(projectId, vocab.id).catch(() => {});
    await client.vocabLayers.delete(vocab.id).catch(() => {});
  }
});

test('a past state of a document shows the entry as it read then', async ({ page }) => {
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=analyze`);
  const chip = page.locator(`button.igt-vocab__hint[data-vocab-opener="${wordId}"]`);
  await expect(chip).toHaveText(/fonu/);

  await page.getByRole('button', { name: 'History', exact: true }).click();
  // The rename is in the document's history too, since it changes how the
  // document reads. The entry before it is the link, made while the entry was
  // still spelled "fono".
  await page.getByText('Create vocab mapping').click();
  await expect(page.getByText(/This is the document as of/)).toBeVisible();
  await expect(chip).toHaveText(/fono/);

  await page.getByRole('button', { name: 'Return to current' }).click();
  await expect(chip).toHaveText(/fonu/);
});
