// Verification spec for the rewritten FeaturesCell token-field (chip input).
// Builds its own throwaway UD project (mirroring ProjectForm.jsx's 8 batches),
// seeds 'the dog runs' with tokens + lemma spans + two pre-seeded features on
// the first morpheme, then drives the FEATS chip input through behaviors 1-5.
import { test, expect, seedAuth, collectClientErrors, readToken } from './fixtures.js';
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

const S = {}; // shared setup state

// NOT serial: workers=1 keeps file order, and a failure in one behavior
// shouldn't skip verification of the rest.

test.beforeAll(async () => {
  const { token } = readToken();
  const client = new PlaidClient(BASE, token);
  S.client = client;

  // B1: project
  const project = await client.projects.create(`FEATS verify ${Date.now()}`);
  S.projectId = project.id;

  // B2: text layer
  client.beginBatch();
  client.textLayers.create(S.projectId, 'Text');
  const b2 = await client.submitBatch();
  const textLayerId = b2[0].body.id;
  S.textLayerId = textLayerId;

  // B3: text role + sentence layer
  client.beginBatch();
  client.textLayers.setConfig(textLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.BASELINE);
  client.tokenLayers.create(textLayerId, 'Sentences', 'partitioning');
  const b3 = await client.submitBatch();
  const sentenceLayerId = b3[1].body.id;

  // B4: sentence role + word layer
  client.beginBatch();
  client.tokenLayers.setConfig(sentenceLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.SENTENCE);
  client.tokenLayers.create(textLayerId, 'Words', 'non-overlapping', sentenceLayerId);
  const b4 = await client.submitBatch();
  const wordLayerId = b4[1].body.id;

  // B5: word role + morpheme layer
  client.beginBatch();
  client.tokenLayers.setConfig(wordLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.WORD);
  client.tokenLayers.create(textLayerId, 'Morphemes', 'any', wordLayerId);
  const b5 = await client.submitBatch();
  const morphemeLayerId = b5[1].body.id;

  // B6: morpheme role + 5 span layers
  client.beginBatch();
  client.tokenLayers.setConfig(morphemeLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.SYNTACTIC_WORD);
  for (const [name] of SPAN_SPECS) client.spanLayers.create(morphemeLayerId, name);
  const b6 = await client.submitBatch();
  const spanLayerIds = SPAN_SPECS.map((_, i) => b6[1 + i].body.id);
  const byKey = Object.fromEntries(SPAN_SPECS.map(([, key], i) => [key, spanLayerIds[i]]));
  S.featuresLayerId = byKey.features;

  // B7: span flags + relation layer (under Lemma)
  client.beginBatch();
  SPAN_SPECS.forEach(([, key], i) => client.spanLayers.setConfig(spanLayerIds[i], UD_NS, key, true));
  client.relationLayers.create(byKey.lemma, 'Dependency Relations');
  const b7 = await client.submitBatch();
  const relationLayerId = b7[b7.length - 1].body.id;

  // B8: relation flag
  client.beginBatch();
  client.relationLayers.setConfig(relationLayerId, UD_NS, 'dependency', true);
  await client.submitBatch();

  // Document + text + tokens. 'the dog runs' (ASCII: code points == chars).
  const body = 'the dog runs';
  const doc = await client.documents.create(S.projectId, 'Feats Doc');
  S.documentId = doc.id;
  const text = await client.texts.create(textLayerId, doc.id, body);

  const words = [[0, 3], [4, 7], [8, 12]]; // the / dog / runs
  client.beginBatch();
  client.tokens.bulkCreate([{ tokenLayerId: sentenceLayerId, text: text.id, begin: 0, end: body.length }]);
  client.tokens.bulkCreate(words.map(([b, e]) => ({ tokenLayerId: wordLayerId, text: text.id, begin: b, end: e })));
  client.tokens.bulkCreate(words.map(([b, e]) => ({ tokenLayerId: morphemeLayerId, text: text.id, begin: b, end: e, precedence: 0 })));
  const tb = await client.submitBatch();
  const morphIds = tb[2].body.ids;
  S.morphIds = morphIds; // [the, dog, runs]

  // Lemma spans (one per morpheme) + two pre-seeded features on 'the'
  await client.spans.create(byKey.lemma, [morphIds[0]], 'the');
  await client.spans.create(byKey.lemma, [morphIds[1]], 'dog');
  await client.spans.create(byKey.lemma, [morphIds[2]], 'run');
  await client.spans.create(byKey.features, [morphIds[0]], 'Number=Sing');
  await client.spans.create(byKey.features, [morphIds[0]], 'Gender=Fem');
});

