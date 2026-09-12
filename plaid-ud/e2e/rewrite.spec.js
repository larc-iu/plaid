import { test, expect, seedAuth, readToken } from './fixtures.js';
import { PlaidClient } from '@larc-iu/plaid-client';
import { createUdProject } from '../src/domain/udProjectSetup.js';
import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { getUdLayerInfo } from '../src/utils/udLayerUtils.js';

// Live smoke for Grew rewriting from the Search page, against the dev core.
// Seeds a throwaway UD project with one document, then in order:
//   1. a feature rewrite: preview, apply, the server took it, the rule then
//      matches nothing;
//   2. the structural commands: del_node, shift (an endpoint move), and an
//      add_edge onto a word with no Lemma span (it is created first);
//   3. a document changed between preview and apply is refused (409) and
//      nothing in it is written;
//   4. a runtime error shows on its sentence; an unsupported command reports.

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5173';
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
  '',
  // "today" has no lemma AND no place in the tree, so the import gives it no
  // Lemma span at all: a rule that hands IT an edge is what needs one created
  // first. (A word with no lemma but a head, like "hat" before c51b9579, gets
  // a null-valued span on import, because a relation hangs off one.)
  '# text = she saw a cat with a hat today',
  '1\tshe\tshe\tPRON\t_\t_\t2\tnsubj\t_\t_',
  '2\tsaw\tsee\tVERB\t_\t_\t0\troot\t_\t_',
  '3\ta\ta\tDET\t_\t_\t4\tdet\t_\t_',
  '4\tcat\tcat\tNOUN\t_\t_\t2\tobj\t_\t_',
  '5\twith\twith\tADP\t_\t_\t7\tcase\t_\t_',
  '6\ta\ta\tDET\t_\t_\t7\tdet\t_\t_',
  '7\that\that\tNOUN\t_\t_\t4\tnmod\t_\t_',
  '8\ttoday\t_\tADV\t_\t_\t_\t_\t_\t_',
].join('\n');
const S = {};

test.beforeAll(async () => {
  const { token } = readToken();
  const client = new PlaidClient('http://localhost:8085', token);
  S.client = client;
  const project = await createUdProject(client, `Rewrite e2e ${Date.now()}`);
  S.projectId = project.id;
  const res = await ConlluDocument.importFromConllu(client, project.id, 'rewrite-doc', CONLLU);
  S.docId = res.documentId;
});

test.afterAll(async () => {
  try {
    await S.client.projects.delete(S.projectId);
  } catch {
    /* best-effort */
  }
});

// The document as the server has it now, with its layers bound.
const fetchDoc = async () => {
  const raw = await S.client.documents.get(S.docId, true);
  return { raw, li: getUdLayerInfo(raw) };
};
const spanValues = (layer) => (layer?.spans || []).map((s) => s.value).sort();
const wordForms = (li) => {
  const body = li.textLayer.text.body;
  return (li.wordTokenLayer.tokens || [])
    .slice()
    .sort((a, b) => a.begin - b.begin)
    .map((t) => Array.from(body).slice(t.begin, t.end).join(''));
};
const lemmaSpanOf = (li, lemma) => (li.lemmaLayer.spans || []).find((s) => s.value === lemma);

