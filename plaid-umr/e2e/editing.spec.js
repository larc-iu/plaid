import PlaidClient from '@larc-iu/plaid-client';
import {
  test,
  expect,
  seedAuth,
  readToken,
  collectClientErrors,
  cleanDiagnostics,
} from './fixtures.js';
import { getFixture } from './fixtureProject.js';
import { importUmrDocument } from '../src/domain/umrImport.js';
import { getUmrLayerInfo } from '../src/utils/umrLayerUtils.js';

// The editing gestures, on a document of their own so the fixture corpus
// stays as imported. One sentence, the AnCast sample.
const SAMPLE = `################################################################################
# :: snt1	Lindsay left in order to eat lunch .
Index: 1 2 3 4 5 6 7 8
Words: Lindsay left in order to eat lunch .

# sentence level graph:
(s1l / leave-02
    :ARG0 (s1p / person
        :name (s1n / name :op1 "Lindsay"))
    :aspect performance
    :purpose (s1e / eat-01 :ARG0 s1p :aspect performance))

# alignment:
s1l: 2-2
s1p: 1-1
s1n: 0-0
s1e: 6-6

# document level annotation:
(s1s0 / sentence
    :modal ((root :modal author)
        (author :full-affirmative s1l)))


`;

const API = 'http://localhost:8085';

async function makeDocument() {
  const { projectId } = await getFixture();
  const { token } = readToken();
  const client = new PlaidClient(API, token);
  const project = await client.projects.get(projectId);
  const name = `editing ${Date.now()}`;
  const { document } = await importUmrDocument(
    client,
    projectId,
    name,
    SAMPLE,
    getUmrLayerInfo(project),
  );
  return { projectId, documentId: document.id, client };
}

const editor = (page) => page.locator('.umr-inline-editor input');
const nodeByConcept = (page, concept) =>
  page
    .locator('.umr-node')
    .filter({ has: page.locator('.umr-node-concept', { hasText: concept }) });

