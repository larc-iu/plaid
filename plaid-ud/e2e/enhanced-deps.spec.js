// Enhanced dependencies, end to end against the live core:
//   - A maintainer enables them on the UD Customization page.
//   - Ctrl+drag adds an edge to the enhanced graph and leaves the tree alone.
//   - Ctrl+drag over a relation of the tree relabels it there.
//   - Ctrl+click leaves a relation of the tree out of the graph, and back.
//   - The export's DEPS column states the graph.
// Seeds 'she came and left': root(came), nsubj(came->she), cc(left->and),
// conj(came->left). Relations store source=head, target=dependent.
import { test, expect, seedAuth } from './fixtures.js';
import { seedUdDoc } from './seedUdDoc.js';
import { getUdLayerInfo } from '../src/utils/udLayerUtils.js';

const S = {};
const BODY = 'she came and left';
const WORDS = [
  [0, 3],
  [4, 8],
  [9, 12],
  [13, 17],
];

test.beforeAll(async () => {
  Object.assign(S, await seedUdDoc(`Enhanced deps ${Date.now()}`, BODY, WORDS));
  const { client, layers, morphIds } = S;
  const lemma = {};
  for (const [i, value] of ['she', 'come', 'and', 'leave'].entries()) {
    lemma[value] = (await client.spans.create(layers.lemma, [morphIds[i]], value)).id;
  }
  await client.relations.create(layers.relation, lemma.come, lemma.come, 'root');
  await client.relations.create(layers.relation, lemma.come, lemma.she, 'nsubj');
  await client.relations.create(layers.relation, lemma.leave, lemma.and, 'cc');
  await client.relations.create(layers.relation, lemma.come, lemma.leave, 'conj');
});

test.afterAll(async () => {
  if (S.client && S.projectId) {
    await S.client.projects
      .delete(S.projectId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

// The tests build on one another: the project is enabled once and the graph
// grows from there.
test.describe.configure({ mode: 'serial' });

const enhancedRows = async () => {
  const doc = await S.client.documents.get(S.documentId, true);
  return getUdLayerInfo(doc).enhancedRelationLayer?.relations || [];
};

async function openGrid(page, labels) {
  await seedAuth(page);
  await page.goto(`/#/projects/${S.projectId}/documents/${S.documentId}/annotate`);
  await expect(page.locator('.tree-deprel-text')).toHaveCount(labels, { timeout: 15000 });
}

// A label's text runs on into its <title> (the tooltip), so the match ends at
// the label's own last character rather than at the end of the string.
const label = (page, value) =>
  page.locator('.tree-deprel-text', { hasText: new RegExp(`^${value}(?![:a-z])`) });

// Ctrl+drag from one word's grab area in the tree to another's.
async function enhancedDrag(page, from, to) {
  const areas = page.locator('.tree-token-area');
  const a = await areas.nth(from).boundingBox();
  const b = await areas.nth(to).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.keyboard.down('Control');
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Control');
}

test('a maintainer enables enhanced dependencies for the project', async ({ page }) => {
  await seedAuth(page);
  await page.goto(`/#/projects/${S.projectId}/customization`);
  const enable = page.getByRole('button', { name: 'Enable', exact: true });
  await enable.click();
  await expect(page.getByText('Enabled', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(enable).toHaveCount(0);

  const project = await S.client.projects.get(S.projectId);
  expect(getUdLayerInfo(project).enhancedRelationLayer).toBeTruthy();
  // The tree's own layer is still the only one that answers to `dependency`.
  expect(getUdLayerInfo(project).relationLayer.id).toBe(S.layers.relation);
});

test('Ctrl+drag gives a word a second head without touching its tree', async ({ page }) => {
  await openGrid(page, 4);
  await enhancedDrag(page, 3, 0); // left -> she

  // A fifth label, and the one double arc.
  await expect(page.locator('.tree-deprel-text')).toHaveCount(5);
  await expect(page.locator('.tree-arc-core')).toHaveCount(1);
  // It took the label she already has as a dependent, which is what a shared
  // subject wants.
  await expect(label(page, 'nsubj')).toHaveCount(2);

  const rows = await enhancedRows();
  expect(rows.map((r) => r.value)).toEqual(['nsubj']);
  const doc = await S.client.documents.get(S.documentId, true);
  expect(getUdLayerInfo(doc).relationLayer.relations).toHaveLength(4);
});

test('Ctrl+drag over a relation of the tree relabels it in the graph', async ({ page }) => {
  await openGrid(page, 5);
  await enhancedDrag(page, 1, 3); // came -> left, which the tree joins as conj

  // Nothing is written yet: the tree's label opens to take the new one.
  const editor = page.locator('foreignObject input');
  await expect(editor).toHaveValue('conj');
  expect(await enhancedRows()).toHaveLength(1);

  await editor.fill('conj:and');
  await page.keyboard.press('Enter');

  await expect(label(page, 'conj:and')).toHaveCount(1);
  await expect(label(page, 'conj')).toHaveClass(/tree-deprel-text--suppressed/);
  await expect(page.locator('.tree-arc-core')).toHaveCount(2);
  await expect
    .poll(async () => (await enhancedRows()).map((r) => r.value ?? 'SUPPRESS').sort())
    .toEqual(['SUPPRESS', 'conj:and', 'nsubj']);
});

test('Ctrl+click leaves a relation of the tree out of the graph, and puts it back', async ({
  page,
}) => {
  await openGrid(page, 6);
  await label(page, 'cc').click({ modifiers: ['Control'] });
  await expect(label(page, 'cc')).toHaveClass(/tree-deprel-text--suppressed/);
  // No editor opened: the modifier made it a different gesture.
  await expect(page.locator('foreignObject input')).toHaveCount(0);
  await expect.poll(async () => (await enhancedRows()).length).toBe(4);

  await label(page, 'cc').click({ modifiers: ['Control'] });
  await expect(label(page, 'cc')).not.toHaveClass(/tree-deprel-text--suppressed/);
  await expect.poll(async () => (await enhancedRows()).length).toBe(3);
});

test('the export states the enhanced graph in DEPS', async ({ page }) => {
  await seedAuth(page);
  await page.goto(`/#/projects/${S.projectId}/documents/${S.documentId}/export`);
  const out = page.locator('pre, textarea').first();
  await expect(out).toContainText('2:nsubj|4:nsubj', { timeout: 15000 });
  await expect(out).toContainText('2:conj:and');
  await expect(out).toContainText('4:cc');
});
