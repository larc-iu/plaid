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
const BODY = `${FORM} ${FORM} ${FORM}`;
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

test('Enter right after Alt+Down takes the highlighted row, link and gloss together', async ({
  page,
}) => {
  await openAnalyze(page);
  const cell = page.locator(`.igt-field[data-cell-key="ma:${ids.m[2]}:Gloss"]`);
  await cell.click();
  await page.keyboard.press('Alt+ArrowDown');
  const active = page.locator('.igt-alts__item.is-active');
  await expect(active.locator('.igt-pair__value')).toHaveText('feline');
  await page.keyboard.press('Enter');
  await expect(cell).toHaveValue('feline');
  await saved(page);
  await openAnalyze(page);
  await expect(cell).toHaveValue('feline');
  expect(await stored(ids.m[2])).toEqual({ item: sense.feline, gloss: 'feline' });
});

// The review's cases (REV-FX-R55): a typed value after Alt+Down, a governed
// cell reached by keyboard, the start row, a rebound chord, and R56's Type row
// under + Create. A lexicon and document of their own, and the Gloss layer's
// tagset put back afterwards.
test.describe('after review', () => {
  const NONCE = `r${Date.now().toString(36)}`;
  const FORM = `kat${NONCE}`;
  const N = 12;
  const BODY = Array(N).fill(FORM).join(' ');
  const MACHINE = { prov: 'inferred', provSource: 'service:e2e' };

  let client;
  let projectId;
  let documentId;
  let lex;
  let gloss;
  let head;
  let sense = {};
  let ids = {};
  let userId;

  test.beforeAll(async () => {
    const me = readToken();
    client = new PlaidClient(CORE, me.token);
    userId = me.userId;
    ({ projectId } = await getFixture());
    const full = await client.projects.get(projectId);
    const textLayer = full.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
    const layer = (role) => textLayer.tokenLayers.find((l) => roleOf(l) === role);
    const WORD = layer(ROLES.WORD);
    const MORPH = layer(ROLES.MORPHEME);
    gloss = MORPH.spanLayers.find((s) => s.name === 'Gloss');

    lex = await client.vocabLayers.create(`REV55 ${NONCE}`);
    head = (await client.vocabItems.create(lex.id, FORM, { morphType: 'stem' })).id;
    const mk = async (g, i) =>
      (await client.vocabItems.create(lex.id, FORM, { gloss: g, parent: head, senseOrder: i })).id;
    sense.feline = await mk('feline', 1);
    sense.jazzman = await mk('jazzman', 2);
    sense.fe = await mk('fe', 3);
    await client.projects.linkVocab(projectId, lex.id);

    documentId = (await client.documents.create(projectId, `rev55 ${NONCE}`)).id;
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
    // m0: a model's gloss and link. m1: a person's gloss "PL" and no link.
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
    await client.spans.create(gloss.id, [ids.m[1]], 'PL', {});
  });

  test.afterAll(async () => {
    await client.userData.delete(userId, 'igt:keymap').catch(() => {});
    if (documentId) await client.documents.delete(documentId).catch(() => {});
    if (lex) {
      await client.projects.unlinkVocab(projectId, lex.id).catch(() => {});
      await client.vocabLayers.delete(lex.id).catch(() => {});
    }
  });

  let writes = [];
  async function openAnalyze(page) {
    if (page.url() !== 'about:blank') await page.goto('about:blank');
    await seedAuth(page);
    page.removeAllListeners('request');
    page.on('request', (r) => {
      if (r.method() !== 'GET' && r.url().includes('/api/'))
        writes.push(
          `${r.method()} ${r.url().replace(/^.*\/api\/v1/, '')} ${(r.postData() || '').slice(0, 400)}`,
        );
    });
    await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=analyze`);
    await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
    await page.waitForLoadState('networkidle');
  }

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
  const name = (id) => Object.entries(sense).find(([, v]) => v === id)?.[0] ?? id;
  const show = async (tag, m) => {
    const s = await stored(m);
    console.log(`RESULT ${tag}: gloss=${s.gloss} link=${s.item ? name(s.item) : null}`);
    return s;
  };
  const saved = (page) => expect(page.locator('.igt-status[data-state="saving"]')).toHaveCount(0);
  const cellOf = (page, i) => page.locator(`.igt-field[data-cell-key="ma:${ids.m[i]}:Gloss"]`);
  const activeRow = async (page) => {
    const a = page.locator('.igt-alts__item.is-active');
    if (!(await a.count())) return '(none)';
    return (await a.first().textContent()).replace(/\s+/g, ' ').trim();
  };

  test.describe('R55', () => {
    test('B1 Alt+Down, type a value that is itself a row but not the first, Enter', async ({
      page,
    }) => {
      await openAnalyze(page);
      const cell = cellOf(page, 2);
      await cell.click();
      await page.keyboard.press('Alt+ArrowDown');
      await page.keyboard.type('fe');
      console.log('B1 rows', await page.locator('.igt-alts__item').allTextContents());
      console.log('B1 active', await activeRow(page));
      await page.screenshot({ path: test.info().outputPath('b1.png') });
      await page.keyboard.press('Enter');
      await saved(page);
      await page.waitForTimeout(500);
      const s = await show('B1 typed "fe"', ids.m[2]);
      expect.soft(s.gloss).toBe('fe');
    });

    test('B2 Alt+Down, type a new gloss that prefixes a row, Enter', async ({ page }) => {
      await openAnalyze(page);
      const cell = cellOf(page, 3);
      await cell.click();
      await page.keyboard.press('Alt+ArrowDown');
      await page.keyboard.type('fel');
      console.log('B2 active', await activeRow(page));
      await page.keyboard.press('Enter');
      await saved(page);
      await page.waitForTimeout(500);
      const s = await show('B2 typed "fel"', ids.m[3]);
      expect.soft(s.gloss).toBe('fel');
    });

    test('B3 no Alt+Down: type then Enter (no list), and Alt+Down Esc type Enter', async ({
      page,
    }) => {
      await openAnalyze(page);
      await cellOf(page, 4).click();
      await page.keyboard.type('fel');
      console.log('B3a list open', await page.locator('.igt-alts').count());
      await page.keyboard.press('Enter');
      await saved(page);
      await cellOf(page, 5).click();
      await page.keyboard.press('Alt+ArrowDown');
      await page.keyboard.press('Escape');
      await page.keyboard.type('fel');
      await page.keyboard.press('Enter');
      await saved(page);
      await page.waitForTimeout(500);
      expect.soft((await show('B3a type Enter', ids.m[4])).gloss).toBe('fel');
      expect.soft((await show('B3b Alt+Down Esc type Enter', ids.m[5])).gloss).toBe('fel');
    });

    test('B4 Alt+Down Enter on a person-glossed cell (PL, unlinked)', async ({ page }) => {
      await openAnalyze(page);
      await cellOf(page, 1).click();
      await page.keyboard.press('Alt+ArrowDown');
      console.log('B4 active', await activeRow(page));
      await page.keyboard.press('Enter');
      await saved(page);
      await page.waitForTimeout(500);
      expect
        .soft(await show('B4 Alt+Down Enter on PL', ids.m[1]))
        .toEqual({ item: null, gloss: 'PL' });
    });

    test('B5 rebound Alt+l, then Enter', async ({ page }) => {
      await client.userData.put(userId, 'igt:keymap', {
        metadata: { 'analyze.alternatives': ['Alt+l'] },
      });
      await openAnalyze(page);
      await cellOf(page, 6).click();
      await page.keyboard.press('Alt+ArrowDown');
      console.log('B5 list after old chord', await page.locator('.igt-alts__item').count());
      await page.keyboard.press('Escape');
      await cellOf(page, 6).click();
      await page.keyboard.press('Alt+l');
      console.log('B5 active', await activeRow(page));
      await page.keyboard.press('Enter');
      await saved(page);
      await page.waitForTimeout(500);
      const s = await show('B5 Alt+l Enter', ids.m[6]);
      expect.soft(s).toEqual({ item: sense.feline, gloss: 'feline' });
      await client.userData.delete(userId, 'igt:keymap').catch(() => {});
    });

    test.describe('governed Gloss (tagset T on the morpheme Gloss layer)', () => {
      let before;
      let beforeTagsets;
      const setTagset = async (mode) => {
        await client.projects.setConfig(projectId, 'igt', 'tagsets', {
          T: {
            mode,
            delimiters: '.',
            values: [{ value: 'PL' }, { value: 'SG' }, { value: 'DEF' }],
          },
        });
        await client.spanLayers.setConfig(gloss.id, 'igt', 'tagset', 'T');
      };
      test.beforeAll(async () => {
        const p = await client.projects.get(projectId);
        beforeTagsets = p.config?.igt?.tagsets;
        const g = p.textLayers
          .flatMap((t) => t.tokenLayers)
          .flatMap((t) => t.spanLayers || [])
          .find((s) => s.id === gloss.id);
        before = g.config?.igt?.tagset;
      });
      test.afterAll(async () => {
        if (beforeTagsets)
          await client.projects.setConfig(projectId, 'igt', 'tagsets', beforeTagsets);
        else await client.projects.deleteConfig?.(projectId, 'igt', 'tagsets').catch(() => {});
        if (before) await client.spanLayers.setConfig(gloss.id, 'igt', 'tagset', before);
        else await client.spanLayers.deleteConfig?.(gloss.id, 'igt', 'tagset').catch(() => {});
      });

      for (const mode of ['mixed', 'suggest', 'closed']) {
        test(`G-${mode}: untouched Enter on PL keeps PL, Alt+Down Enter on empty takes the row`, async ({
          page,
        }) => {
          await setTagset(mode);
          {
            const raw = await client.documents.get(documentId, true);
            const sp = raw.textLayers
              .flatMap((x) => x.tokenLayers)
              .flatMap((l) => l.spanLayers || [])
              .find((s) => s.id === gloss.id)
              .spans.find((s) => s.tokens[0] === ids.m[1]);
            if (sp) await client.spans.update(sp.id, 'PL');
            const lk = raw.textLayers
              .flatMap((x) => x.tokenLayers)
              .flatMap((l) => l.vocabs || [])
              .flatMap((v) => v.vocabLinks || [])
              .find((l) => l.tokens[0] === ids.m[1]);
            if (lk) await client.vocabLinks.delete(lk.id);
            const p = await client.projects.get(projectId);
            console.log(
              'cfg',
              JSON.stringify(p.config?.igt?.tagsets),
              JSON.stringify(
                p.textLayers
                  .flatMap((t) => t.tokenLayers)
                  .flatMap((t) => t.spanLayers || [])
                  .find((x) => x.id === gloss.id).config,
              ),
            );
          }
          await openAnalyze(page);
          console.log(
            'has-tagset',
            await cellOf(page, 1).getAttribute('data-has-tagset'),
            await cellOf(page, 1).inputValue(),
          );
          // Untouched PL, list opened by itself.
          await cellOf(page, 1).click();
          console.log(
            `G-${mode} self-opened`,
            await page.locator('.igt-alts__item').count(),
            'active',
            await activeRow(page),
          );
          await page.keyboard.press('Enter');
          await saved(page);
          // Empty cell, with a guess, Alt+Down then Enter.
          const i = { mixed: 7, suggest: 8, closed: 9 }[mode];
          const cell = cellOf(page, i);
          await cell.click();
          console.log(`G-${mode} placeholder`, await cell.getAttribute('placeholder'));
          await page.keyboard.press('Alt+ArrowDown');
          console.log(`G-${mode} after Alt+Down active`, await activeRow(page));
          await page.screenshot({ path: test.info().outputPath(`g-${mode}.png`) });
          await page.keyboard.press('Enter');
          await saved(page);
          await page.waitForTimeout(500);
          expect.soft((await show(`G-${mode} untouched Enter on PL`, ids.m[1])).gloss).toBe('PL');
          const s = await show(`G-${mode} Alt+Down Enter on empty`, ids.m[i]);
          // A closed tagset refuses the sense's gloss, so the row brings the link alone.
          expect
            .soft(s)
            .toEqual({ item: sense.feline, gloss: mode === 'closed' ? null : 'feline' });
          // Self-opened list, type a lexical gloss and Enter: the typed text.
          // Enter moved on to a governed cell, whose list opened over this one.
          await page.keyboard.press('Escape');
          await cellOf(page, 10).click();
          await page.keyboard.type('fel');
          console.log(`G-${mode} typed fel active`, await activeRow(page));
          await page.keyboard.press('Enter');
          await saved(page);
          await page.waitForTimeout(500);
          const t = await show(`G-${mode} type fel Enter`, ids.m[10]);
          // Clean up m7..m10 for the next mode.
          for (const j of [i, 10]) {
            const raw = await client.documents.get(documentId, true);
            const layers = raw.textLayers.flatMap((x) => x.tokenLayers);
            const sp = layers
              .flatMap((l) => l.spanLayers || [])
              .find((s) => s.id === gloss.id)
              .spans.find((s) => s.tokens[0] === ids.m[j]);
            if (sp) await client.spans.delete(sp.id).catch(() => {});
            const lk = layers
              .flatMap((l) => l.vocabs || [])
              .flatMap((v) => v.vocabLinks || [])
              .find((l) => l.tokens[0] === ids.m[j]);
            if (lk) await client.vocabLinks.delete(lk.id).catch(() => {});
          }
          if (mode !== 'closed') expect.soft(t.gloss).toBe('fel');
        });
      }

      test('K keyboard arrival (Shift+Enter) on a governed empty cell, then Alt+Down, Enter', async ({
        page,
      }) => {
        await setTagset('mixed');
        await openAnalyze(page);
        await cellOf(page, 8).click();
        await page.keyboard.press('Shift+Enter');
        await expect(cellOf(page, 7)).toBeFocused();
        console.log(
          'K list open on arrival',
          await page.locator('.igt-alts__item').count(),
          'active',
          await activeRow(page),
        );
        await page.keyboard.press('Alt+ArrowDown');
        console.log('K after Alt+Down active', await activeRow(page));
        await page.screenshot({ path: test.info().outputPath('k.png') });
        await page.keyboard.press('Enter');
        await saved(page);
        await page.waitForTimeout(500);
        const s = await show('K keyboard arrival, Alt+Down, Enter', ids.m[7]);
        expect.soft(s).toEqual({ item: sense.feline, gloss: 'feline' });
        // Untouched PL reached by keyboard: Enter keeps it.
        await cellOf(page, 2).click();
        await page.keyboard.press('Shift+Enter');
        await expect(cellOf(page, 1)).toBeFocused();
        console.log(
          'K2 list open on arrival',
          await page.locator('.igt-alts__item').count(),
          'active',
          await activeRow(page),
        );
        await page.keyboard.press('Enter');
        await saved(page);
        await page.waitForTimeout(500);
        expect.soft((await show('K2 keyboard arrival on PL, Enter', ids.m[1])).gloss).toBe('PL');
      });
    });
  });

  test.describe('R56', () => {
    const pop = (page) => page.locator('.igt-vocab-pop');
    const openCreate = async (page, i) => {
      await page.locator(`button[data-vocab-opener="${ids.m[i]}"]`).click();
      await pop(page).waitFor();
      await page.locator('.igt-vocab-pop__create').click();
      await page.waitForTimeout(400);
      await expect(page.locator('.igt-vocab-pop__create-input')).toBeVisible();
    };
    const items = async () => (await client.vocabLayers.get(lex.id, true)).items || [];

    test('C1 linked morpheme: choose suffix under Create, Enter creates a suffix, head untouched', async ({
      page,
    }) => {
      await openAnalyze(page);
      writes = [];
      await openCreate(page, 0);
      const row = page.locator('.igt-vocab-pop__type');
      console.log('C1 row', (await row.textContent()).replace(/\s+/g, ' '));
      await page.locator('select[aria-label="New entry morpheme type"]').selectOption('suffix');
      await page.waitForTimeout(500);
      console.log('C1 writes after choose', JSON.stringify(writes));
      expect.soft(writes).toEqual([]);
      console.log('C1 focus', await page.evaluate(() => document.activeElement?.className));
      await page.screenshot({ path: test.info().outputPath('c1.png') });
      await page.keyboard.press('Enter');
      await saved(page);
      await page.waitForTimeout(800);
      const all = await items();
      const made = all.filter((it) => !Object.values(sense).includes(it.id) && it.id !== head);
      console.log(
        'RESULT C1 new items',
        JSON.stringify(made.map((m) => ({ form: m.form, md: m.metadata }))),
      );
      console.log('RESULT C1 head', JSON.stringify(all.find((x) => x.id === head)?.metadata));
      expect.soft(made.length).toBe(1);
      expect.soft(made[0]?.metadata?.morphType).toBe('suffix');
      expect.soft(all.find((x) => x.id === head)?.metadata?.morphType).toBe('stem');
      const s = await stored(ids.m[0]);
      console.log('RESULT C1 m0 link', s.item === made[0]?.id ? 'new entry' : name(s.item));
    });

    test('C2 choose a type then Esc, Esc, outside click: nothing written', async ({ page }) => {
      await openAnalyze(page);
      const before = JSON.stringify(await items());
      const tokBefore = JSON.stringify(await stored(ids.m[11]));
      writes = [];
      await openCreate(page, 11);
      await page.locator('select[aria-label="New entry morpheme type"]').selectOption('prefix');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const row = page.locator('.igt-vocab-pop__type');
      console.log(
        'C2 row after Esc',
        (await row.textContent().catch(() => '(gone)')).replace(/\s+/g, ' '),
      );
      console.log(
        'C2 selected after Esc',
        await row
          .locator('select')
          .inputValue()
          .catch(() => '(none)'),
      );
      // Re-open create: it starts at none again.
      await page.locator('.igt-vocab-pop__create').click();
      await page.waitForTimeout(400);
      console.log(
        'C2 reopened selected',
        await page.locator('select[aria-label="New entry morpheme type"]').inputValue(),
      );
      await page.locator('select[aria-label="New entry morpheme type"]').selectOption('suffix');
      await page.mouse.click(5, 5);
      await page.waitForTimeout(800);
      // And a third time with the select focused, Escape twice.
      await page.locator(`button[data-vocab-opener="${ids.m[11]}"]`).click();
      await page.locator('.igt-vocab-pop__create').click();
      await page.waitForTimeout(400);
      await page.locator('select[aria-label="New entry morpheme type"]').focus();
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(200);
      console.log(
        'C2 focus after keyboard choose',
        await page.evaluate(() => document.activeElement?.className),
      );
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
      console.log('RESULT C2 writes', JSON.stringify(writes));
      expect.soft(writes).toEqual([]);
      expect.soft(JSON.stringify(await items())).toBe(before);
      expect.soft(JSON.stringify(await stored(ids.m[11]))).toBe(tokBefore);
      // Now the morpheme's own row works again: open the chip, set its type.
      await page.locator(`button[data-vocab-opener="${ids.m[11]}"]`).click();
      const r = page.locator('.igt-vocab-pop__type');
      console.log('C2 row without create', (await r.textContent()).replace(/\s+/g, ' '));
    });

    test('C3 chosen type, then the form typed and Enter: one create with that type', async ({
      page,
    }) => {
      await openAnalyze(page);
      writes = [];
      await openCreate(page, 11);
      await page.locator('select[aria-label="New entry morpheme type"]').selectOption('enclitic');
      await page.locator('.igt-vocab-pop__create-input').fill(`${FORM}x`);
      await page.keyboard.press('Enter');
      await saved(page);
      await page.waitForTimeout(2000);
      // + Create puts the entry in the popover's first lexicon, which may be
      // another of the project's.
      const vocabIds = ((await client.projects.get(projectId)).vocabs || []).map((v) => v.id);
      const all3 = (
        await Promise.all(vocabIds.map((id) => client.vocabLayers.get(id, true)))
      ).flatMap((v) => v.items || []);
      console.log('C3 forms', JSON.stringify(all3.map((i) => i.form)));
      const made = all3.filter((it) => it.form === `${FORM}x`);
      console.log('RESULT C3', JSON.stringify(made.map((m) => m.metadata)));
      expect.soft(made.map((m) => m.metadata?.morphType)).toEqual(['enclitic']);
      console.log('C3 writes', JSON.stringify(writes).slice(0, 1500));
    });
  });
});