test.afterAll(async () => {
  if (S.client && S.projectId) {
    await S.client.projects.delete(S.projectId).catch((e) => console.error('cleanup failed:', e.message));
  }
});

async function openGrid(page) {
  const collected = collectClientErrors(page);
  await seedAuth(page);
  await page.addInitScript(() => {
    localStorage.setItem('ud-annotation-visible-fields',
      JSON.stringify({ lemma: true, xpos: true, upos: true, feats: true }));
  });
  await page.goto(`/#/projects/${S.projectId}/documents/${S.documentId}/annotate`);
  // Wait until the grid shows all three token forms (reconcile-on-open may write first).
  for (const form of ['the', 'dog', 'runs']) {
    await expect(page.locator('.token-form', { hasText: form }).first()).toBeVisible({ timeout: 15000 });
  }
  return collected;
}

const featsInput = (page, i) => page.locator(`[id="${S.morphIds[i]}-feats"]`);
const pillsOf = (page, i) =>
  page.locator('.features-container', { has: page.locator(`[id="${S.morphIds[i]}-feats"]`) })
    .locator('.feature-tag');

// Server-side truth: list the Features spans as {value, token-index} pairs.
async function serverFeatures(label) {
  const doc = await S.client.documents.get(S.documentId, true);
  const out = [];
  for (const tl of doc.textLayers || []) {
    for (const tokl of tl.tokenLayers || []) {
      for (const sl of tokl.spanLayers || []) {
        if (sl.name !== 'Features') continue;
        for (const s of sl.spans || []) {
          out.push({ id: s.id, value: s.value, tok: S.morphIds.indexOf(s.tokens?.[0]?.id ?? s.tokens?.[0]) });
        }
      }
    }
  }
  console.log(`[server features @ ${label}] docVersion=${doc.version}`, JSON.stringify(out));
  return out;
}

function reportCollected(label, { errors, failures, apiCalls }) {
  console.log(`--- [${label}] console errors ---`);
  for (const e of errors) console.log(JSON.stringify(e));
  console.log(`--- [${label}] failed requests ---`);
  for (const f of failures) console.log(JSON.stringify(f));
  console.log(`--- [${label}] write API calls ---`);
  for (const c of apiCalls) {
    if (c.method !== 'GET') console.log(`${c.status} ${c.method} ${c.url.replace('http://localhost:5173', '')}`);
  }
}

test('B1: typing Key=Value then Enter commits (POST) and clears input', async ({ page }) => {
  const collected = await openGrid(page);
  const input = featsInput(page, 1); // dog
  await expect(input).toBeVisible();
  await input.click();
  await input.pressSequentially('Case=Nom', { delay: 20 });

  const postPromise = page.waitForResponse(
    (r) => r.url().includes('/api/v1/spans') && r.request().method() === 'POST',
    { timeout: 8000 }
  );
  await input.press('Enter');
  const post = await postPromise;
  console.log('POST /spans status:', post.status());
  expect(post.status()).toBeLessThan(300);

  await expect(input).toHaveValue('');
  await expect(pillsOf(page, 1).filter({ hasText: 'Case=Nom' })).toHaveCount(1, { timeout: 8000 });

  await serverFeatures('end of B1');
  reportCollected('B1', collected);
  expect.soft(collected.errors, 'console errors').toEqual([]);
});

