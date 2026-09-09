import PlaidClient, { ROLES, cpLength, stampInferred } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';

// Does the confirmation wash actually PAINT? The unit tests only prove the
// class lands on the right node. The wash is a `background` keyframe reading a
// custom property, on a wrapper the animated element sits inside, so it can be
// on the right node and still be invisible: covered by an opaque child, or on
// a wrapper with no box. This samples the computed background mid-animation
// through the real grid, once per gesture.
//
// Throwaway document in the "E2E IGT Fixture" project, deleted afterwards.

const CORE = 'http://localhost:8085';
const roleOf = (l) => l?.config?.plaid?.role;
const NONCE = Date.now().toString(36);
const BODY = `dup${NONCE} dup${NONCE} dup${NONCE}`;

let client;
let projectId;
let documentId;
let ids = {};

test.beforeAll(async () => {
  client = new PlaidClient(CORE, readToken().token);
  const project = (await client.projects.list()).find((p) => p.name === 'E2E IGT Fixture');
  if (!project) throw new Error('run node e2e/fixture.js first');
  projectId = project.id;
  const full = await client.projects.get(projectId);
  const textLayer = full.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const layer = (role) => textLayer.tokenLayers.find((l) => roleOf(l) === role);
  const WORD = layer(ROLES.WORD);
  const MORPH = layer(ROLES.MORPHEME);
  const SENT = layer(ROLES.SENTENCE);
  const gloss = MORPH.spanLayers.find((s) => s.name === 'Gloss');
  const translation = SENT.spanLayers.find((s) => s.name === 'Translation');

  const created = await client.documents.create(projectId, `pulse-spec ${Date.now()}`);
  documentId = created.id;
  await client.texts.create(textLayer.id, documentId, BODY);
  const raw = await client.documents.get(documentId, true);
  const TEXT = raw.textLayers.find((l) => roleOf(l) === ROLES.BASELINE).text.id;
  const words = [...BODY.matchAll(/\S+/g)].map((m) => ({
    begin: m.index,
    end: m.index + m[0].length,
  }));
  await client.tokens.bulkCreate([
    { tokenLayerId: SENT.id, text: TEXT, begin: 0, end: cpLength(BODY) },
  ]);
  await client.tokens.bulkCreate(words.map((w) => ({ tokenLayerId: WORD.id, text: TEXT, ...w })));
  await client.tokens.bulkCreate(
    words.map((w) => ({ tokenLayerId: MORPH.id, text: TEXT, ...w, precedence: 1 })),
  );
  const seeded = await client.documents.get(documentId, true);
  const tl = seeded.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const ml = tl.tokenLayers.find((l) => roleOf(l) === ROLES.MORPHEME);
  const sl = tl.tokenLayers.find((l) => roleOf(l) === ROLES.SENTENCE);
  ids = {
    m: words.map((x) => ml.tokens.find((t) => t.begin === x.begin).id),
    s: sl.tokens[0].id,
  };
  // Three identical forms, one job each: the first carries a gloss made by a
  // person and the second the same gloss from a model, which between them are
  // the majority the THIRD is offered as a guess (a TIE produces none, which
  // is why both say the same thing); the second doubles as the machine-made
  // material the whole-word gesture accepts. The third is left empty.
  const machine = stampInferred('service:pulse-spec', { prob: 0.8 });
  await client.spans.create(gloss.id, [ids.m[0]], 'PRECEDENT');
  await client.spans.create(gloss.id, [ids.m[1]], 'PRECEDENT', machine);
  await client.spans.create(translation.id, [ids.s], 'a machine translation', machine);

  // An auto-made link nobody has confirmed, on the third morpheme: this is the
  // violet chip Enter confirms, and the gesture the whole question started on.
  const vocab = (await client.vocabLayers.list()).find((v) => v.name === 'IGT Lexicon');
  const entry = await client.vocabItems.create(vocab.id, `dup${NONCE}`);
  ids.entry = entry.id;
  await client.vocabLinks.create(entry.id, [ids.m[2]], machine);
});

test.afterAll(async () => {
  if (documentId) await client.documents.delete(documentId).catch(() => {});
});

