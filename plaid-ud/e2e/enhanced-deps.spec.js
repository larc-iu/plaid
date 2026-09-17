// Enhanced dependencies, end to end against the live core:
//   - A new project has the enhanced relation layer, and one without it is
//     given it when a maintainer opens a document.
//   - Ctrl+drag adds an edge to the enhanced graph and leaves the tree alone.
//   - Ctrl+drag over a relation of the tree relabels it there.
//   - Ctrl+click leaves a relation of the tree out of the graph, and back.
//   - The export's DEPS column states the graph.
// Seeds 'she came and left': root(came), nsubj(came->she), cc(left->and),
// conj(came->left). Relations store source=head, target=dependent.
import { test, expect, seedAuth } from './fixtures.js';
import { seedUdDoc } from './seedUdDoc.js';
import { getUdLayerInfo } from '../src/utils/udLayerUtils.js';
import { ConlluDocument } from '../src/domain/ConlluDocument.js';

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

// The tests build on one another: the graph grows from one to the next.
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

test('a new project has the layer, and an older one is given it on open', async ({ page }) => {
  const made = getUdLayerInfo(await S.client.projects.get(S.projectId));
  expect(made.enhancedRelationLayer).toBeTruthy();
  // The tree's own layer is still the only one that answers to `dependency`.
  expect(made.relationLayer.id).toBe(S.layers.relation);

  // A project from before the layer existed: take it away, and a maintainer
  // opening a document puts it back.
  await S.client.relationLayers.delete(made.enhancedRelationLayer.id);
  await openGrid(page, 4);
  await expect
    .poll(async () =>
      Boolean(getUdLayerInfo(await S.client.projects.get(S.projectId)).enhancedRelationLayer),
    )
    .toBe(true);
});

test('Ctrl+drag gives a word a second head without touching its tree', async ({ page }) => {
  await openGrid(page, 4);
  await enhancedDrag(page, 3, 0); // left -> she

  // A fifth label, and the one arc under the words.
  await expect(page.locator('.tree-deprel-text')).toHaveCount(5);
  await expect(page.locator('.enhanced-arc-path')).toHaveCount(1);
  // It hangs under the words, in room the grid has made for it: below the word
  // row, and above the LEMMA row.
  const band = await page.locator('.enhanced-arcs').boundingBox();
  const word = await page.locator('.token-form').first().boundingBox();
  const lemma = await page.locator('.row-label', { hasText: 'LEMMA' }).first().boundingBox();
  expect(band.y).toBeGreaterThanOrEqual(word.y + word.height - 1);
  expect(band.y + band.height).toBeLessThanOrEqual(lemma.y + 1);
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
  await expect(page.locator('.enhanced-arc-path')).toHaveCount(2);
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

// A relabel abandoned by clicking elsewhere must not stay armed: the next plain
// edit of that label belongs to the tree.
test('an abandoned relabel does not capture the next plain edit', async ({ page }) => {
  await openGrid(page, 6);
  await enhancedDrag(page, 3, 2); // left -> and, which the tree joins as cc
  const editor = page.locator('foreignObject input');
  await expect(editor).toHaveValue('cc');

  // Walk away from it by pressing on another word, then clear the selection
  // that press began.
  const she = await page.locator('.tree-token-area').nth(0).boundingBox();
  await page.mouse.click(she.x + she.width / 2, she.y + she.height / 2);
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);

  await label(page, 'cc').click();
  await expect(editor).toHaveValue('cc');
  await editor.fill('cc:preconj');
  await page.keyboard.press('Enter');

  // The tree took it. Nothing was added to the enhanced graph.
  await expect(label(page, 'cc:preconj')).toHaveCount(1);
  await expect(label(page, 'cc:preconj')).not.toHaveClass(/tree-deprel-text--suppressed/);
  await expect(page.locator('.enhanced-arc-path')).toHaveCount(2);
  const doc = await S.client.documents.get(S.documentId, true);
  const info = getUdLayerInfo(doc);
  expect(info.relationLayer.relations.map((r) => r.value)).toContain('cc:preconj');
  expect(info.enhancedRelationLayer.relations).toHaveLength(3);
});

// Against the real server, because the offline import tests once passed a
// write it refuses: both layers' relations in one bulk create is a 400.
test('an import reads DEPS into the enhanced layer', async () => {
  const row = (...cols) => cols.join('\t');
  const conllu = [
    '# text = Mary wants to go',
    row(1, 'Mary', 'Mary', 'PROPN', '_', '_', 2, 'nsubj', '2:nsubj|4:nsubj:xsubj', '_'),
    row(2, 'wants', 'want', 'VERB', '_', '_', 0, 'root', '0:root', '_'),
    row(3, 'to', 'to', 'PART', '_', '_', 4, 'mark', '4:mark', '_'),
    row(4, 'go', 'go', 'VERB', '_', '_', 2, 'xcomp', '2:xcomp:to', '_'),
  ].join('\n');
  const out = await ConlluDocument.importFromConllu(S.client, S.projectId, 'Imported', conllu);
  expect(out.importWarnings).toEqual([]);

  const info = getUdLayerInfo(await S.client.documents.get(out.documentId, true));
  expect(info.relationLayer.relations).toHaveLength(4);
  expect(info.enhancedRelationLayer.relations.map((r) => r.value ?? 'SUPPRESS').sort()).toEqual([
    'SUPPRESS',
    'nsubj:xsubj',
    'xcomp:to',
  ]);
  const text = new ConlluDocument({
    raw: await S.client.documents.get(out.documentId, true),
  }).toConllu();
  expect(text).toContain('2:nsubj|4:nsubj:xsubj');
  expect(text).toContain('\t2\txcomp\t2:xcomp:to\t');
});

// The bin beside an open label deletes the relation, for whoever has not
// learned Shift+Delete, and its tooltip is where they learn it.
test('the bin beside an open label deletes the relation', async ({ page }) => {
  await openGrid(page, 6);
  await page.locator('.enhanced-arcs .tree-deprel-text', { hasText: /^nsubj/ }).click();
  const bin = page.locator('.deprel-edit-delete');
  await expect(bin).toHaveAttribute('title', 'Delete (Shift+Delete)');
  // To the LEFT of the input, which keeps the label's place over its arc.
  const binBox = await bin.boundingBox();
  const inputBox = await page.locator('foreignObject input').boundingBox();
  expect(binBox.x + binBox.width).toBeLessThanOrEqual(inputBox.x);

  await bin.click();
  await expect(page.locator('foreignObject input')).toHaveCount(0);
  await expect(page.locator('.enhanced-arc-path')).toHaveCount(1);
  await expect
    .poll(async () => (await enhancedRows()).map((r) => r.value ?? 'SUPPRESS').sort())
    .toEqual(['SUPPRESS', 'conj:and']);

  // A relabel in progress has nothing to delete, so it offers no bin.
  await enhancedDrag(page, 3, 2); // left -> and, which the tree joins as cc
  await expect(page.locator('foreignObject input')).toHaveValue(/^cc/);
  await expect(bin).toHaveCount(0);
  await page.keyboard.press('Escape');
});