test('B2: suggestions — keys as "Key=", then values; picking fills/commits', async ({ page }) => {
  const collected = await openGrid(page);
  const input = featsInput(page, 2); // runs
  await input.click();
  await input.pressSequentially('Cas', { delay: 30 });

  // Stage 1: key suggestions rendered as "Key="
  const keyOption = page.locator('[data-combobox-option]', { hasText: 'Case=' });
  await expect(keyOption.first()).toBeVisible({ timeout: 5000 });
  const stage1 = await page.locator('[data-combobox-option]').allInnerTexts();
  console.log('stage-1 options for "Cas":', JSON.stringify(stage1));
  expect(stage1).toContain('Case=');
  expect(stage1.every((o) => o.endsWith('='))).toBe(true);

  // Picking "Case=" fills the input, no commit
  await keyOption.first().click();
  await expect(input).toHaveValue('Case=');
  await expect(input).toBeFocused();

  // Mantine closes the dropdown after an option pick; typing the value's first
  // letter reopens it — now in stage 2 (value suggestions "Case=Value").
  const reopened = await input.getAttribute('aria-expanded');
  console.log('dropdown open right after "Case=" pick:', reopened);
  await input.pressSequentially('A', { delay: 30 });
  const valOption = page.locator('[data-combobox-option]:visible', { hasText: 'Case=Acc' });
  await expect(valOption.first()).toBeVisible({ timeout: 5000 });
  const stage2 = await page.locator('[data-combobox-option]:visible').allInnerTexts();
  console.log('stage-2 options for "Case=A":', JSON.stringify(stage2));
  expect(stage2.every((o) => o.startsWith('Case='))).toBe(true);

  // Picking "Case=Acc" commits
  const postPromise = page.waitForResponse(
    (r) => r.url().includes('/api/v1/spans') && r.request().method() === 'POST',
    { timeout: 8000 }
  );
  await valOption.first().click();
  const post = await postPromise;
  console.log('POST /spans status (option pick):', post.status());
  expect(post.status()).toBeLessThan(300);
  await expect(pillsOf(page, 2).filter({ hasText: 'Case=Acc' })).toHaveCount(1, { timeout: 8000 });
  const valueAfter = await input.inputValue();
  console.log('input value right after Key=Value pick:', JSON.stringify(valueAfter));
  await page.waitForTimeout(700);
  const valueSettled = await input.inputValue();
  console.log('input value 700ms later:', JSON.stringify(valueSettled));
  if (valueSettled !== '') {
    // Residual text — does blurring now fire a SECOND commit?
    const writes = [];
    const listener = (r) => {
      const m = r.request().method();
      if (r.url().includes('/api/v1/spans') && (m === 'POST' || m === 'PATCH')) {
        writes.push(`${m} ${r.status()}`);
      }
    };
    page.on('response', listener);
    await input.blur();
    await page.waitForTimeout(1200);
    page.off('response', listener);
    console.log('span writes triggered by blur with residual text:', JSON.stringify(writes));
  }
  expect.soft(valueSettled, 'input should clear after option commit').toBe('');

  await serverFeatures('end of B2');
  reportCollected('B2', collected);
  expect.soft(collected.errors, 'console errors').toEqual([]);
});

test('B3: pill selection via Backspace, arrow moves, delete, escape/typing clears', async ({ page }) => {
  const collected = await openGrid(page);
  const input = featsInput(page, 0); // 'the' — has Number=Sing + Gender=Fem
  const pills = pillsOf(page, 0);
  await expect(pills).toHaveCount(2);
  await input.click();
  await expect(input).toHaveValue('');

  // Close the dropdown if focus opened it, so keys reach our handler cleanly.
  if (await input.getAttribute('aria-expanded') === 'true') await input.press('Escape');

  // Backspace at empty input selects the LAST pill
  await input.press('Backspace');
  await expect(pills.nth(1)).toHaveClass(/feature-tag--selected/);

  // ArrowLeft moves selection to the first pill
  await input.press('ArrowLeft');
  await expect(pills.nth(0)).toHaveClass(/feature-tag--selected/);
  await expect(pills.nth(1)).not.toHaveClass(/feature-tag--selected/);

  // ArrowRight moves it back
  await input.press('ArrowRight');
  await expect(pills.nth(1)).toHaveClass(/feature-tag--selected/);

  // Escape clears the selection (input keeps focus)
  await input.press('Escape');
  await expect(page.locator('.feature-tag--selected')).toHaveCount(0);
  await expect(input).toBeFocused();

  // Typing clears a selection too
  await input.press('Backspace'); // select last again
  await expect(pills.nth(1)).toHaveClass(/feature-tag--selected/);
  await input.pressSequentially('x');
  await expect(page.locator('.feature-tag--selected')).toHaveCount(0);
  await input.press('Escape'); // may close dropdown opened by typing
  if (await input.inputValue() !== '') await input.press('Escape');
  // ensure input ends empty for the delete step (Escape with closed dropdown clears+blurs)
  await input.click();
  await expect(input).toHaveValue('');
  if (await input.getAttribute('aria-expanded') === 'true') await input.press('Escape');

  // Backspace-select then Backspace-delete fires DELETE /spans/:id
  await serverFeatures('B3 just before delete');
  await input.press('Backspace');
  await expect(pills.nth(1)).toHaveClass(/feature-tag--selected/);
  const delPromise = page.waitForResponse(
    (r) => /\/api\/v1\/spans\//.test(r.url()) && r.request().method() === 'DELETE',
    { timeout: 8000 }
  );
  await input.press('Backspace');
  const del = await delPromise;
  console.log('DELETE /spans/:id status:', del.status(), 'url:', del.url());
  expect(del.status()).toBeLessThan(300);
  await expect(pills).toHaveCount(1, { timeout: 8000 });
  await expect(pills.first()).toHaveText(/Number=Sing/);

  await serverFeatures('end of B3');
  reportCollected('B3', collected);
  expect.soft(collected.errors, 'console errors').toEqual([]);
});

