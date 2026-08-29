import PlaidClient, { ROLES, cpLength } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';

// TEST_PLAN B2 (ranking + search), B3 (keyboard), B4 (link/unlink/relink),
// B5 (create from the popover) and B6 (two vocabularies) auto rows. A throwaway
// document and a throwaway second lexicon ("LEX-B") are created in the
// "E2E IGT Fixture" project and removed afterwards; nothing is created in the
// shared "IGT Lexicon" (LEX-A: all, the, human, be.born, free, equal).

const CORE = 'http://localhost:8085';
const roleOf = (l) => l?.config?.plaid?.role;
const BODY = 'derechos. "hola," dog\'s ... 😀 ser hum the';
const W = { derechos: 0, hola: 1, dogs: 2, dots: 3, emoji: 4, ser: 5, hum: 6, the: 7 };

let client;
let projectId;
let documentId;
let lexB;
let ids = {};
let lexA;
let TEXT_LAYER_ID;
let WORD_LAYER_ID;
let SENT_LAYER_ID;

test.beforeAll(async () => {
  client = new PlaidClient(CORE, readToken().token);
  const project = (await client.projects.list()).find((p) => p.name === 'E2E IGT Fixture');
  if (!project) throw new Error('run node e2e/fixture.js first');
  projectId = project.id;
  const full = await client.projects.get(projectId);
  lexA = full.vocabs.find((v) => v.name === 'IGT Lexicon');
  const textLayer = full.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const layer = (role) => textLayer.tokenLayers.find((l) => roleOf(l) === role);
  const WORD = layer(ROLES.WORD);
  const MORPH = layer(ROLES.MORPHEME);
  TEXT_LAYER_ID = textLayer.id;
  WORD_LAYER_ID = WORD.id;
  SENT_LAYER_ID = layer(ROLES.SENTENCE).id;

  const stamp = Date.now();
  lexB = await client.vocabLayers.create(`LEX-B ${stamp}`);
  lexB.items = {};
  for (const form of ['ser', 'ser', 'human', 'humble', 'the']) {
    const it = await client.vocabItems.create(lexB.id, form);
    (lexB.items[form] ||= []).push(it.id);
  }
  await client.projects.linkVocab(projectId, lexB.id);

  const created = await client.documents.create(projectId, `popover-spec ${stamp}`);
  documentId = created.id;
  await client.texts.create(textLayer.id, documentId, BODY);
  const raw = await client.documents.get(documentId, true);
  const TEXT = raw.textLayers.find((l) => roleOf(l) === ROLES.BASELINE).text.id;
  const cps = [...BODY];
  const words = [];
  let i = 0;
  while (i < cps.length) {
    while (i < cps.length && /\s/.test(cps[i])) i++;
    if (i >= cps.length) break;
    const begin = i;
    while (i < cps.length && !/\s/.test(cps[i])) i++;
    words.push({ begin, end: i });
  }
  await client.tokens.bulkCreate([
    { tokenLayerId: layer(ROLES.SENTENCE).id, text: TEXT, begin: 0, end: cpLength(BODY) },
  ]);
  await client.tokens.bulkCreate(words.map((w) => ({ tokenLayerId: WORD.id, text: TEXT, ...w })));
  await client.tokens.bulkCreate(
    words.map((w) => ({ tokenLayerId: MORPH.id, text: TEXT, ...w, precedence: 1 })),
  );
  const seeded = await client.documents.get(documentId, true);
  const tl = seeded.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const wl = tl.tokenLayers.find((l) => l.id === WORD.id);
  const ml = tl.tokenLayers.find((l) => l.id === MORPH.id);
  ids = {
    w: words.map((x) => wl.tokens.find((t) => t.begin === x.begin).id),
    m: words.map((x) => ml.tokens.find((t) => t.begin === x.begin).id),
  };
  // `hum`'s morpheme gets the form `ko` (B5-08); `the`'s morpheme an empty form (B5-09).
  await client.tokens.patchMetadata(ids.m[W.hum], { form: 'ko' });
  // A second morpheme on `hum` so an affix type has a joiner to render (B8-03).
  const hum = wl.tokens.find((t) => t.id === ids.w[W.hum]);
  ids.hum2 = (await client.tokens.create(MORPH.id, TEXT, hum.begin, hum.end, 2, { form: 'x' })).id;
  await client.tokens.patchMetadata(ids.m[W.the], { form: '' });
});

