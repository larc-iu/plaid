import PlaidClient, { ROLES, cpLength } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken, CORE } from './fixtures.js';
import { getFixture, roleOf } from './fixtureProject.js';

// H6-2: a sentence split that puts a multi-word expression's words in two
// sentences says so in the split confirmation, which it asks even though it
// deletes nothing. The expression is not deleted: merging the sentences again
// shows it. Throwaway document and entry in the "E2E IGT Fixture" project,
// deleted afterwards.

const BODY = 'kick the bucket today';

let client;
let projectId;
let documentId;
let itemId;

test.beforeAll(async () => {
  client = new PlaidClient(CORE, readToken().token);
  ({ projectId } = await getFixture());
  const full = await client.projects.get(projectId);
  const textLayer = full.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const layer = (role) => textLayer.tokenLayers.find((l) => roleOf(l) === role);
  const vocab = full.vocabs.find((v) => v.name === 'IGT Lexicon');
  const stamp = Date.now();
  itemId = (
    await client.vocabItems.create(vocab.id, `kick the bucket ${stamp}`, { morphType: 'phrase' })
  ).id;
  documentId = (await client.documents.create(projectId, `split-mwe ${stamp}`)).id;
  await client.texts.create(textLayer.id, documentId, BODY);
  const raw = await client.documents.get(documentId, true);
  const TEXT = raw.textLayers.find((l) => roleOf(l) === ROLES.BASELINE).text.id;
  const words = [...BODY.matchAll(/\S+/g)].map((m) => ({
    begin: m.index,
    end: m.index + m[0].length,
  }));
  await client.tokens.bulkCreate([
    { tokenLayerId: layer(ROLES.SENTENCE).id, text: TEXT, begin: 0, end: cpLength(BODY) },
  ]);
  const WORD = layer(ROLES.WORD);
  await client.tokens.bulkCreate(words.map((w) => ({ tokenLayerId: WORD.id, text: TEXT, ...w })));
  const seeded = await client.documents.get(documentId, true);
  const wl = seeded.textLayers
    .find((l) => roleOf(l) === ROLES.BASELINE)
    .tokenLayers.find((l) => l.id === WORD.id);
  const ids = words.map((x) => wl.tokens.find((t) => t.begin === x.begin).id);
  // "kick the bucket": one link over the first three words.
  await client.vocabLinks.create(itemId, ids.slice(0, 3));
});

test.afterAll(async () => {
  if (documentId) await client.documents.delete(documentId).catch(() => {});
  if (itemId) await client.vocabItems.delete(itemId).catch(() => {});
});

const open = async (page, tab) => {
  if (page.url() !== 'about:blank') await page.goto('about:blank');
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=${tab}`);
  await page.waitForLoadState('networkidle');
};
const mweLabels = (page) => page.locator('.igt-mwe__label');

test('a split that hides a multi-word expression asks, and a merge shows it again', async ({
  page,
}) => {
  await open(page, 'analyze');
  await expect(mweLabels(page)).toHaveCount(1);

  await open(page, 'tokenize');
  const the = page.locator('.token', { hasText: /^the$/ });
  await the.waitFor({ state: 'visible' });
  await the.click({ modifiers: ['Control'] });
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('heading', { name: 'Split sentence?' })).toBeVisible();
  await expect(dialog).toContainText(
    '1 multi-word expression will not be shown until the sentences are merged again.',
  );
  await expect(dialog).not.toContainText('deletes');
  await dialog.getByRole('button', { name: 'Split' }).click();
  await expect(page.locator('.merge-button button')).toHaveCount(1);
  await expect(page.locator('[data-state="saving"]')).toHaveCount(0);

  await open(page, 'analyze');
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  await expect(mweLabels(page)).toHaveCount(0);
  // The link is not deleted.
  const raw = await client.documents.get(documentId, true);
  const links = raw.textLayers
    .flatMap((l) => l.tokenLayers || [])
    .flatMap((l) => l.vocabs || [])
    .flatMap((v) => v.vocabLinks || [])
    .filter((l) => l.vocabItem?.id === itemId || l.vocabItem === itemId);
  expect(links.map((l) => l.tokens.length)).toEqual([3]);

  await open(page, 'tokenize');
  await page.locator('.merge-button button').click();
  await expect(page.locator('.merge-button button')).toHaveCount(0);
  await expect(page.locator('[data-state="saving"]')).toHaveCount(0);

  await open(page, 'analyze');
  await expect(mweLabels(page)).toHaveCount(1);
});
