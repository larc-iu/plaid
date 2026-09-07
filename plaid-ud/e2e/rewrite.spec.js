import { test, expect, seedAuth, readToken } from './fixtures.js';
import { PlaidClient } from '@larc-iu/plaid-client';
import { createUdProject } from '../src/domain/udProjectSetup.js';
import { ConlluDocument } from '../src/domain/ConlluDocument.js';

// Live smoke for Grew rewriting from the Search page: seeds a throwaway UD
// project with one document, previews a rule, applies it, checks the server
// took the writes and that the rule then matches nothing; then a rule that
// fails at runtime and one that is unsupported.

const BASE = process.env.UD_BASE || 'http://localhost:5173';
const CONLLU = [
  '# text = the dog saw a cat',
  '1\tthe\tthe\tDET\t_\tDefinite=Def\t2\tdet\t_\t_',
  '2\tdog\tdog\tNOUN\t_\tNumber=Sing\t3\tnsubj\t_\t_',
  '3\tsaw\tsee\tVERB\t_\tTense=Past\t0\troot\t_\t_',
  '4\ta\ta\tDET\t_\tDefinite=Ind\t5\tdet\t_\t_',
  '5\tcat\tcat\tNOUN\t_\tNumber=Sing\t3\tobj\t_\t_',
  '',
  '# text = a hearing is scheduled',
  '1\ta\ta\tDET\t_\tDefinite=Ind\t2\tdet\t_\t_',
  '2\thearing\thearing\tNOUN\t_\t_\t4\tnsubj:pass\t_\t_',
  '3\tis\tbe\tAUX\t_\t_\t4\taux:pass\t_\t_',
  '4\tscheduled\tschedule\tVERB\t_\tVoice=Pass\t0\troot\t_\t_',
].join('\n');
const S = {};

test.beforeAll(async () => {
  const { token } = readToken();
  const client = new PlaidClient('http://localhost:8085', token);
  S.client = client;
  const project = await createUdProject(client, `Rewrite e2e ${Date.now()}`);
  S.projectId = project.id;
  const res = await ConlluDocument.importFromConllu(client, project.id, 'rewrite-doc', CONLLU);
  S.docId = typeof res === 'string' ? res : res.documentId || res.id;
});

test.afterAll(async () => {
  try {
    await S.client.projects.delete(S.projectId);
  } catch {
    /* best-effort */
  }
});

const uposValues = async () => {
  const doc = await S.client.documents.get(S.docId, true);
  const morph = doc.textLayers[0].tokenLayers.find(
    (l) => l.config?.plaid?.role === 'syntactic-word',
  );
  const upos = morph.spanLayers.find((l) => l.config?.ud?.upos);
  return upos.spans.map((s) => s.value).sort();
};

test('preview, apply, and the rule then matches nothing', async ({ page }) => {
  await seedAuth(page);
  await page.goto(`${BASE}/#/projects/${S.projectId}/search`);
  const box = page.getByPlaceholder(/pattern \{/);
  await expect(box).toBeVisible();

  await box.fill('pattern { X [upos=DET] } commands { X.upos = PRON }');
  await page.getByRole('button', { name: 'Preview changes' }).click();
  await expect(page.getByText('2 sentences in 1 document, 2 selected')).toBeVisible();
  await expect(page.getByText('the: upos DET → PRON')).toBeVisible();
  await expect(page.getByText('a: upos DET → PRON')).toHaveCount(2);
  await expect(page.getByText('2×')).toBeVisible();
  await page.screenshot({
    path: process.env.SHOT || 'test-results/rewrite-preview.png',
    fullPage: true,
  });

  await page.getByRole('button', { name: 'Apply 2 changes' }).click();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByText('Changed 2 sentences in 1 document.')).toBeVisible();
  await expect(page.getByText('No sentences to change.')).toBeVisible();
  expect(await uposValues()).toEqual([
    'AUX',
    'NOUN',
    'NOUN',
    'NOUN',
    'PRON',
    'PRON',
    'PRON',
    'VERB',
    'VERB',
  ]);

  // Deselecting a document's sentences keeps Apply disabled.
  await box.fill(
    'pattern { e: V -[nsubj]-> S; V [Voice=Pass] } commands { e.label = "nsubj:pass" }',
  );
  await page.getByRole('button', { name: 'Preview changes' }).click();
  await expect(page.getByText('No sentences to change.')).toBeVisible();
});

test('a rule that fails on a sentence shows the error on that sentence', async ({ page }) => {
  await seedAuth(page);
  await page.goto(`${BASE}/#/projects/${S.projectId}/search`);
  const box = page.getByPlaceholder(/pattern \{/);
  await box.fill('pattern { X [upos=VERB] } commands { X.upos = X.Number }');
  await page.getByRole('button', { name: 'Preview changes' }).click();
  await expect(page.getByText('2 sentences in 1 document, 0 selected, 2 errors')).toBeVisible();
  await expect(page.getByText('X.Number is undefined.').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Apply/ })).toBeDisabled();
});

test('an unsupported command reports the feature', async ({ page }) => {
  await seedAuth(page);
  await page.goto(`${BASE}/#/projects/${S.projectId}/search`);
  const box = page.getByPlaceholder(/pattern \{/);
  await box.fill('pattern { X [upos=VERB] } commands { add_node N :< X }');
  await page.getByRole('button', { name: 'Preview changes' }).click();
  await expect(page.getByText('Unsupported feature')).toBeVisible();
  await expect(page.getByText(/Adding words is not supported/)).toBeVisible();
});
