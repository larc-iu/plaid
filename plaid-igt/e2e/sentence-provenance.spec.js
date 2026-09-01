import PlaidClient, { ROLES, cpLength, stampInferred } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';

// A machine-made sentence value (a proposed translation) renders with the
// same provenance styling as cells, is a stop in the unverified review
// sweep, and Ctrl+Enter confirms it as is. Throwaway document in the
// "E2E IGT Fixture" project.

const CORE = 'http://localhost:8085';
const roleOf = (l) => l?.config?.plaid?.role;

let client;
let projectId;
let documentId;
let sid;
let trLayer;
let spanId;

test.beforeAll(async () => {
  client = new PlaidClient(CORE, readToken().token);
  const project = (await client.projects.list()).find((p) => p.name === 'E2E IGT Fixture');
  if (!project) throw new Error('run node e2e/fixture.js first');
  projectId = project.id;
  const full = await client.projects.get(projectId);
  const textLayer = full.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const layer = (role) => textLayer.tokenLayers.find((l) => roleOf(l) === role);
  const SENT = layer(ROLES.SENTENCE);
  trLayer = SENT.spanLayers.find((s) => s.name === 'Translation') || SENT.spanLayers[0];
  const body = `zol${Date.now().toString(36)} mesa`;
  const created = await client.documents.create(projectId, `sentence-prov ${Date.now()}`);
  documentId = created.id;
  await client.texts.create(textLayer.id, documentId, body);
  const raw = await client.documents.get(documentId, true);
  const TEXT = raw.textLayers.find((l) => roleOf(l) === ROLES.BASELINE).text.id;
  const words = [...body.matchAll(/\S+/g)].map((m) => ({
    begin: m.index,
    end: m.index + m[0].length,
  }));
  const s = await client.tokens.bulkCreate([
    { tokenLayerId: SENT.id, text: TEXT, begin: 0, end: cpLength(body) },
  ]);
  sid = s.ids[0];
  await client.tokens.bulkCreate(
    words.map((w) => ({ tokenLayerId: layer(ROLES.WORD).id, text: TEXT, ...w })),
  );
  await client.tokens.bulkCreate(
    words.map((w) => ({ tokenLayerId: layer(ROLES.MORPHEME).id, text: TEXT, ...w, precedence: 1 })),
  );
  if (trLayer) {
    const span = await client.spans.create(trLayer.id, [sid], 'a machine draft', {
      ...stampInferred('service:llm-translator'),
      provDetail: { model: 'test', value: 'a machine draft' },
    });
    spanId = span.id;
  }
});

test.afterAll(async () => {
  if (documentId) await client.documents.delete(documentId).catch(() => {});
});

test('a machine translation is violet, a sweep stop, and Ctrl+Enter confirms it as is', async ({
  page,
}) => {
  test.skip(!trLayer, 'fixture project has no sentence field');
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=analyze`);
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  const tr = page.locator(`.igt-field[data-cell-key="sa:${sid}:${trLayer.name}"]`);
  await expect(tr).toHaveValue('a machine draft');
  await expect(tr).toHaveClass(/igt-field--machine/);
  await expect(tr).toHaveAttribute('title', /Ctrl\+Enter confirms/);
  // The review sweep from a word cell lands on the translation.
  const firstCell = page.locator('.igt-island input.igt-field').first();
  await firstCell.click();
  await page.keyboard.press('Control+Shift+ArrowDown');
  await expect(tr).toBeFocused();
  // Ctrl+Enter confirms as is: value kept, verified styling, provConfirmed on the server.
  await page.keyboard.press('Control+Enter');
  await expect(tr).toHaveClass(/igt-field--verified/);
  await expect(tr).toHaveValue('a machine draft');
  await page.waitForLoadState('networkidle');
  const span = await client.spans.get(spanId);
  expect(span.metadata?.provConfirmed).toBe(true);
  expect(span.metadata?.provSource).toBe('service:llm-translator');
  expect(span.value).toBe('a machine draft');
});

test('Ctrl+Backspace discards a proposed translation, but never a human one', async ({ page }) => {
  test.skip(!trLayer, 'fixture project has no sentence field');
  // Put the draft back to machine-unverified (the row above confirms it), so
  // this row stands on its own whichever way the file is run.
  await client.spans.setMetadata(spanId, {
    ...stampInferred('service:llm-translator'),
    provDetail: { model: 'test', value: 'a machine draft' },
  });
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=analyze`);
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  const tr = page.locator(`.igt-field[data-cell-key="sa:${sid}:${trLayer.name}"]`);
  await expect(tr).toHaveClass(/igt-field--machine/);
  await tr.click();
  await page.keyboard.press('Control+Backspace');
  await expect(tr).toHaveValue('');
  await page.waitForLoadState('networkidle');
  await expect
    .poll(async () => {
      try {
        await client.spans.get(spanId);
        return 'present';
      } catch {
        return 'gone';
      }
    })
    .toBe('gone');

  // A human translation is not a proposal: the chord stays the browser's
  // delete-previous-word and the value survives untouched on the server.
  const human = await client.spans.create(trLayer.id, [sid], 'a person wrote this');
  await page.goto('about:blank');
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=analyze`);
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  const tr2 = page.locator(`.igt-field[data-cell-key="sa:${sid}:${trLayer.name}"]`);
  await expect(tr2).toHaveValue('a person wrote this');
  await tr2.click();
  await page.keyboard.press('Control+Backspace');
  await page.keyboard.press('Escape'); // drop whatever the browser edit did
  await page.waitForLoadState('networkidle');
  expect((await client.spans.get(human.id)).value).toBe('a person wrote this');
  await client.spans.delete(human.id).catch(() => {});
});