test.afterAll(async () => {
  if (documentId) await client.documents.delete(documentId).catch(() => {});
  if (lexB) {
    await client.projects.unlinkVocab(projectId, lexB.id).catch(() => {});
    await client.vocabLayers.delete(lexB.id).catch(() => {});
  }
});

async function openAnalyze(page) {
  // A goto to the SAME hash URL is a same-document navigation (no reload), so
  // bounce through about:blank to guarantee a fresh load of the document.
  if (page.url() !== 'about:blank') await page.goto('about:blank');
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=analyze`);
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  await page.waitForLoadState('networkidle');
}
const opener = (page, tokenId) => page.locator(`button[data-vocab-opener="${tokenId}"]`);
const pop = (page) => page.locator('.igt-vocab-pop');
const rows = (page) => page.locator('.igt-vocab-pop__item');
const rowForms = async (page) =>
  (await rows(page).locator('.igt-vocab-pop__form').allInnerTexts()).map((t) => t.trim());
const createRow = (page) => page.locator('.igt-vocab-pop__create');
const chip = (page, tokenId) =>
  page.locator(`button.igt-vocab__hint[data-vocab-opener="${tokenId}"]`);
async function open(page, tokenId, vocabName = null) {
  await opener(page, tokenId).click();
  await pop(page).waitFor({ state: 'visible' });
  if (vocabName) {
    const tab = page.locator('.igt-vocab-pop__vocabtab', { hasText: vocabName });
    if (!(await tab.evaluate((el) => el.classList.contains('is-active')))) await tab.click();
    await expect(page.locator('.igt-vocab-pop__vocabtab.is-active')).toContainText(vocabName);
  }
}
const linksTo = async (tokenId) => {
  const raw = await client.documents.get(documentId, true);
  return raw.textLayers
    .flatMap((t) => t.tokenLayers)
    .flatMap((l) => l.vocabs || [])
    .flatMap((v) => (v.vocabLinks || []).map((l) => ({ ...l, vocabId: v.id })))
    .filter((l) => l.tokens.length === 1 && l.tokens[0] === tokenId);
};
const writes = (page) => {
  const seen = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET' && r.url().includes('/api/v1/'))
      seen.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  return seen;
};

test('B5-01/02/14: "+ Create" trims edge punctuation, creates + links, and replaces a prior link', async ({
  page,
}) => {
  await openAnalyze(page);
  await open(page, ids.w[W.derechos], lexB.name);
  await expect(createRow(page)).toHaveText(/Create\s*"derechos"/);
  await expect(createRow(page)).not.toContainText('derechos.');
  await createRow(page).dblclick();
  await expect(chip(page, ids.w[W.derechos])).toHaveText(/derechos/);
  await page.waitForLoadState('networkidle');
  const items = (await client.vocabLayers.get(lexB.id, true)).items;
  const made = items.find((it) => it.form === 'derechos');
  expect(made, 'item created in LEX-B').toBeTruthy();
  let links = await linksTo(ids.w[W.derechos]);
  expect(links.length).toBe(1);
  expect(links[0].vocabItem.id).toBe(made.id);
  expect(links[0].metadata?.prov, 'a created link is human').toBeUndefined();
  // B5-14: create again (a homonym) while linked: the old link is replaced atomically.
  await open(page, ids.w[W.derechos], lexB.name);
  const seen = writes(page);
  await createRow(page).dblclick();
  await expect.poll(() => seen.length, { timeout: 5000 }).toBe(2);
  expect(seen).toEqual(['POST /api/v1/vocab-items', 'POST /api/v1/batch']);
  await page.waitForLoadState('networkidle');
  links = await linksTo(ids.w[W.derechos]);
  expect(links.length).toBe(1);
  expect(links[0].vocabItem.id).not.toBe(made.id);
});

test('B5-04..09: create-row forms per token shape', async ({ page }) => {
  await openAnalyze(page);
  await open(page, ids.w[W.hola], lexB.name);
  await expect(createRow(page)).toHaveText(/Create\s*"hola"/);
  await page.keyboard.press('Escape');
  await open(page, ids.w[W.dogs], lexB.name);
  await expect(createRow(page)).toHaveText(/Create\s*"dog's"/);
  await page.keyboard.press('Escape');
  // `...` is an ignored token: no opener at all.
  await expect(opener(page, ids.w[W.dots])).toHaveCount(0);
  // Emoji are annotatable: opener present, create row shows the emoji.
  await open(page, ids.w[W.emoji], lexB.name);
  await expect(createRow(page)).toHaveText(/Create\s*"😀"/);
  await page.keyboard.press('Escape');
  // A morpheme's create row uses the morpheme FORM, not the word.
  await open(page, ids.m[W.hum], lexB.name);
  await expect(createRow(page)).toHaveText(/Create\s*"ko"/);
  await page.keyboard.press('Escape');
  // An empty morpheme form: no create row.
  await open(page, ids.m[W.the], lexB.name);
  await expect(createRow(page)).toHaveCount(0);
});

test('B5-10/11: homonyms get subscripts; creating a third is announced and numbered', async ({
  page,
}) => {
  await openAnalyze(page);
  await open(page, ids.w[W.ser], lexB.name);
  const serRows = rows(page).filter({
    has: page.locator('.igt-vocab-pop__form', { hasText: /^ser/ }),
  });
  await expect(serRows).toHaveCount(2);
  await expect(serRows.nth(0).locator('.igt-vocab-pop__sub')).toHaveText('1');
  await expect(serRows.nth(1).locator('.igt-vocab-pop__sub')).toHaveText('2');
  await expect(createRow(page).locator('.igt-vocab-pop__sub')).toHaveText('3');
  await expect(page.locator('.igt-vocab-pop__note')).toContainText('already exists');
  await createRow(page).dblclick();
  await expect(chip(page, ids.w[W.ser])).toContainText('ser');
  await expect(chip(page, ids.w[W.ser]).locator('.igt-vocab__sub')).toHaveText('3');
  await page.waitForLoadState('networkidle');
  const forms = (await client.vocabLayers.get(lexB.id, true)).items.filter(
    (it) => it.form === 'ser',
  );
  expect(forms.length).toBe(3);
});

test('B2 + B3-02: ranking tiers, narrowing, no-match, Enter links and returns focus', async ({
  page,
}) => {
  await openAnalyze(page);
  // hum: prefix match `human` (and `humble`) rank first in LEX-B.
  await open(page, ids.w[W.hum], lexB.name);
  let forms = await rowForms(page);
  expect(forms.slice(0, 2).sort()).toEqual(['human', 'humble']);
  await page.locator('.igt-vocab-pop__search').fill('humb');
  await expect.poll(() => rowForms(page)).toEqual(['humble']);
  await page.locator('.igt-vocab-pop__search').fill('zzz');
  await expect(rows(page)).toHaveCount(0);
  await expect(page.locator('.igt-vocab-pop__empty')).toBeVisible();
  await expect(createRow(page)).toBeVisible();
  await page.locator('.igt-vocab-pop__search').fill('');
  await expect.poll(async () => (await rowForms(page)).length).toBeGreaterThan(1);
  // B3-02: Enter on the highlighted first row links, closes, returns focus to the chip.
  await page.locator('.igt-vocab-pop__search').press('Enter');
  await expect(pop(page)).toHaveCount(0);
  await expect(chip(page, ids.w[W.hum])).toHaveText(/human|humble/);
  await expect(chip(page, ids.w[W.hum])).toBeFocused();
  // B2-08: reopening pins the linked row first, marked linked.
  const linkedForm = (await chip(page, ids.w[W.hum]).innerText()).trim();
  await open(page, ids.w[W.hum]);
  await expect(rows(page).first()).toHaveClass(/is-linked/);
  await expect(rows(page).first().locator('.igt-vocab-pop__form')).toHaveText(linkedForm);
  await page.keyboard.press('Escape');
  // B2-01: exact match first (`the` in LEX-B).
  await open(page, ids.w[W.the], lexB.name);
  forms = await rowForms(page);
  expect(forms[0]).toBe('the');
});

test('B4-03/04 + B6-05: unlink mini-action, relink in one batch, cross-vocab replace', async ({
  page,
}) => {
  await openAnalyze(page);
  // Link `the` (LEX-B) via the row, then unlink with the mini-action.
  await open(page, ids.w[W.the], lexB.name);
  await rows(page).filter({ hasText: 'the' }).first().click();
  await expect(chip(page, ids.w[W.the])).toHaveText('the');
  await open(page, ids.w[W.the]);
  await page.locator('.igt-vocab-pop__item.is-linked .igt-vocab-pop__x').click();
  await expect(chip(page, ids.w[W.the])).toHaveCount(0);
  await page.waitForLoadState('networkidle');
  expect((await linksTo(ids.w[W.the])).length).toBe(0);
  // B4-04: link, then pick another item: one batch (delete + create).
  await open(page, ids.w[W.the], lexB.name);
  await rows(page).filter({ hasText: 'the' }).first().click();
  await page.waitForLoadState('networkidle');
  const seen = writes(page);
  await open(page, ids.w[W.the], lexB.name);
  await rows(page).filter({ hasText: 'humble' }).first().click();
  await expect(chip(page, ids.w[W.the])).toHaveText('humble');
  await page.waitForLoadState('networkidle');
  expect(seen).toEqual(['POST /api/v1/batch']);
  // B6-05: pick an item from the OTHER vocab: silent replace, one link, in LEX-A.
  await open(page, ids.w[W.the], lexA.name);
  const first = rows(page).first();
  const form = (await first.locator('.igt-vocab-pop__form').innerText()).trim();
  await first.click();
  await expect(chip(page, ids.w[W.the])).toHaveText(form);
  await page.waitForLoadState('networkidle');
  const links = await linksTo(ids.w[W.the]);
  expect(links.length).toBe(1);
  expect(links[0].vocabId).toBe(lexA.id);
  // B6-02: reopening on a token linked in LEX-A shows LEX-A active.
  await open(page, ids.w[W.the]);
  await expect(page.locator('.igt-vocab-pop__vocabtab.is-active')).toContainText(lexA.name);
});

test('B1-02/03/04/09: opener toggles, outside click closes, Escape returns focus, one at a time', async ({
  page,
}) => {
  await openAnalyze(page);
  const a = ids.w[W.hola];
  const b = ids.w[W.dogs];
  await opener(page, a).click();
  await expect(pop(page)).toHaveCount(1);
  await opener(page, a).click();
  await expect(pop(page)).toHaveCount(0);
  await opener(page, a).click();
  await expect(pop(page)).toHaveCount(1);
  await page.locator('h1').first().click();
  await expect(pop(page)).toHaveCount(0);
  await expect(opener(page, a)).not.toBeFocused();
  await opener(page, a).click();
  await expect(page.locator('.igt-vocab-pop__search')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(pop(page)).toHaveCount(0);
  await expect(opener(page, a)).toBeFocused();
  await opener(page, a).click();
  await opener(page, b).click();
  await expect(pop(page)).toHaveCount(1);
  // The open popover belongs to B: its create row names B's form.
  await expect(createRow(page)).toHaveText(/dog's/);
  await page.keyboard.press('Escape');
});

test('B3-01/04: arrows move the highlight and clamp; Tab stays in the search box', async ({
  page,
}) => {
  await openAnalyze(page);
  await open(page, ids.w[W.hum], lexB.name);
  const active = () => page.locator('.igt-vocab-pop .is-active').first();
  await expect(rows(page).first()).toHaveClass(/is-active/);
  await page.keyboard.press('ArrowDown');
  await expect(rows(page).nth(1)).toHaveClass(/is-active/);
  await page.keyboard.press('ArrowDown', { delay: 10 });
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowDown');
  await expect(createRow(page)).toHaveClass(/is-active/);
  await page.keyboard.press('ArrowDown');
  await expect(createRow(page)).toHaveClass(/is-active/);
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowUp');
  await expect(rows(page).first()).toHaveClass(/is-active/);
  await expect(active()).toHaveCount(1);
  await page.keyboard.press('Tab');
  await expect(page.locator('.igt-vocab-pop__search')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('.igt-vocab-pop__search')).toBeFocused();
  await page.keyboard.press('Escape');
});

test('B7-03/04: deleting or renaming a homonym renumbers the rest', async ({ page }) => {
  // Self-seeding: make sure LEX-B holds at least three `ser` entries.
  while (
    (await client.vocabLayers.get(lexB.id, true)).items.filter((it) => it.form === 'ser').length < 3
  ) {
    await client.vocabItems.create(lexB.id, 'ser');
  }
  const sers = (await client.vocabLayers.get(lexB.id, true)).items.filter(
    (it) => it.form === 'ser',
  );
  await client.vocabItems.delete(sers[0].id);
  await openAnalyze(page);
  await open(page, ids.w[W.emoji], lexB.name);
  await page.locator('.igt-vocab-pop__search').fill('ser');
  const serRows = rows(page).filter({
    has: page.locator('.igt-vocab-pop__form', { hasText: /^ser/ }),
  });
  await expect(serRows).toHaveCount(sers.length - 1);
  await expect(serRows.nth(0).locator('.igt-vocab-pop__sub')).toHaveText('1');
  await page.keyboard.press('Escape');
  // Rename all but one `ser`: the survivor loses its subscript.
  const rest = (await client.vocabLayers.get(lexB.id, true)).items.filter(
    (it) => it.form === 'ser',
  );
  for (const it of rest.slice(1)) await client.vocabItems.update(it.id, `estar-${it.id.slice(-4)}`);
  await openAnalyze(page);
  await open(page, ids.w[W.emoji], lexB.name);
  await page.locator('.igt-vocab-pop__search').fill('ser');
  const forms = await rowForms(page);
  const apiForms = (await client.vocabLayers.get(lexB.id, true)).items.map((it) => it.form);
  const one = rows(page).filter({
    has: page.locator('.igt-vocab-pop__form', { hasText: /^ser$/ }),
  });
  await expect(one, `rows: ${JSON.stringify(forms)} api: ${JSON.stringify(apiForms)}`).toHaveCount(
    1,
  );
  await expect(one.locator('.igt-vocab-pop__sub')).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('B8-03/04: the morpheme Type select stores morphType and toggles the affix joiner', async ({
  page,
}) => {
  await openAnalyze(page);
  const m = ids.hum2;
  const joiner = page.locator('.igt-morph-joiner').first();
  await expect(joiner).toHaveText('-');
  await open(page, m);
  const sel = page.locator('.igt-vocab-pop select');
  await expect(sel).toHaveCount(1);
  await sel.selectOption('enclitic');
  await page.waitForLoadState('networkidle');
  await expect.poll(async () => (await client.tokens.get(m)).metadata?.morphType).toBe('enclitic');
  await expect(joiner).toHaveText('=');
  // The token also verifies nothing here (a human change on a human morpheme).
  expect((await client.tokens.get(m)).metadata?.prov).toBeUndefined();
  await page.keyboard.press('Escape');
  await open(page, m);
  await page.locator('.igt-vocab-pop select').selectOption('');
  await page.waitForLoadState('networkidle');
  await expect
    .poll(async () => 'morphType' in ((await client.tokens.get(m)).metadata || {}))
    .toBe(false);
  await expect(joiner).toHaveText('-');
});

test('B2 precedent: what a form was linked to before ranks first, counted across the project', async ({
  page,
}) => {
  // A second throwaway document links its `ser` word to LEX-B `human`, and so
  // does this document's own `ser` word. The project query leaves the open
  // document out and its links are tallied live, so the count is exactly 2,
  // not 3. Opened on the MORPHEME under `ser` (no morpheme ever linked `ser`,
  // so it sees what any token did), `human ×2` ranks ahead of the two
  // exact-form `ser` entries. Typing a search sets precedent aside.
  const humanId = lexB.items.human[0];
  const other = await client.documents.create(projectId, `popover-prec ${Date.now()}`);
  const made = [];
  try {
    await client.texts.create(TEXT_LAYER_ID, other.id, 'ser');
    const raw = await client.documents.get(other.id, true);
    const textId = raw.textLayers.find((l) => roleOf(l) === ROLES.BASELINE).text.id;
    await client.tokens.bulkCreate([
      { tokenLayerId: SENT_LAYER_ID, text: textId, begin: 0, end: 3 },
    ]);
    const t = await client.tokens.create(WORD_LAYER_ID, textId, 0, 3);
    await client.vocabLinks.create(humanId, [t.id]);
    // Earlier tests may have left links on the `ser` word or morpheme; only
    // the one made here should count.
    for (const id of [ids.w[W.ser], ids.m[W.ser]]) {
      const stale = await linksTo(id);
      if (stale.length) await client.vocabLinks.bulkDelete(stale.map((l) => l.id));
    }
    made.push((await client.vocabLinks.create(humanId, [ids.w[W.ser]])).id);

    await openAnalyze(page);
    await open(page, ids.m[W.ser], lexB.name);
    // `human ×2` first, then the exact-form `ser` entry (B7 renamed the other
    // homonym); the rest of LEX-B, including entries other tests added,
    // follows by form.
    await expect.poll(async () => (await rowForms(page)).slice(0, 2)).toEqual(['human', 'ser']);
    await expect(rows(page).first().locator('.igt-vocab-pop__prec')).toHaveText('×2');
    await expect(page.locator('.igt-vocab-pop__prec')).toHaveCount(1);
    await page.locator('.igt-vocab-pop__search').fill('ser');
    await expect.poll(async () => (await rowForms(page))[0]).toBe('ser');
    expect((await rowForms(page)).every((f) => f.includes('ser'))).toBe(true);
    await expect(page.locator('.igt-vocab-pop__prec')).toHaveCount(0);
    await page.keyboard.press('Escape');
  } finally {
    await client.documents.delete(other.id).catch(() => {});
    if (made.length) await client.vocabLinks.bulkDelete(made).catch(() => {});
  }
});
