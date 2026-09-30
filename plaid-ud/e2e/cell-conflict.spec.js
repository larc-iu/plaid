// Luke's ruling Q1: an annotation cell's edit refused because another tab
// stored another value first. The cell shows the stored value, with the
// refused one under it ("Yours: hound · Enter to keep yours"), and a toast
// names the change. Leaving the cell sends nothing, Enter back in it stores
// the refused value, and Escape lets it go. Tab B's write is held until tab
// A's has landed, so B's goes out on a document that has moved on and the
// server refuses it. LEMMA is a plain input and UPOS a combobox, where Enter
// keeps yours only with no option highlighted.
// Seeds 'the dog runs fast' in a throwaway project, deleted afterwards.
import { test, expect, seedAuth } from './fixtures.js';
import { seedUdDoc } from './seedUdDoc.js';
import { getUdLayerInfo } from '../src/utils/udLayerUtils.js';

const S = {};

test.beforeAll(async () => {
  Object.assign(
    S,
    await seedUdDoc(`Cell conflict ${Date.now()}`, 'the dog runs fast', [
      [0, 3],
      [4, 7],
      [8, 12],
      [13, 17],
    ]),
  );
});

test.afterAll(async () => {
  if (S.client && S.projectId) {
    await S.client.projects
      .delete(S.projectId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

const stored = async (morphId, field) => {
  const info = getUdLayerInfo(await S.client.documents.get(S.documentId, true));
  const layer = { lemma: info.lemmaLayer, upos: info.uposLayer }[field];
  return (layer.spans || []).find((s) => s.tokens[0] === morphId)?.value ?? null;
};

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const READ_POST = /\/api\/v1\/(query|login)(\?|$)/;
const isWrite = (req) => WRITE.has(req.method()) && !READ_POST.test(req.url());

// A tab whose writes can be held (`hold()` answers the release) and counted.
async function openTab(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const tab = { ctx, page, writes: 0, gate: null };
  await page.route(/\/api\/v1\//, async (route) => {
    const req = route.request();
    if (isWrite(req)) {
      tab.writes += 1;
      if (tab.gate) await tab.gate;
    }
    await route.continue().catch(() => {});
  });
  tab.hold = () => {
    let release;
    tab.gate = new Promise((r) => (release = r));
    return () => {
      tab.gate = null;
      release();
    };
  };
  await seedAuth(page);
  await page.goto(`/#/projects/${S.projectId}/documents/${S.documentId}/annotate`);
  await page.locator(`[id="${S.morphIds[0]}-lemma"]`).waitFor({ state: 'visible' });
  await page.waitForLoadState('networkidle');
  return tab;
}

const cellOf = (page, morphId, field) => page.locator(`[id="${morphId}-${field}"]`);

async function typeInto(page, morphId, field, value) {
  await cellOf(page, morphId, field).click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(value);
  await page.keyboard.press('Enter');
}

// B types `mine` into `field` of `morphId` with its write held, A stores
// `theirs` there, and B's write goes out after it.
async function loseTo(A, B, morphId, field, mine, theirs) {
  const release = B.hold();
  await typeInto(B.page, morphId, field, mine);
  await typeInto(A.page, morphId, field, theirs);
  await expect.poll(() => stored(morphId, field)).toBe(theirs);
  release();
  await expect.poll(() => B.page.locator(`[id="${morphId}-${field}"]`).inputValue()).toBe(theirs);
}

for (const [field, mine, theirs, word] of [
  ['lemma', 'hound', 'dog', 0],
  ['upos', 'NOUN', 'VERB', 1],
]) {
  test(`a lost ${field} shows the stored value and yours under it, and Enter keeps yours`, async ({
    browser,
  }) => {
    const A = await openTab(browser);
    const B = await openTab(browser);
    const morphId = S.morphIds[word];
    try {
      await loseTo(A, B, morphId, field, mine, theirs);
      const cell = cellOf(B.page, morphId, field);
      const note = B.page.locator(`[id="${morphId}-${field}-conflict"]`);
      await expect(note).toHaveText(`Yours: ${mine} · Enter to keep yours`);
      await expect(cell).toHaveClass(/editable-field--conflict/);
      await expect(cell).toHaveAttribute('aria-describedby', `${morphId}-${field}-conflict`);
      await expect(
        B.page
          .locator('[data-sonner-toast]')
          .filter({ hasText: new RegExp(`changed this to ${theirs}\\.`) }),
      ).toBeVisible();

      // Leaving the cell sends nothing.
      const before = B.writes;
      await cell.click();
      await B.page.keyboard.press('Tab');
      await B.page.waitForTimeout(800);
      expect(B.writes).toBe(before);
      expect(await stored(morphId, field)).toBe(theirs);
      await expect(note).toHaveText(`Yours: ${mine} · Enter to keep yours`);

      // Enter back in the cell, with nothing typed, stores yours.
      await cell.click();
      await B.page.keyboard.press('Enter');
      await expect.poll(() => stored(morphId, field)).toBe(mine);
      await expect(cell).toHaveValue(mine);
      await expect(note).toHaveCount(0);
    } finally {
      await A.ctx.close();
      await B.ctx.close();
    }
  });
}

test('Escape lets a lost lemma go, and the stored value stays', async ({ browser }) => {
  const A = await openTab(browser);
  const B = await openTab(browser);
  const morphId = S.morphIds[2];
  try {
    await loseTo(A, B, morphId, 'lemma', 'sprint', 'run');
    const cell = cellOf(B.page, morphId, 'lemma');
    const note = B.page.locator(`[id="${morphId}-lemma-conflict"]`);
    await expect(note).toHaveText('Yours: sprint · Enter to keep yours');
    const before = B.writes;
    await cell.click();
    await B.page.keyboard.press('Escape');
    await expect(note).toHaveCount(0);
    await expect(cell).not.toHaveClass(/editable-field--conflict/);
    await expect(cell).toHaveValue('run');
    await B.page.waitForTimeout(800);
    expect(B.writes).toBe(before);
    expect(await stored(morphId, 'lemma')).toBe('run');
  } finally {
    await A.ctx.close();
    await B.ctx.close();
  }
});
