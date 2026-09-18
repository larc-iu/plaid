import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

    // Enter renames the concept.
    await page.keyboard.press('Enter');
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
    await page.keyboard.press('Enter');
    await editor(page).fill(':ARG1');
    await page.keyboard.press('Enter');
    await expect(nodeByConcept(page, 'lunch')).toBeVisible();

    // The export says the same.
    await page.goto(`/#/projects/${ids.projectId}/documents/${ids.documentId}/export`);
    await expect(page.locator('pre, textarea').first()).toContainText(':ARG1 (s1l2 / lunch)');

    const clean = cleanDiagnostics(diag);
    expect(clean.failures, JSON.stringify(clean.failures, null, 2)).toEqual([]);
    expect(clean.errors, JSON.stringify(clean.errors, null, 2)).toEqual([]);
  });
});
