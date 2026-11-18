// What the tree's mouse gestures write, and what they must not, over two
// sentences (bug hunt three, H3-1-1, H3-1-4):
//   - An arc let go on a word of ANOTHER sentence ends the drag and writes
//     nothing, then or on any later click.
//   - Escape drops an arc in the hand, and the release writes nothing.
// Seeds 'She came and left .' (came root, She nsubj, left conj, and cc of left,
// . punct) and 'The dog barked loudly .' (barked root, dog nsubj, The det of
// dog, loudly advmod, . punct). Relations store source=head, target=dependent.
import { test, expect, seedAuth } from './fixtures.js';
import { seedUdDoc } from './seedUdDoc.js';
import { getUdLayerInfo } from '../src/utils/udLayerUtils.js';

const S = {};
const ONE = 'She came and left .';
const TWO = 'The dog barked loudly .';
const BODY = `${ONE}\n${TWO}`;

const wordsOf = (body) => {
  const words = [];
  for (const m of body.matchAll(/\S+/gu)) {
    const begin = [...body.slice(0, m.index)].length;
    words.push([begin, begin + [...m[0]].length]);
  }
  return words;
};

// Every relation as "head-label->dependent", sorted, as the store holds it.
const stored = async () => {
  const info = getUdLayerInfo(await S.client.documents.get(S.documentId, true));
  const body = [...info.textLayer.text.body];
  const formOf = (spanId) => {
    const span = info.lemmaLayer.spans.find((s) => s.id === spanId);
    const token = info.tokenLayer.tokens.find((t) => t.id === span?.tokens[0]);
    return token && `${body.slice(token.begin, token.end).join('')}@${token.begin}`;
  };
  return info.relationLayer.relations
    .map((r) => `${formOf(r.source)}-${r.value}->${formOf(r.target)}`)
    .sort();
};

// Both sentences on screen at once, so a drag can go from one to the other.
test.use({ viewport: { width: 1400, height: 1000 } });

let seeded;

test.beforeAll(async () => {
  Object.assign(
    S,
    await seedUdDoc(`Tree gestures ${Date.now()}`, BODY, wordsOf(BODY), [
      [0, ONE.length + 1],
      [ONE.length + 1, [...BODY].length],
    ]),
  );
  const { client, layers, morphIds } = S;
  const lemmas = ['she', 'come', 'and', 'leave', '.', 'the', 'dog', 'bark', 'loudly', '.'];
  const id = [];
  for (const [i, value] of lemmas.entries()) {
    id.push((await client.spans.create(layers.lemma, [morphIds[i]], value)).id);
  }
  const rel = (h, d, v) => client.relations.create(layers.relation, id[h], id[d], v);
  await rel(1, 1, 'root');
  await rel(1, 0, 'nsubj');
  await rel(3, 2, 'cc');
  await rel(1, 3, 'conj');
  await rel(1, 4, 'punct');
  await rel(7, 7, 'root');
  await rel(7, 6, 'nsubj');
  await rel(6, 5, 'det');
  await rel(7, 8, 'advmod');
  await rel(7, 9, 'punct');
  seeded = await stored();
});

test.afterAll(async () => {
  if (S.client && S.projectId) {
    await S.client.projects
      .delete(S.projectId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

async function open(page) {
  await seedAuth(page);
  await page.goto(`/#/projects/${S.projectId}/documents/${S.documentId}/annotate`);
  await expect(page.locator('.tree-deprel-text')).toHaveCount(10, { timeout: 15000 });
}

const word = (page, sentence, i) =>
  page.locator('.tree-svg').nth(sentence).locator('.tree-token-area').nth(i);

const centre = async (locator) => {
  const b = await locator.boundingBox();
  return [b.x + b.width / 2, b.y + b.height / 2];
};

const dragArcs = (page) => page.locator('.tree-drag-arc, .tree-drag-label').count();

// Nothing was written: the store still holds the seed after every write the
// page could have sent has had time to land.
async function nothingWritten(page) {
  await page.waitForTimeout(1200);
  expect(await stored()).toEqual(seeded);
}

test('an arc let go on another sentence writes nothing, then or on the next click', async ({
  page,
}) => {
  await open(page);
  const [ax, ay] = await centre(word(page, 1, 1)); // dog
  const [bx, by] = await centre(word(page, 0, 3)); // left
  await page.mouse.move(ax, ay);
  await page.mouse.down();
  await page.mouse.move(bx, by, { steps: 12 });
  await page.mouse.up();
  // The drag is over: nothing follows the pointer with no button held.
  await page.mouse.move(bx + 200, by - 40, { steps: 6 });
  await expect.poll(() => dragArcs(page)).toBe(0);
  await nothingWritten(page);

  // A click on the page above the sentences.
  const [cx, cy] = await centre(page.getByText(/^2 sentences$/));
  await page.mouse.click(cx, cy);
  await nothingWritten(page);

  // A click on a label of the sentence the drag began in opens it and moves
  // no word.
  const [lx, ly] = await centre(
    page
      .locator('.tree-svg')
      .nth(1)
      .locator('.tree-deprel-text', { hasText: /^punct/ }),
  );
  await page.mouse.click(lx, ly);
  await nothingWritten(page);
});

test('Escape drops the arc in the hand, and letting go writes nothing', async ({ page }) => {
  await open(page);
  const [ax, ay] = await centre(word(page, 0, 0)); // She
  const [bx, by] = await centre(word(page, 0, 4)); // .
  await page.mouse.move(ax, ay);
  await page.mouse.down();
  await page.mouse.move(bx, by, { steps: 10 });
  expect(await dragArcs(page)).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect.poll(() => dragArcs(page)).toBe(0);
  await page.mouse.up();
  await nothingWritten(page);
});
