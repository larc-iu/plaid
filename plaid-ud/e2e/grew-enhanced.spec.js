import { test, expect, seedAuth, readToken } from './fixtures.js';
import { PlaidClient } from '@larc-iu/plaid-client';
import { createUdProject } from '../src/domain/udProjectSetup.js';
import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { getUdLayerInfo } from '../src/utils/udLayerUtils.js';
import { isSuppressor } from '../src/domain/enhancedGraph.js';
import { parseAndCompile, readCounts } from '../src/grew/index.js';

// Grew over the enhanced graph, against the live core: what an `E:` label
// finds, what an unlabelled edge finds, and a rule that writes to the enhanced
// layer. The offline tests pin the compiled query. Only the server can say the
// query means what it was compiled to mean.

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5173';
const CONLLU = [
  // The enhanced graph already shares the subject here, and relabels `conj`
  // (a suppressor over the basic edge, plus the extra `conj:and`).
  '# text = she sang and danced',
  '1\tshe\tshe\tPRON\t_\t_\t2\tnsubj\t2:nsubj|4:nsubj\t_',
  '2\tsang\tsing\tVERB\t_\t_\t0\troot\t0:root\t_',
  '3\tand\tand\tCCONJ\t_\t_\t4\tcc\t4:cc\t_',
  '4\tdanced\tdance\tVERB\t_\t_\t2\tconj\t2:conj:and\t_',
  '',
  // Nothing enhanced here yet.
  '# text = he ran and fell',
  '1\the\the\tPRON\t_\t_\t2\tnsubj\t_\t_',
  '2\tran\trun\tVERB\t_\t_\t0\troot\t_\t_',
  '3\tand\tand\tCCONJ\t_\t_\t4\tcc\t_\t_',
  '4\tfell\tfall\tVERB\t_\t_\t2\tconj\t_\t_',
].join('\n');
const S = {};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const { token } = readToken();
  const client = new PlaidClient('http://localhost:8085', token);
  S.client = client;
  const project = await createUdProject(client, `Grew enhanced e2e ${Date.now()}`);
  S.projectId = project.id;
  const res = await ConlluDocument.importFromConllu(client, project.id, 'edeps-doc', CONLLU);
  S.docId = res.documentId;
});

test.afterAll(async () => {
  try {
    await S.client.projects.delete(S.projectId);
  } catch {
    /* best-effort */
  }
});

const fetchLayers = async () => getUdLayerInfo(await S.client.documents.get(S.docId, true));
const lemmaId = (li, lemma) => (li.lemmaLayer.spans || []).find((s) => s.value === lemma)?.id;

