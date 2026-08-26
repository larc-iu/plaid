// Provenance in the annotation grid: does *replacing* a machine-made annotation's
// value verify it (provConfirmed), clear the violet styling, and commit on every
// gesture (Enter / Tab / arrow-pick / mouse-pick) in the vocab Autocomplete cells?
// Also: clearing a cell deletes the span, CoNLL-U export drops prov* keys, and
// sentence Accept verifies Form spans.
// Seeds 'the dog runs' with machine-inferred lemma/UPOS/XPOS/feature on "dog"
// plus two machine relations, then drives each replace gesture and reads the
// server state back after each.
import { test, expect, seedAuth, readToken, collectClientErrors } from './fixtures.js';
import { PlaidClient, ROLES, PLAID_NAMESPACE, ROLE_KEY } from '@larc-iu/plaid-client';

const BASE = 'http://localhost:8085';
const UD_NS = 'ud';
const SPAN_SPECS = [
  ['Form', 'form'],
  ['Lemma', 'lemma'],
  ['UPOS', 'upos'],
  ['XPOS', 'xpos'],
  ['Features', 'features'],
];
const MACHINE = { prov: 'inferred', provSource: 'service:test', provDetail: { model: 'm1' } };
const S = {};

test.beforeAll(async () => {
  const { token } = readToken();
  const client = new PlaidClient(BASE, token);
  S.client = client;

  const project = await client.projects.create(`Prov replace ${Date.now()}`);
  S.projectId = project.id;

  client.beginBatch();
  client.textLayers.create(S.projectId, 'Text');
  const textLayerId = (await client.submitBatch())[0].body.id;
  S.textLayerId = textLayerId;

  client.beginBatch();
  client.textLayers.setConfig(textLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.BASELINE);
  client.tokenLayers.create(textLayerId, 'Sentences', 'partitioning');
  const sentenceLayerId = (await client.submitBatch())[1].body.id;
  S.sentenceLayerId = sentenceLayerId;

  client.beginBatch();
  client.tokenLayers.setConfig(sentenceLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.SENTENCE);
  client.tokenLayers.create(textLayerId, 'Tokens', 'non-overlapping', sentenceLayerId);
  const wordLayerId = (await client.submitBatch())[1].body.id;

  client.beginBatch();
  client.tokenLayers.setConfig(wordLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.WORD);
  client.tokenLayers.create(textLayerId, 'Words', 'any', wordLayerId);
  const morphemeLayerId = (await client.submitBatch())[1].body.id;

  client.beginBatch();
  client.tokenLayers.setConfig(morphemeLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.SYNTACTIC_WORD);
  for (const [name] of SPAN_SPECS) client.spanLayers.create(morphemeLayerId, name);
  const b6 = await client.submitBatch();
  const spanLayerIds = SPAN_SPECS.map((_, i) => b6[1 + i].body.id);
  const byKey = Object.fromEntries(SPAN_SPECS.map(([, key], i) => [key, spanLayerIds[i]]));
  S.byKey = byKey;

  client.beginBatch();
  SPAN_SPECS.forEach(([, key], i) =>
    client.spanLayers.setConfig(spanLayerIds[i], UD_NS, key, true),
  );
  client.relationLayers.create(byKey.lemma, 'Dependency Relations');
  const b7 = await client.submitBatch();
  const relationLayerId = b7[b7.length - 1].body.id;
  S.relationLayerId = relationLayerId;
  client.beginBatch();
  client.relationLayers.setConfig(relationLayerId, UD_NS, 'dependency', true);
  await client.submitBatch();

  const body = 'the dog runs';
  const doc = await client.documents.create(S.projectId, 'Prov Doc');
  S.documentId = doc.id;
  const text = await client.texts.create(textLayerId, doc.id, body);

  const words = [
    [0, 3],
    [4, 7],
    [8, 12],
  ];
  client.beginBatch();
  client.tokens.bulkCreate([
    { tokenLayerId: sentenceLayerId, text: text.id, begin: 0, end: body.length },
  ]);
  client.tokens.bulkCreate(
    words.map(([b, e]) => ({ tokenLayerId: wordLayerId, text: text.id, begin: b, end: e })),
  );
  client.tokens.bulkCreate(
    words.map(([b, e]) => ({
      tokenLayerId: morphemeLayerId,
      text: text.id,
      begin: b,
      end: e,
      precedence: 0,
    })),
  );
  const bTok = await client.submitBatch();
  S.sentTokId = bTok[0].body.ids[0];
  const morphIds = bTok[2].body.ids;
  S.morphIds = morphIds; // [the, dog, runs]

  const lemThe = (await client.spans.create(byKey.lemma, [morphIds[0]], 'the')).id;
  S.lemDog = (await client.spans.create(byKey.lemma, [morphIds[1]], 'dog', MACHINE)).id;
  const lemRuns = (await client.spans.create(byKey.lemma, [morphIds[2]], 'run')).id;
  S.lemThe = lemThe;
  S.lemRuns = lemRuns;
  S.uposDog = (await client.spans.create(byKey.upos, [morphIds[1]], 'NOUN', MACHINE)).id;
  S.xposDog = (await client.spans.create(byKey.xpos, [morphIds[1]], 'NN', MACHINE)).id;
  S.featDog = (await client.spans.create(byKey.features, [morphIds[1]], 'Number=Sing', MACHINE)).id;
  S.formDog = (await client.spans.create(byKey.form, [morphIds[1]], 'dogg', MACHINE)).id;
  S.relDet = (await client.relations.create(relationLayerId, lemRuns, lemThe, 'det', MACHINE)).id;
  S.relNsubj = (
    await client.relations.create(relationLayerId, lemRuns, S.lemDog, 'nsubj', MACHINE)
  ).id;
});