const openSearch = async (page) => {
  await seedAuth(page);
  await page.goto(`${BASE}/#/projects/${S.projectId}/search`);
  const box = page.getByPlaceholder(/pattern \{/);
  await expect(box).toBeVisible();
  return box;
};
const preview = async (page, box, rule) => {
  await box.fill(rule);
  await page.getByRole('button', { name: 'Preview changes' }).click();
};
const applyAll = async (page, n) => {
  await page.getByRole('button', { name: `Apply ${n} change${n === 1 ? '' : 's'}` }).click();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
};

test('a feature rewrite: preview, apply, and the rule then matches nothing', async ({ page }) => {
  const box = await openSearch(page);
  await preview(page, box, 'pattern { X [upos=DET] } commands { X.upos = PRON }');
  await expect(page.getByText('3 sentences in 1 document, 3 selected')).toBeVisible();
  await expect(page.getByText('the: upos DET → PRON')).toBeVisible();
  await expect(page.getByText('a: upos DET → PRON')).toHaveCount(4);
  await expect(page.getByText('2×')).toHaveCount(2);

  await applyAll(page, 3);
  await expect(page.getByText('Changed 3 sentences in 1 document.')).toBeVisible();
  await expect(page.getByText('No sentences to change.')).toBeVisible();
  const { li } = await fetchDoc();
  expect(spanValues(li.uposLayer).filter((v) => v === 'DET')).toEqual([]);
  // One history entry for the whole rewrite, labelled by its rules.
  const audit = await S.client.documents.audit(S.docId);
  expect(audit.some((e) => e.message === 'Rewrite: rule')).toBe(true);
  // The five determiners plus "she".
  expect(spanValues(li.uposLayer).filter((v) => v === 'PRON')).toHaveLength(6);
});

test('structural commands: del_node, shift, and add_edge onto a word without a lemma', async ({
  page,
}) => {
  const box = await openSearch(page);
  await preview(
    page,
    box,
    [
      'rule attach { pattern { V [form="saw"]; H [form="today", !lemma] } commands { add_edge V -[advmod]-> H; H.lemma = "today" } }',
      'rule drop { pattern { D [form="the"] } commands { del_node D } }',
      'rule promote { pattern { V [form="saw"]; N [form="dog"]; V -[obj]-> * } commands { shift_out V =[obj]=> N } }',
    ].join('\n'),
  );
  await expect(page.getByText('2 sentences in 1 document, 2 selected')).toBeVisible();
  await expect(page.getByText('the: word deleted')).toBeVisible();
  await expect(page.getByText('obj of cat: head saw → dog')).toBeVisible();
  await expect(page.getByText('today: lemma (none) → today')).toBeVisible();
  await expect(page.getByText('saw → today: advmod added')).toBeVisible();

  await applyAll(page, 2);
  await expect(page.getByText('Changed 2 sentences in 1 document.')).toBeVisible();
  await expect(page.getByText('No sentences to change.')).toBeVisible();

  const { li } = await fetchDoc();
  // del_node took the surface token with it; the text is untouched.
  expect(wordForms(li)).not.toContain('the');
  expect(li.textLayer.text.body.startsWith('the dog')).toBe(true);
  // shift_out moved the obj relation's source onto "dog".
  const obj = li.relationLayer.relations.find(
    (r) => r.value === 'obj' && r.source === lemmaSpanOf(li, 'dog')?.id,
  );
  expect(obj).toBeTruthy();
  // add_edge created the lemma span first and hung the relation on it.
  const today = lemmaSpanOf(li, 'today');
  expect(today).toBeTruthy();
  const advmod = li.relationLayer.relations.find(
    (r) => r.value === 'advmod' && r.target === today.id,
  );
  expect(advmod).toBeTruthy();
  // There is a "saw" in two sentences; the source is one of their lemma spans.
  const saws = li.lemmaLayer.spans.filter((s) => s.value === 'see').map((s) => s.id);
  expect(saws).toContain(advmod.source);
});

test('a document changed between preview and apply is refused and left alone', async ({ page }) => {
  // Nouns: five, across all three sentences, whatever the earlier tests did.
  const box = await openSearch(page);
  await preview(page, box, 'pattern { X [upos=NOUN, !Seen] } commands { X.Seen = Yes }');
  await expect(page.getByText('3 sentences in 1 document, 3 selected')).toBeVisible();

  // Someone else annotates the document meanwhile.
  const { li } = await fetchDoc();
  const anyWord = li.morphemeTokenLayer.tokens[0];
  await S.client.spans.create(li.featuresLayer.id, [anyWord.id], 'Meanwhile=Yes');

  await applyAll(page, 3);
  await expect(
    page.getByText(
      'Stopped at rewrite-doc: it changed since the preview. Applied to 0 sentences in 0 documents.',
    ),
  ).toBeVisible();
  const after = await fetchDoc();
  expect(spanValues(after.li.featuresLayer)).not.toContain('Seen=Yes');
  // The preview re-ran against the fresh document, so Apply works now.
  await expect(page.getByText('3 sentences in 1 document, 3 selected')).toBeVisible();
  await applyAll(page, 3);
  await expect(page.getByText('Changed 3 sentences in 1 document.')).toBeVisible();
  const done = await fetchDoc();
  expect(spanValues(done.li.featuresLayer).filter((v) => v === 'Seen=Yes')).toHaveLength(5);
});

test('an inline lexicon supplies values, and narrows discovery', async ({ page }) => {
  const box = await openSearch(page);
  await preview(
    page,
    box,
    [
      'pattern { X [upos=NOUN, lemma=lex.noun, !Gender] } commands { X.Gender = lex.Gender }',
      '#BEGIN lex',
      'noun\tGender',
      'dog\tMasc',
      'cat\tFem',
      '#END',
    ].join('\n'),
  );
  await expect(page.getByText('2 sentences in 1 document, 2 selected')).toBeVisible();
  await expect(page.getByText('dog: Gender=Masc added')).toBeVisible();
  await expect(page.getByText('cat: Gender=Fem added')).toHaveCount(2);
  await applyAll(page, 2);
  await expect(page.getByText('Changed 2 sentences in 1 document.')).toBeVisible();
  const { li } = await fetchDoc();
  const feats = spanValues(li.featuresLayer);
  expect(feats.filter((v) => v === 'Gender=Masc')).toHaveLength(1);
  expect(feats.filter((v) => v === 'Gender=Fem')).toHaveLength(2);
});

test('a rule that fails on a sentence shows the error on that sentence', async ({ page }) => {
  const box = await openSearch(page);
  await preview(page, box, 'pattern { X [upos=VERB] } commands { X.upos = X.Number }');
  await expect(page.getByText('3 sentences in 1 document, 0 selected, 3 errors')).toBeVisible();
  await expect(page.getByText('X.Number is undefined.').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Apply/ })).toBeDisabled();
});

test('an unsupported command reports the feature', async ({ page }) => {
  const box = await openSearch(page);
  await preview(page, box, 'pattern { X [upos=VERB] } commands { add_node N :< X }');
  await expect(page.getByText('Unsupported feature')).toBeVisible();
  await expect(page.getByText(/Adding words is not supported/)).toBeVisible();
});
