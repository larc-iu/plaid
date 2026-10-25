import PlaidClient, { ROLES, cpLength } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken, CORE } from './fixtures.js';
import { getFixture, roleOf } from './fixtureProject.js';

// The pair picker: a morpheme's link and gloss picked together, from Alt+Down
// on the gloss and from the link chip, and still there after a reload. A
// throwaway document and lexicon in the "E2E IGT Fixture" project, removed
// afterwards. The first morpheme carries a gloss and a link the way an
// analysis service writes them, its alternatives naming their senses
// (provDetail.valueLinks).

const NONCE = Date.now().toString(36);
const FORM = `kat${NONCE}`;
const BODY = `${FORM} ${FORM}`;
const MACHINE = { prov: 'inferred', provSource: 'service:e2e' };

let client;
let projectId;
let documentId;
let lex;
let gloss;
let sense = {};
let ids = {};

test.beforeAll(async () => {
  client = new PlaidClient(CORE, readToken().token);
  ({ projectId } = await getFixture());
  const full = await client.projects.get(projectId);
  const textLayer = full.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const layer = (role) => textLayer.tokenLayers.find((l) => roleOf(l) === role);
  const WORD = layer(ROLES.WORD);
  const MORPH = layer(ROLES.MORPHEME);
  gloss = MORPH.spanLayers.find((s) => s.name === 'Gloss');

  lex = await client.vocabLayers.create(`PAIR ${NONCE}`);
  const head = await client.vocabItems.create(lex.id, FORM);
  sense.feline = (
    await client.vocabItems.create(lex.id, FORM, {
      gloss: 'feline',
      parent: head.id,
      senseOrder: 1,
    })
  ).id;
  sense.jazzman = (
    await client.vocabItems.create(lex.id, FORM, {
      gloss: 'jazzman',
      parent: head.id,
      senseOrder: 2,
    })
  ).id;
  await client.projects.linkVocab(projectId, lex.id);

  documentId = (await client.documents.create(projectId, `pair-spec ${NONCE}`)).id;
  await client.texts.create(textLayer.id, documentId, BODY);
  const raw = await client.documents.get(documentId, true);
  const TEXT = raw.textLayers.find((l) => roleOf(l) === ROLES.BASELINE).text.id;
  const words = [...BODY.matchAll(/\S+/g)].map((m) => ({
    begin: m.index,
    end: m.index + m[0].length,
  }));
  await client.tokens.bulkCreate([
    { tokenLayerId: layer(ROLES.SENTENCE).id, text: TEXT, begin: 0, end: cpLength(BODY) },
  ]);
  await client.tokens.bulkCreate(words.map((w) => ({ tokenLayerId: WORD.id, text: TEXT, ...w })));
  await client.tokens.bulkCreate(
    words.map((w) => ({ tokenLayerId: MORPH.id, text: TEXT, ...w, precedence: 1 })),
  );
  const seeded = await client.documents.get(documentId, true);
  const ml = seeded.textLayers
    .find((l) => roleOf(l) === ROLES.BASELINE)
    .tokenLayers.find((l) => l.id === MORPH.id);
  ids.m = words.map((x) => ml.tokens.find((t) => t.begin === x.begin).id);
  await client.spans.create(gloss.id, [ids.m[0]], 'feline', {
    ...MACHINE,
    provDetail: {
      value: 'feline',
      valueProbs: { feline: 0.6, jazzman: 0.3 },
      valueLinks: [
        { value: 'feline', item: sense.feline, prob: 0.6 },
        { value: 'jazzman', item: sense.jazzman, prob: 0.3 },
      ],
    },
  });
  await client.vocabLinks.create(sense.feline, [ids.m[0]], MACHINE);
});

test.afterAll(async () => {
  if (documentId) await client.documents.delete(documentId).catch(() => {});
  if (lex) {
    await client.projects.unlinkVocab(projectId, lex.id).catch(() => {});
    await client.vocabLayers.delete(lex.id).catch(() => {});
  }
});

async function openAnalyze(page) {
  if (page.url() !== 'about:blank') await page.goto('about:blank');
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=analyze`);
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  await page.waitForLoadState('networkidle');
}

// What the server holds for a morpheme: its link's entry and its gloss.
const stored = async (morphId) => {
  const raw = await client.documents.get(documentId, true);
  const layers = raw.textLayers.flatMap((t) => t.tokenLayers);
  const link = layers
    .flatMap((l) => l.vocabs || [])
    .flatMap((v) => v.vocabLinks || [])
    .find((l) => l.tokens.length === 1 && l.tokens[0] === morphId);
  const span = layers
    .flatMap((l) => l.spanLayers || [])
    .find((s) => s.id === gloss.id)
    .spans.find((s) => s.tokens[0] === morphId);
  return { item: link?.vocabItem?.id ?? null, gloss: span?.value ?? null };
};
const saved = (page) => expect(page.locator('.igt-status[data-state="saving"]')).toHaveCount(0);

test('a pick from Alt+Down sets the link and the gloss, and both are there after a reload', async ({
  page,
}) => {
  await openAnalyze(page);
  const cell = page.locator(`.igt-field[data-cell-key="ma:${ids.m[0]}:Gloss"]`);
  await cell.click();
  await page.keyboard.press('Alt+ArrowDown');
  const rows = page.locator('.igt-alts__item');
  await expect(rows.nth(0).locator('.igt-pair__value')).toHaveText('feline');
  await expect(rows.nth(0)).toContainText('current');
  await expect(rows.nth(1).locator('.igt-pair__value')).toHaveText('jazzman');
  await expect(rows.nth(1)).toContainText('model 30%');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(cell).toHaveValue('jazzman');
  await saved(page);
  await openAnalyze(page);
  await expect(cell).toHaveValue('jazzman');
  expect(await stored(ids.m[0])).toEqual({ item: sense.jazzman, gloss: 'jazzman' });
});

test('a pick from the link chip sets the link and the gloss, and both are there after a reload', async ({
  page,
}) => {
  await openAnalyze(page);
  await page.locator(`button[data-vocab-opener="${ids.m[1]}"]`).click();
  const row = page.locator('.igt-vocab-pop__item', {
    has: page.locator('.igt-pair__value', { hasText: 'feline' }),
  });
  await row.first().click();
  const cell = page.locator(`.igt-field[data-cell-key="ma:${ids.m[1]}:Gloss"]`);
  await expect(cell).toHaveValue('feline');
  await saved(page);
  await openAnalyze(page);
  await expect(cell).toHaveValue('feline');
  expect(await stored(ids.m[1])).toEqual({ item: sense.feline, gloss: 'feline' });
});