test.afterAll(async () => {
  if (S.client && S.projectId) {
    await S.client.projects
      .delete(S.projectId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

async function openAnnotate(page) {
  await seedAuth(page);
  await page.addInitScript(() => {
    localStorage.setItem(
      'ud-annotation-visible-fields',
      JSON.stringify({ lemma: true, xpos: true, upos: true, feats: true }),
    );
  });
  const collected = collectClientErrors(page);
  await page.goto(`/#/projects/${S.projectId}/documents/${S.documentId}/annotate`);
  await expect(page.locator('.token-form', { hasText: 'dog' }).first()).toBeVisible({
    timeout: 15000,
  });
  return collected;
}

const dump = (label, obj) => console.log(`[${label}]`, JSON.stringify(obj));
const apiSummary = (c) =>
  c.apiCalls
    .filter((x) => x.method !== 'GET')
    .map((x) => `${x.method} ${x.status} ${x.url.replace(BASE, '')}`);

test('API: batched(update + patchMetadata) verifies on the server', async () => {
  const { client, byKey, morphIds } = S;
  const tmp = (await client.spans.create(byKey.xpos, [morphIds[0]], 'DT', MACHINE)).id;
  await client.batched(async () => {
    client.spans.update(tmp, 'DET');
    client.spans.patchMetadata(tmp, { provConfirmed: true });
  });
  const back = await client.spans.get(tmp);
  dump('api-batched', { value: back.value, metadata: back.metadata });
  expect(back.value).toBe('DET');
  expect(back.metadata.provConfirmed).toBe(true);
  expect(back.metadata.prov).toBe('inferred');
  await client.spans.delete(tmp);
});

test('replace UPOS (Autocomplete cell) on dog', async ({ page }) => {
  const c = await openAnnotate(page);
  const before = await page.locator('.editable-field--inferred').count();
  const cell = page.locator(`[id="${S.morphIds[1]}-upos"]`);
  await cell.focus();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('VERB', { delay: 20 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  const after = await page.locator('.editable-field--inferred').count();
  const span = await S.client.spans.get(S.uposDog);
  dump('upos-replace', {
    before,
    after,
    cellValue: await cell.inputValue(),
    server: { value: span.value, metadata: span.metadata },
    title: await cell.getAttribute('title'),
    api: apiSummary(c),
    errors: c.errors.map((e) => e.text),
  });
  expect(span.value).toBe('VERB');
  expect(span.metadata.provConfirmed).toBe(true);
  expect(after).toBe(before - 1);
  expect(await cell.getAttribute('title')).toContain('human-verified');
});

test('replace lemma (plain input) on dog', async ({ page }) => {
  const c = await openAnnotate(page);
  const cell = page.locator(`[id="${S.morphIds[1]}-lemma"]`);
  await cell.focus();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('doggo', { delay: 20 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  const span = await S.client.spans.get(S.lemDog);
  dump('lemma-replace', {
    inferredCount: await page.locator('.editable-field--inferred').count(),
    cellValue: await cell.inputValue(),
    server: { value: span.value, metadata: span.metadata },
    api: apiSummary(c),
    errors: c.errors.map((e) => e.text),
  });
});

test('clear XPOS then retype on dog', async ({ page }) => {
  const c = await openAnnotate(page);
  const cell = page.locator(`[id="${S.morphIds[1]}-xpos"]`);
  await cell.focus();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  let span = await S.client.spans.get(S.xposDog).catch((e) => ({ error: e.message }));
  dump('xpos-clear', {
    server: span.error ? span : { value: span.value, metadata: span.metadata },
  });
  await cell.focus();
  await page.keyboard.type('VBZ', { delay: 20 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  span = await S.client.spans.get(S.xposDog).catch((e) => ({ error: e.message }));
  const layer = (await S.client.spanLayers.get(S.byKey.xpos)) || {};
  dump('xpos-retype', {
    server: span.error ? span : { value: span.value, metadata: span.metadata },
    api: apiSummary(c),
    errors: c.errors.map((e) => e.text),
  });
  expect(span.error).toMatch(/404/); // old span deleted on clear
  const doc = await S.client.documents.get(S.documentId, true);
  const xposSpans = [];
  const walk = (tl) => {
    for (const sl of tl.spanLayers || [])
      if (sl.id === S.byKey.xpos) xposSpans.push(...(sl.spans || []));
    for (const ch of tl.tokenLayers || []) walk(ch);
  };
  for (const tl of doc.textLayers || []) for (const t of tl.tokenLayers || []) walk(t);
  const fresh = xposSpans.find((x) => x.tokens.includes(S.morphIds[1]));
  dump('xpos-fresh', fresh);
  expect(fresh.value).toBe('VBZ');
  expect(fresh.metadata?.prov).toBeUndefined(); // human-made
  void layer;
});

test('replace feature value (chip input) on dog', async ({ page }) => {
  const c = await openAnnotate(page);
  const input = page.locator(`[id="${S.morphIds[1]}-feats"]`);
  await input.focus();
  await input.pressSequentially('Number=Plur', { delay: 20 });
  await input.press('Enter');
  await page.waitForTimeout(1200);
  const span = await S.client.spans.get(S.featDog).catch((e) => ({ error: e.message }));
  dump('feat-replace', {
    inferredFeats: await page.locator('.feature-text--inferred').count(),
    server: span.error ? span : { value: span.value, metadata: span.metadata },
    api: apiSummary(c),
    errors: c.errors.map((e) => e.text),
  });
});

test('replace deprel label (tree editor)', async ({ page }) => {
  const c = await openAnnotate(page);
  const label = page.locator('.tree-deprel-text', { hasText: 'det' }).first();
  await expect(label).toBeVisible();
  const cls = await label.getAttribute('class');
  await label.click({ force: true });
  const editor = page.locator('foreignObject input').first();
  await expect(editor).toBeVisible();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('nmod', { delay: 20 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  const rel = await S.client.relations.get(S.relDet);
  const newLabel = page.locator('.tree-deprel-text', { hasText: 'nmod' }).first();
  dump('deprel-replace', {
    classBefore: cls,
    classAfter: await newLabel.getAttribute('class').catch(() => null),
    server: { value: rel.value, metadata: rel.metadata },
    api: apiSummary(c),
    errors: c.errors.map((e) => e.text),
  });
});

// ---- UPOS gesture matrix: reset the span before each, then try one gesture ----
const resetUpos = async () => {
  await S.client.spans.update(S.uposDog, 'NOUN');
  await S.client.spans.patchMetadata(S.uposDog, { ...MACHINE, provConfirmed: null });
};
const readUpos = async (page, c) => {
  await page.waitForTimeout(1200);
  const span = await S.client.spans.get(S.uposDog);
  return {
    inferredCount: await page.locator('.editable-field--inferred').count(),
    cellValue: await page.locator(`[id="${S.morphIds[1]}-upos"]`).inputValue(),
    server: { value: span.value, metadata: span.metadata },
    api: apiSummary(c),
    errors: c.errors.map((e) => e.text),
  };
};

test('upos: Ctrl+A, type, Enter, then Tab', async ({ page }) => {
  await resetUpos();
  const c = await openAnnotate(page);
  await page.locator(`[id="${S.morphIds[1]}-upos"]`).focus();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('VERB', { delay: 20 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  await page.keyboard.press('Tab');
  dump('upos-enter-tab', await readUpos(page, c));
});

test('upos: Ctrl+A, type, Tab', async ({ page }) => {
  await resetUpos();
  const c = await openAnnotate(page);
  await page.locator(`[id="${S.morphIds[1]}-upos"]`).focus();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('VERB', { delay: 20 });
  await page.keyboard.press('Tab');
  dump('upos-tab', await readUpos(page, c));
});

test('upos: type prefix, ArrowDown, Enter (option submit), then Tab', async ({ page }) => {
  await resetUpos();
  const c = await openAnnotate(page);
  await page.locator(`[id="${S.morphIds[1]}-upos"]`).focus();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('VE', { delay: 20 });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const mid = await readUpos(page, c);
  await page.keyboard.press('Tab');
  const fin = await readUpos(page, c);
  dump('upos-arrow-enter', { afterEnter: mid, afterTab: fin });
  expect(mid.server.value).toBe('VERB');
  expect(mid.server.metadata.provConfirmed).toBe(true);
  expect(fin.server.value).toBe('VERB');
});

test('upos: click cell, mouse-pick option, click away', async ({ page }) => {
  await resetUpos();
  const c = await openAnnotate(page);
  await page.locator(`[id="${S.morphIds[1]}-upos"]`).click();
  const opt = page.locator('[role="option"]', { hasText: /^VERB/ }).first();
  await expect(opt).toBeVisible();
  await opt.click();
  const mid = await readUpos(page, c);
  await page
    .locator('h1, h2, .breadcrumb, body')
    .first()
    .click({ position: { x: 5, y: 5 } });
  dump('upos-mouse-pick', { afterPick: mid, afterClickAway: await readUpos(page, c) });
});

test('upos: Ctrl+A, type, Enter, click away', async ({ page }) => {
  await resetUpos();
  const c = await openAnnotate(page);
  await page.locator(`[id="${S.morphIds[1]}-upos"]`).focus();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('VERB', { delay: 20 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  await page.mouse.click(5, 5);
  dump('upos-enter-clickaway', await readUpos(page, c));
});

test('export skips reserved provenance keys on sentence tokens', async ({ page }) => {
  await S.client.tokens.patchMetadata(S.sentTokId, { ...MACHINE, text: 'the dog runs' });
  await seedAuth(page);
  await page.goto(`/#/projects/${S.projectId}/documents/${S.documentId}/export`);
  const ta = page.locator('textarea').first();
  await expect(ta).toBeVisible({ timeout: 15000 });
  await expect.poll(() => ta.inputValue()).toContain('# sent_id');
  const out = await ta.inputValue();
  console.log('[export]\n' + out);
  expect(out).toContain('# text = the dog runs');
  expect(out).not.toMatch(/# prov/);
});

test('Accept predictions (sentence) verifies the Form span too', async ({ page }) => {
  await S.client.spans.patchMetadata(S.formDog, { ...MACHINE, provConfirmed: null });
  const c = await openAnnotate(page);
  await expect(page.locator('.token-form--inferred')).toHaveCount(1);
  await page.locator('.accept-predictions-btn').first().click();
  await expect(page.locator('.token-form--inferred')).toHaveCount(0, { timeout: 8000 });
  await page.waitForTimeout(500);
  const span = await S.client.spans.get(S.formDog);
  dump('form-accept', {
    server: span.metadata,
    api: apiSummary(c),
    errors: c.errors.map((e) => e.text),
  });
  expect(span.metadata.provConfirmed).toBe(true);
});