const openSearch = async (page) => {
  await seedAuth(page);
  await page.goto(`${BASE}/#/projects/${S.projectId}/search`);
  const box = page.getByPlaceholder(/pattern \{/);
  await expect(box).toBeVisible();
  return box;
};
const search = async (page, box, pattern) => {
  await box.fill(pattern);
  await page.getByRole('button', { name: 'Search', exact: true }).last().click();
};

test('an E: label finds the extra edges, and a plain one does not', async ({ page }) => {
  const box = await openSearch(page);
  await search(page, box, 'pattern { V -[E:nsubj]-> S }');
  await expect(page.getByText('1 matching sentence', { exact: false })).toBeVisible();
  await expect(page.locator('mark', { hasText: 'danced' })).toBeVisible();

  // The tree has one nsubj a sentence, and the plain label reads the tree.
  await search(page, box, 'pattern { V [lemma="dance"]; V -[nsubj]-> S }');
  await expect(page.getByText('No matching sentences.')).toBeVisible();
});

test('an unlabelled edge reads both graphs, and no suppressor', async ({ page }) => {
  const box = await openSearch(page);
  // Only the extra edge joins these two.
  await search(page, box, 'pattern { V [lemma="dance"]; S [lemma="she"]; V -> S }');
  await expect(page.getByText('1 matching sentence', { exact: false })).toBeVisible();

  // sang to danced: the basic conj and the extra conj:and, and NOT the
  // suppressor lying over the same pair, which the page cannot tell apart from
  // them (one sentence either way). So ask the server for the edges themselves.
  const li = await fetchLayers();
  const { query } = parseAndCompile(
    'pattern { V [lemma="sing"]; W [lemma="dance"]; e: V -> W }',
    li,
    { projectId: S.projectId },
  );
  const hits = await S.client.query(query);
  const labels = hits.results.map((row) => row.find((e) => e?.source)?.value);
  expect(labels.sort()).toEqual(['conj', 'conj:and']);

  // Counted by label, the extra edge is named as a request names it.
  const counted = parseAndCompile('pattern { e: V -> W }', li, {
    projectId: S.projectId,
    countBy: { node: 'e', field: 'label' },
  });
  const counts = readCounts((await S.client.query(counted.query)).results, li);
  const byLabel = Object.fromEntries(counts.map((c) => [c.value, c.count]));
  expect(byLabel).toMatchObject({ conj: 2, 'E:conj:and': 1, nsubj: 2, 'E:nsubj': 1 });

  await search(page, box, 'pattern { V [lemma="sing"]; W [lemma="dance"]; e: V -> W }');
  await expect(page.getByText('1 matching sentence', { exact: false })).toBeVisible();

  // An edge that reads both graphs, inside a `without`: "she" is a subject
  // of "danced" only in the enhanced graph, and "he" of "fell" in neither.
  await search(
    page,
    box,
    'pattern { X [upos=PRON] } without { Y [lemma="dance"|"fall"]; Y -[1=nsubj]-> X }',
  );
  await expect(page.getByText('1 matching sentence', { exact: false })).toBeVisible();
  await expect(page.locator('mark', { hasText: 'he' })).toBeVisible();

  // A `without` that names both graphs leaves the verb nobody is subject of.
  await search(page, box, 'pattern { V -[conj]-> W } without { W -[nsubj|E:nsubj]-> S }');
  await expect(page.getByText('1 matching sentence', { exact: false })).toBeVisible();
  await expect(page.locator('mark', { hasText: 'fell' })).toBeVisible();
});

test('a rule shares the subject, in the enhanced layer', async ({ page }) => {
  const box = await openSearch(page);
  await box.fill(
    [
      'pattern { V1 -[conj]-> V2; V1 -[nsubj]-> S }',
      'without { V2 -[E:nsubj]-> S }',
      'commands { add_edge V2 -[E:nsubj]-> S }',
    ].join('\n'),
  );
  await page.getByRole('button', { name: 'Preview changes' }).click();
  // The first sentence has the edge already, so the search never offers it.
  await expect(page.getByText('1 sentence in 1 document, 1 selected')).toBeVisible();
  await expect(page.getByText('fell → he: E:nsubj added')).toBeVisible();

  await page.getByRole('button', { name: 'Apply 1 change' }).click();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByText('Changed 1 sentence in 1 document.')).toBeVisible();
  await expect(page.getByText('No sentences to change.')).toBeVisible();

  const li = await fetchLayers();
  const added = li.enhancedRelationLayer.relations.find(
    (r) => r.source === lemmaId(li, 'fall') && r.target === lemmaId(li, 'he'),
  );
  expect(added?.value).toBe('nsubj');
  // The tree is as it was: one nsubj for "he", from "ran".
  const basic = li.relationLayer.relations.filter((r) => r.target === lemmaId(li, 'he'));
  expect(basic.map((r) => r.value)).toEqual(['nsubj']);
});

test('a rule that relabels in the enhanced graph suppresses the tree edge, and DEPS says so', async ({
  page,
}) => {
  const box = await openSearch(page);
  await box.fill(
    'pattern { V [lemma="fall"]; V -[cc]-> C } without { V -[E:cc:and]-> C } commands { add_edge V -[E:cc:and]-> C }',
  );
  await page.getByRole('button', { name: 'Preview changes' }).click();
  await expect(page.getByText('fell → and: cc left out of the enhanced graph')).toBeVisible();
  await page.getByRole('button', { name: 'Apply 1 change' }).click();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByText('Changed 1 sentence in 1 document.')).toBeVisible();

  const doc = await ConlluDocument.load(S.client, S.projectId, S.docId);
  // Both sentences have an "and" row. The rule named the second one's verb.
  const row = doc
    .toConllu()
    .split('\n')
    .filter((l) => l.startsWith('3\tand\t'))
    .at(-1);
  expect(row.split('\t').slice(6, 8)).toEqual(['4', 'cc']);
  // The tree keeps cc, and the enhanced graph has cc:and in its place.
  expect(row.split('\t')[8]).toBe('4:cc:and');
});

test('a rule that removes a suppressed basic edge takes the suppressor with it', async ({
  page,
}) => {
  const before = await fetchLayers();
  // One from the import (conj relabelled conj:and) and one from the rule above.
  expect(before.enhancedRelationLayer.relations.filter(isSuppressor)).toHaveLength(2);

  const box = await openSearch(page);
  await box.fill('pattern { V [lemma="sing"]; e: V -[conj]-> W } commands { del_edge e }');
  await page.getByRole('button', { name: 'Preview changes' }).click();
  await expect(page.getByText('sang → danced: conj removed')).toBeVisible();
  await page.getByRole('button', { name: 'Apply 1 change' }).click();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByText('Changed 1 sentence in 1 document.')).toBeVisible();

  const li = await fetchLayers();
  expect(li.enhancedRelationLayer.relations.filter(isSuppressor)).toHaveLength(1);
  // The extra conj:and is the graph's own edge and stays.
  const extras = li.enhancedRelationLayer.relations.filter((r) => !isSuppressor(r));
  expect(extras.map((r) => r.value).sort()).toEqual(['cc:and', 'conj:and', 'nsubj', 'nsubj']);
});
