// A sentence wider than the window scrolls sideways while an arc in the hand
// is held at its edge, so a word off screen can be reached by the drag alone
// (PB-8). Seeds one sentence of forty words, the first the root.
import { test, expect, seedAuth } from './fixtures.js';
import { seedUdDoc } from './seedUdDoc.js';
import { getUdLayerInfo } from '../src/utils/udLayerUtils.js';

const S = {};
const WORDS = Array.from({ length: 40 }, (_, i) => `word${String(i + 1).padStart(2, '0')}`);

test.beforeAll(async () => {
  const body = WORDS.join(' ');
  let at = 0;
  const spans = WORDS.map((w) => {
    const span = [at, at + w.length];
    at += w.length + 1;
    return span;
  });
  Object.assign(S, await seedUdDoc(`Drag scroll ${Date.now()}`, body, spans));
  const { client, layers, morphIds } = S;
  const first = (await client.spans.create(layers.lemma, [morphIds[0]], 'word')).id;
  await client.relations.create(layers.relation, first, first, 'root');
});

test.afterAll(async () => {
  if (S.client && S.projectId) {
    await S.client.projects
      .delete(S.projectId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

test.describe.configure({ mode: 'serial' });

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

test('an arc held at the right edge scrolls the sentence to a word off screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await seedAuth(page);
  await page.goto(`/#/projects/${S.projectId}/documents/${S.documentId}/annotate`);
  await expect(page.locator('.tree-deprel-text')).toHaveCount(1, { timeout: 15000 });

  const scroller = page.locator('.sentence-scroll').first();
  const scrollLeft = () => scroller.evaluate((el) => el.scrollLeft);
  const box = await scroller.boundingBox();
  const areas = page.locator('.tree-token-area');
  const last = areas.nth(WORDS.length - 1);
  // The last word starts off screen.
  expect((await last.boundingBox()).x).toBeGreaterThan(box.x + box.width);
  expect(await scrollLeft()).toBe(0);

  const from = await areas.nth(0).boundingBox();
  const y = from.y + from.height / 2;
  await page.mouse.move(from.x + from.width / 2, y);
  await page.mouse.down();
  // Held just inside the sentence's right edge, without moving.
  await page.mouse.move(box.x + box.width - 5, y, { steps: 10 });
  await expect.poll(scrollLeft, { timeout: 10000 }).toBeGreaterThan(200);
  await expect
    .poll(
      async () => {
        const b = await last.boundingBox();
        return b.x + b.width < box.x + box.width;
      },
      { timeout: 20000 },
    )
    .toBe(true);

  // Out of the edge the sentence stops, and the drop lands on the word.
  const target = await last.boundingBox();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 5 });
  const settled = await scrollLeft();
  await page.waitForTimeout(300);
  expect(await scrollLeft()).toBe(settled);
  const onTarget = await last.boundingBox();
  await page.mouse.move(onTarget.x + onTarget.width / 2, onTarget.y + onTarget.height / 2);
  await page.mouse.up();
  await expect.poll(() => headOf(WORDS.at(-1))).toBe(WORDS[0]);
});

test('an arc held at the left edge scrolls the sentence back', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await seedAuth(page);
  await page.goto(`/#/projects/${S.projectId}/documents/${S.documentId}/annotate`);
  await expect(page.locator('.tree-deprel-text')).toHaveCount(2, { timeout: 15000 });

  const scroller = page.locator('.sentence-scroll').first();
  const scrollLeft = () => scroller.evaluate((el) => el.scrollLeft);
  await scroller.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  const start = await scrollLeft();
  expect(start).toBeGreaterThan(200);

  const box = await scroller.boundingBox();
  const from = await page
    .locator('.tree-token-area')
    .nth(WORDS.length - 2)
    .boundingBox();
  const y = from.y + from.height / 2;
  await page.mouse.move(from.x + from.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 5, y, { steps: 10 });
  await expect.poll(scrollLeft, { timeout: 20000 }).toBe(0);
  // Let go away from any word: nothing is written.
  await page.mouse.move(box.x + 5, y + 300);
  await page.mouse.up();
  await expect(page.locator('.tree-deprel-text')).toHaveCount(2);
});
