import PlaidClient, { ROLES, stampInferred, cpLength } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';

// TEST_PLAN A2/A4 UI rows: how machine material looks and behaves in the
// Analyze island (cell classes, one-batch edits, Enter/Backspace review keys on
// chips, Ctrl+Enter confirming a word and moving on, the popover's confirm
// affordance). The data-level contract behind these lives in
// e2e/provenance-structural-live.mjs. Uses a throwaway document + throwaway
// vocab entries in the "E2E IGT Fixture" project; both are deleted afterwards.

const CORE = 'http://localhost:8085';
const roleOf = (l) => l?.config?.plaid?.role;
const BODY = 'alpha beta gamma delta epsilon';

let client;
let projectId;
let documentId;
let ids = {}; // seeded entity ids
let items = {};

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
  const gloss = MORPH.spanLayers.find((s) => s.name === 'Gloss');
  const pos = WORD.spanLayers.find((s) => s.name === 'Part of Speech');
  const vocab = full.vocabs.find((v) => v.name === 'IGT Lexicon');
  const stamp = Date.now();
  for (const f of ['one', 'two', 'three']) {
    const it = await client.vocabItems.create(vocab.id, `${f}-${stamp}`);
    items[f] = { id: it.id, form: `${f}-${stamp}` };
  }

  const created = await client.documents.create(projectId, `prov-spec ${stamp}`);
  documentId = created.id;
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
  const tl = seeded.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const wl = tl.tokenLayers.find((l) => l.id === WORD.id);
  const ml = tl.tokenLayers.find((l) => l.id === MORPH.id);
  const w = (i) => wl.tokens.find((t) => t.begin === words[i].begin);
  const m = (i) => ml.tokens.find((t) => t.begin === words[i].begin);
  ids = { w: words.map((_, i) => w(i).id), m: words.map((_, i) => m(i).id) };
  // alpha: machine gloss. beta, gamma: machine links. delta: machine POS on the
  // word + machine link on its morpheme (Ctrl+Enter target). epsilon: plain.
  ids.alphaGloss = (
    await client.spans.create(
      gloss.id,
      [ids.m[0]],
      'MACH',
      stampInferred('service:test', { prob: 0.4 }),
    )
  ).id;
  await client.vocabLinks.create(
    items.one.id,
    [ids.m[1]],
    stampInferred('rule:precedent-or-unique'),
  );
  await client.vocabLinks.create(
    items.two.id,
    [ids.m[2]],
    stampInferred('rule:precedent-or-unique'),
  );
  await client.spans.create(pos.id, [ids.w[3]], 'N', stampInferred('service:test'));
  await client.vocabLinks.create(
    items.three.id,
    [ids.m[3]],
    stampInferred('rule:precedent-or-unique'),
  );
});

test.afterAll(async () => {
  if (documentId) await client.documents.delete(documentId).catch(() => {});
  for (const it of Object.values(items)) await client.vocabItems.delete(it.id).catch(() => {});
});