test('B4+B5: grid arrow navigation and tab order', async ({ page }) => {
  const collected = await openGrid(page);
  const input = featsInput(page, 1); // dog
  const upos = page.locator(`[id="${S.morphIds[1]}-upos"]`);

  // B5: feats input carries a positive tabindex
  const tab = await input.getAttribute('tabindex');
  console.log('feats tabindex (dog):', tab);
  expect(Number(tab)).toBeGreaterThan(0);
  const uposTab = await upos.getAttribute('tabindex');
  console.log('upos tabindex (dog):', uposTab);
  expect(Number(tab)).toBeGreaterThan(Number(uposTab)); // feats row comes after upos row

  // ArrowUp from feats (dropdown closed) -> UPOS input
  await input.click();
  console.log('feats aria-expanded after click:', await input.getAttribute('aria-expanded'));
  if (await input.getAttribute('aria-expanded') === 'true') await input.press('Escape');
  await input.press('ArrowUp');
  await expect(upos).toBeFocused();

  // ArrowDown from UPOS -> feats. Per design, Escape must close the UPOS
  // dropdown first; note EditableCell's Escape handler also blurs, so refocus
  // if that happens and report it.
  const uposExpanded = await upos.getAttribute('aria-expanded');
  console.log('upos aria-expanded after ArrowUp focus:', uposExpanded);
  if (uposExpanded === 'true') {
    await upos.press('Escape');
    const stillFocused = await upos.evaluate((el) => document.activeElement === el);
    console.log('upos still focused after Escape:', stillFocused);
    if (!stillFocused) await upos.focus();
    if (await upos.getAttribute('aria-expanded') === 'true') {
      console.log('NOTE: upos dropdown still open after Escape');
    }
  }
  await upos.press('ArrowDown');
  await expect(input).toBeFocused();

  // ArrowLeft at empty feats input -> previous token's feats
  if (await input.getAttribute('aria-expanded') === 'true') await input.press('Escape');
  await expect(input).toHaveValue('');
  await input.press('ArrowLeft');
  await expect(featsInput(page, 0)).toBeFocused();

  // ArrowRight from there -> back to dog's feats
  const first = featsInput(page, 0);
  if (await first.getAttribute('aria-expanded') === 'true') await first.press('Escape');
  await first.press('ArrowRight');
  await expect(input).toBeFocused();

  // and ArrowRight again -> runs' feats
  if (await input.getAttribute('aria-expanded') === 'true') await input.press('Escape');
  await input.press('ArrowRight');
  await expect(featsInput(page, 2)).toBeFocused();

  await serverFeatures('end of B4');
  reportCollected('B4', collected);
  expect.soft(collected.errors, 'console errors').toEqual([]);
});

test('screenshot: grid with committed pills', async ({ page }) => {
  // Self-sufficient: a worker restart (after any failed test) re-runs
  // beforeAll with a FRESH project, so don't rely on pills from B1/B2 —
  // seed one via the API if it isn't there.
  const existing = await serverFeatures('before screenshot openGrid');
  if (!existing.some((f) => f.tok === 1)) {
    await S.client.spans.create(S.featuresLayerId, [S.morphIds[1]], 'Case=Nom');
  }
  await openGrid(page);
  await expect(pillsOf(page, 1).filter({ hasText: 'Case=Nom' })).toHaveCount(1);
  await page.locator('.sentence-grid').first().screenshot({ path: 'e2e/feats-verify.png' });
});