async function openAnalyze(page) {
  if (page.url() !== 'about:blank') await page.goto('about:blank');
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=analyze`);
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  await page.waitForLoadState('networkidle');
}

// The painted background of the cell's pulse wrapper a few frames into the
// animation, plus what it settles back to. `alpha > 0` is the whole claim:
// rgba(0, 0, 0, 0) is what an element with no wash reports.
//
// The wrapper is reached with closest(), never an xpath ancestor test: the
// sentence row's own parent is `.igt-sentence-annos`, which contains the
// singular class as a SUBSTRING, so a contains() selector silently samples the
// wrong div and reports no wash on a pulse that is painting perfectly.
async function washOf(page, cellSelector, wrapper) {
  const read = () =>
    page.$eval(
      cellSelector,
      (el, w) => {
        const box = el.closest(w);
        return box ? getComputedStyle(box).backgroundColor : 'NO WRAPPER';
      },
      wrapper,
    );
  const during = await read();
  await page.waitForTimeout(600);
  return { during, after: await read() };
}

const alphaOf = (rgba) => {
  const m = rgba.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(',').map((s) => parseFloat(s));
  return parts.length === 4 ? parts[3] : 1;
};

test.describe('the confirmation wash paints, on every gesture', () => {
  test('Ctrl+Enter on a word washes the column in the word scope blue', async ({ page }) => {
    await openAnalyze(page);
    const cell = page.locator(`[data-cell-key="ma:${ids.m[1]}:Gloss"]`);
    await cell.click();
    await cell.press('Control+Enter');
    const { during, after } = await washOf(
      page,
      `[data-cell-key="ma:${ids.m[1]}:Gloss"]`,
      '[data-word-col]',
    );
    expect(alphaOf(during)).toBeGreaterThan(0);
    // Blue, not teal: the column is word scope.
    expect(during).toContain('37, 99, 235');
    expect(alphaOf(after)).toBe(0);
  });

  test('Enter adopting a guess washes that one cell, in the morpheme teal', async ({ page }) => {
    await openAnalyze(page);
    const target = page.locator(`[data-cell-key="ma:${ids.m[2]}:Gloss"]`);
    // Empty, and showing the precedent from the first word as a placeholder:
    // this is the cell Enter adopts. Assert the guess is really on offer, or
    // the gesture below is a no-op and the whole check passes vacuously.
    await expect(target).toHaveValue('');
    await expect(target).toHaveAttribute('placeholder', 'PRECEDENT');
    await target.click();
    await target.press('Enter');
    const { during, after } = await washOf(
      page,
      `[data-cell-key="ma:${ids.m[2]}:Gloss"]`,
      '.igt-morph-cell',
    );
    expect(alphaOf(during)).toBeGreaterThan(0);
    // Teal, not blue: a morpheme cell is morpheme scope.
    expect(during).toContain('15, 118, 110');
    expect(alphaOf(after)).toBe(0);
  });

  test('Enter on an unconfirmed link chip washes that link, in the morpheme teal', async ({
    page,
  }) => {
    await openAnalyze(page);
    const chip = page.locator('.igt-vocab__hint--machine').first();
    // A machine chip really is on offer, or the gesture below is a no-op.
    await expect(chip).toBeVisible();
    await chip.focus();
    await chip.press('Enter');
    const { during, after } = await washOf(page, '.igt-vocab__hint', '.igt-vocab');
    expect(alphaOf(during)).toBeGreaterThan(0);
    expect(during).toContain('15, 118, 110');
    expect(alphaOf(after)).toBe(0);
  });

  test('Ctrl+Enter on a Translation washes that row', async ({ page }) => {
    await openAnalyze(page);
    const t = page.locator(`[data-cell-key="sa:${ids.s}:Translation"]`);
    await t.click();
    await t.press('Control+Enter');
    const { during, after } = await washOf(
      page,
      `[data-cell-key="sa:${ids.s}:Translation"]`,
      '.igt-sentence-anno',
    );
    expect(alphaOf(during)).toBeGreaterThan(0);
    expect(alphaOf(after)).toBe(0);
  });
});
