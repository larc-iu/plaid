// A drawn arc shows the moment it is let go, not when the server answers.
// The server's answer to the write is held here until the arc has been looked
// for, so a write that waits on it for the arc to appear goes red. This has
// regressed three times, each time to "wait for the server's id".
// Seeds 'she came and left' with the root alone: root(came).
import { test, expect, seedAuth } from './fixtures.js';
import { seedUdDoc } from './seedUdDoc.js';
import { getUdLayerInfo } from '../src/utils/udLayerUtils.js';

const S = {};

test.beforeAll(async () => {
  Object.assign(
    S,
    await seedUdDoc(`Optimistic draw ${Date.now()}`, 'she came and left', [
      [0, 3],
      [4, 8],
      [9, 12],
      [13, 17],
    ]),
  );
  const { client, layers, morphIds } = S;
  const come = (await client.spans.create(layers.lemma, [morphIds[1]], 'come')).id;
  await client.relations.create(layers.relation, come, come, 'root');
});

test.afterAll(async () => {
  if (S.client && S.projectId) {
    await S.client.projects
      .delete(S.projectId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

test.describe.configure({ mode: 'serial' });

async function drag(page, from, to) {
  const areas = page.locator('.tree-token-area');
  const a = await areas.nth(from).boundingBox();
  const b = await areas.nth(to).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
}

// Hold every write until `release()`.
async function holdWrites(page) {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await page.route('**/api/v1/**', async (route) => {
    if (route.request().method() === 'GET') return route.continue();
    await held;
    return route.continue();
  });
  return release;
}

const headOf = async (form) => {
  const info = getUdLayerInfo(await S.client.documents.get(S.documentId, true));
  const lemma = (id) => info.lemmaLayer.spans.find((s) => s.id === id);
  const body = info.textLayer.text.body;
  const formOf = (spanId) => {
    const token = info.tokenLayer.tokens.find((t) => t.id === lemma(spanId)?.tokens[0]);
    return token && [...body].slice(token.begin, token.end).join('');
  };
  const rel = info.relationLayer.relations.find((r) => formOf(r.target) === form);
  return rel && formOf(rel.source);
};

test('an arc drawn to a word with no head shows before the server answers', async ({ page }) => {
  await seedAuth(page);
  await page.goto(`/#/projects/${S.projectId}/documents/${S.documentId}/annotate`);
  await expect(page.locator('.tree-deprel-text')).toHaveCount(1, { timeout: 15000 });

  const release = await holdWrites(page);
  // "she" has no lemma span yet either, so the write makes one first.
  await drag(page, 1, 0);
  await expect(page.locator('.tree-deprel-text')).toHaveCount(2, { timeout: 1000 });
  expect(await headOf('she')).toBeUndefined();

  release();
  await expect.poll(() => headOf('she')).toBe('came');
  await expect(page.locator('.tree-deprel-text')).toHaveCount(2);
});

test('a re-pointed head shows before the server answers', async ({ page }) => {
  await seedAuth(page);
  await page.goto(`/#/projects/${S.projectId}/documents/${S.documentId}/annotate`);
  await expect(page.locator('.tree-deprel-text')).toHaveCount(2, { timeout: 15000 });
  const arcPaths = () =>
    page.locator('.tree-arc-path').evaluateAll((els) => els.map((e) => e.getAttribute('d')).sort());
  const before = await arcPaths();

  const release = await holdWrites(page);
  // she's head moves from "came" to "left".
  await drag(page, 3, 0);
  await expect.poll(arcPaths, { timeout: 1000 }).not.toEqual(before);
  await expect(page.locator('.tree-deprel-text')).toHaveCount(2);
  expect(await headOf('she')).toBe('came');

  release();
  await expect.poll(() => headOf('she')).toBe('left');
});