test.describe('editing', () => {
  let ids;
  test.beforeAll(async () => {
    ids = await makeDocument();
  });
  test.afterAll(async () => {
    if (ids) await ids.client.documents.delete(ids.documentId);
  });

  test('adds, renames, attributes, deletes and drags', async ({ page }) => {
    await seedAuth(page);
    const diag = collectClientErrors(page);
    await page.goto(`/#/projects/${ids.projectId}/documents/${ids.documentId}/annotate`);
    const block = page.locator('.umr-block').first();
    await expect(block.locator('.umr-edge-label').first()).toBeVisible();

    // Tab from the root: word 7 (lunch) as :ARG1 of eat-01... from leave-02.
    const leave = nodeByConcept(page, 'leave-02');
    await leave.click();
    await page.keyboard.press('Tab');
    await expect(editor(page)).toBeVisible();
    await editor(page).fill('7');
    await page.keyboard.press('Enter');
    await expect(editor(page)).toBeVisible();
    await editor(page).fill('ARG1');
    await page.keyboard.press('Enter');
    const lunch = nodeByConcept(page, 'lunch');
    await expect(lunch).toBeVisible();
    await expect(block.locator('.umr-edge-label', { hasText: ':ARG1' })).toBeVisible();
    // The new node is anchored to the word and focused. Hover outranks
    // focus for the word highlight, so the pointer leaves the graph first.
    await expect(lunch).toHaveClass(/umr-node--focused/);
    await page.mouse.move(2, 2);
    await expect(block.locator('.umr-word--lit .umr-word-text')).toHaveText('lunch');

    // Enter opens the concept with the frame file's senses of the word first.
    await page.keyboard.press('Enter');
    await expect(page.locator('[role="option"]', { hasText: /^lunch-01 ARG/ })).toBeVisible();
    await editor(page).fill('lunch-01');
    await page.keyboard.press('Enter');
    await expect(nodeByConcept(page, 'lunch-01')).toBeVisible();

    // `a` sets the attributes as one line.
    await page.keyboard.press('a');
    await editor(page).fill(':aspect state :refer-number singular');
    await page.keyboard.press('Enter');
    await expect(nodeByConcept(page, 'lunch-01').locator('.umr-chip')).toHaveCount(2);

    // Shift+Backspace deletes the edge and the leaf it reached, no question.
    await page.keyboard.press('Shift+Backspace');
    await expect(nodeByConcept(page, 'lunch-01')).toHaveCount(0);
    await expect(leave).toHaveClass(/umr-node--focused/);

    // Drag the grip of eat-01 onto the word "lunch": a new anchored child.
    const eat = nodeByConcept(page, 'eat-01');
    await eat.hover();
    const grip = eat.locator('.umr-grip');
    const gripBox = await grip.boundingBox();
    const word = block.locator('.umr-word').nth(6);
    const wordBox = await word.boundingBox();
    await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(wordBox.x + wordBox.width / 2, wordBox.y + wordBox.height / 2, {
      steps: 8,
    });
    await expect(word).toHaveClass(/umr-word--drop/);
    await page.mouse.up();
    await expect(editor(page)).toHaveValue('lunch');
    // The list opens under the pointer, and a hovered option is the one Enter
    // takes, so the pointer leaves first.
    await page.mouse.move(2, 2);
    await page.keyboard.press('Enter');
    // The role editor lists the parent's own arguments first.
    await expect(page.locator('[role="option"]', { hasText: /^:ARG1 / }).first()).toBeVisible();
    await editor(page).fill(':ARG1');
    await page.keyboard.press('Enter');
    await expect(nodeByConcept(page, 'lunch')).toBeVisible();

    // Validation marks: the corpus sentence has no :temporal for its events,
    // so the header counts problems and a node wears a mark.
    await expect(block.locator('.umr-problems-toggle')).toBeVisible();
    await block.locator('.umr-problems-toggle').click();
    await expect(block.locator('.umr-problem').first()).toBeVisible();
    await expect(block.locator('.umr-node-mark').first()).toBeVisible();
    await block.locator('.umr-problems-toggle').click();

    // Text mode: the graph as PENMAN, a node added by typing, applied as one.
    await block.locator('.umr-text-toggle').click();
    const area = block.locator('textarea.umr-penman-text');
    await expect(area).toHaveValue(/^\(s1l \/ leave-02/);
    const typed = (await area.inputValue()).replace(
      ':purpose (s1e / eat-01',
      ':purpose (s1e / eat-01 :time (s1t / today)',
    );
    await area.fill(typed);
    await expect(block.locator('.umr-penman-status')).toContainText('Changed');
    await block.getByRole('button', { name: 'Apply' }).click();
    await expect(nodeByConcept(page, 'today')).toBeVisible();
    await expect(block.locator('.umr-edge-label', { hasText: ':time' })).toBeVisible();
    await block.screenshot({ path: process.env.UMR_EDIT_SHOT || 'test-results/editing.png' });

    // The document lane. `o` on a node: a conceiver, then a modal relation,
    // drawn to the pinned constant in the margin.
    await nodeByConcept(page, 'today').click();
    await page.keyboard.press('o');
    await editor(page).fill('author');
    await page.keyboard.press('Enter');
    await editor(page).fill(':full-affirmative');
    await page.keyboard.press('Enter');
    // The sample already draws one to leave-02; today's makes two.
    await expect(block.locator('.umr-doc-label', { hasText: ':full-affirmative' })).toHaveCount(2);
    await expect(block.locator('.umr-const--used', { hasText: 'author' })).toBeVisible();
    // `c`: coreference with another node, a chain chip on both.
    await nodeByConcept(page, 'lunch').click();
    await page.keyboard.press('c');
    await editor(page).fill('s1p');
    await page.keyboard.press('Enter');
    await editor(page).fill(':same-entity');
    await page.keyboard.press('Enter');
    await expect(block.locator('.umr-chain')).toHaveCount(2);
    // Dragging the grip of eat-01 onto document-creation-time: a temporal one.
    const eat2 = nodeByConcept(page, 'eat-01');
    await eat2.hover();
    const grip2 = await eat2.locator('.umr-grip').boundingBox();
    const dct = block.locator('[data-const-name="document-creation-time"]');
    const dctBox = await dct.boundingBox();
    await page.mouse.move(grip2.x + grip2.width / 2, grip2.y + grip2.height / 2);
    await page.mouse.down();
    await page.mouse.move(dctBox.x + dctBox.width / 2, dctBox.y + dctBox.height / 2, { steps: 8 });
    await expect(dct).toHaveClass(/umr-const--drop/);
    await page.mouse.up();
    await page.mouse.move(2, 2);
    await editor(page).fill(':before');
    await page.keyboard.press('Enter');
    await expect(block.locator('.umr-doc-label', { hasText: ':before' })).toBeVisible();
    await block.screenshot({ path: process.env.UMR_LANE_SHOT || 'test-results/lane.png' });

    // Every write landed.
    const clean = cleanDiagnostics(diag);
    expect(clean.failures, JSON.stringify(clean.failures, null, 2)).toEqual([]);
    expect(clean.errors, JSON.stringify(clean.errors, null, 2)).toEqual([]);

    // The export says the same.
    await page.goto(`/#/projects/${ids.projectId}/documents/${ids.documentId}/export`);
    await expect(page.locator('pre, textarea').first()).toContainText(':ARG1 (s1l2 / lunch)');
    await expect(page.locator('pre, textarea').first()).toContainText(':time (s1t / today)');
    await expect(page.locator('pre, textarea').first()).toContainText(
      '(author :full-affirmative s1t)',
    );
    await expect(page.locator('pre, textarea').first()).toContainText(
      ':coref ((s1l2 :same-entity s1p))',
    );
    await expect(page.locator('pre, textarea').first()).toContainText(
      '(document-creation-time :before s1e)',
    );
  });
});