async function openAnalyze(page) {
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=analyze`);
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  await page.waitForLoadState('networkidle');
}

const writes = (page) => {
  const seen = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET' && r.url().includes('/api/v1/'))
      seen.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  return seen;
};

test('A2-03/05: editing a machine gloss verifies it in one batch; clearing deletes the span', async ({
  page,
}) => {
  await openAnalyze(page);
  const cell = page.locator(`.igt-field[data-cell-key="ma:${ids.m[0]}:Gloss"]`);
  await expect(cell).toHaveClass(/igt-field--machine/);
  await expect(cell).toHaveAttribute('title', /machine-suggested, unverified/);
  const seen = writes(page);
  await cell.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('FIX');
  await page.keyboard.press('Enter');
  await expect(cell).toHaveClass(/igt-field--verified/);
  await page.waitForLoadState('networkidle');
  expect(seen, 'one atomic batch (update + setMetadata)').toEqual(['POST /api/v1/batch']);
  await expect(cell).toHaveValue('FIX');

  seen.length = 0;
  await cell.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Enter');
  await expect(cell).not.toHaveClass(/igt-field--(machine|verified)/);
  await page.waitForLoadState('networkidle');
  expect(seen).toEqual([`DELETE /api/v1/spans/${ids.alphaGloss}`]);
  await expect(cell).toHaveValue('');
  // Persisted: a reload shows an empty, plain cell.
  await openAnalyze(page);
  await expect(page.locator(`.igt-field[data-cell-key="ma:${ids.m[0]}:Gloss"]`)).toHaveValue('');
});

test('A4-05/06: Enter confirms the focused machine chip and Delete unlinks, focus advancing each time', async ({
  page,
}) => {
  await openAnalyze(page);
  const chip = (tokenId) => page.locator(`button.igt-vocab__hint[data-vocab-opener="${tokenId}"]`);
  await expect(chip(ids.m[1])).toHaveClass(/igt-vocab__hint--machine/);
  await expect(chip(ids.m[1])).toHaveAttribute(
    'title',
    /Auto-linked to .*open to confirm or change/,
  );
  await chip(ids.m[1]).focus();
  await page.keyboard.press('Enter');
  await expect(chip(ids.m[1])).toHaveClass(/igt-vocab__hint--verified/);
  await expect(chip(ids.m[1])).toHaveAttribute('title', /auto-linked, confirmed/);
  // Focus moved on to the next machine chip (gamma).
  await expect(chip(ids.m[2])).toBeFocused();
  await page.keyboard.press('Delete');
  await expect(chip(ids.m[2])).toHaveCount(0);
  await expect(chip(ids.m[3])).toBeFocused();
  // Ctrl+Up from delta's chip hops back... to nothing (beta is verified now), so
  // focus stays; Ctrl+Down at the end likewise.
  await page.keyboard.press('Control+ArrowDown');
  await expect(chip(ids.m[3])).toBeFocused();
  await page.waitForLoadState('networkidle');
  const reload = await client.documents.get(documentId, true);
  const links = reload.textLayers[0].tokenLayers
    .flatMap((l) => l.vocabs || [])
    .flatMap((v) => v.vocabLinks || []);
  expect(
    links.some((l) => l.tokens[0] === ids.m[2]),
    'gamma link deleted server-side',
  ).toBe(false);
  expect(
    links.find((l) => l.tokens[0] === ids.m[1])?.metadata?.provConfirmed,
    'beta link confirmed server-side',
  ).toBe(true);
});

test('A2-08: Ctrl+Enter confirms the whole word in one batch and moves to the next word', async ({
  page,
}) => {
  await openAnalyze(page);
  const posCell = page.locator(`.igt-field[data-cell-key="wa:${ids.w[3]}:Part of Speech"]`);
  const chip = page.locator(`button.igt-vocab__hint[data-vocab-opener="${ids.m[3]}"]`);
  await expect(posCell).toHaveClass(/igt-field--machine/);
  await expect(chip).toHaveClass(/igt-vocab__hint--machine/);
  const seen = writes(page);
  const form = page.locator(`.igt-morph-field[data-word="${ids.w[3]}"]`);
  await form.click();
  await page.keyboard.press('Control+Enter');
  await expect(posCell).toHaveClass(/igt-field--verified/);
  await expect(chip).toHaveClass(/igt-vocab__hint--verified/);
  await page.waitForLoadState('networkidle');
  expect(seen).toEqual(['POST /api/v1/batch']);
  // Same tier (morpheme form) of the next word is focused.
  await expect(page.locator(`.igt-morph-field[data-word="${ids.w[4]}"]`)).toBeFocused();
  // Nothing left to confirm: Ctrl+Enter again writes nothing.
  seen.length = 0;
  await form.click();
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(500);
  expect(seen).toEqual([]);
});
