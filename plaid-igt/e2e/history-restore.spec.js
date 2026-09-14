import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';
import { createScratchProject } from './fixtureProject.js';

// Time travel and the restore it leads to, end to end: the History drawer, the
// snapshot the grid shows, and the server-side restore.
//
// Everything here was covered only by `useHistoryView.test.jsx` (the state
// machine, against a stub document) and `e2e/live/restore-big.mjs` (a hand-run
// probe with no browser in it). Nothing drove the drawer.
//
// The document is seeded in a THROWAWAY project, not in the shared fixture: a
// restore rewrites a whole document, and a run that dies partway leaves it
// rewritten for every other spec in the tree.

const CORE = 'http://localhost:8085';
const GLOSS_CELL = '.igt-field[data-cell-key^="ma:"]';

let projectId;
let documentId;
// How many history entries the seeding left, so the edit below can be waited
// for without guessing at a number.
let seededEntries;

const client = () => new PlaidClient(CORE, readToken().token);

const documentPath = () => `/#/projects/${projectId}/documents/${documentId}?tab=analyze`;

// The first morpheme's Gloss cell, which is where every value below is read.
const glossCell = (page) => page.locator(GLOSS_CELL).first();

// A drawer row, by the operation message it was written under. The list is
// above the footer in the DOM, so the first match is the row rather than the
// footer's copy of the selected entry's label.
const entryRow = (page, label) => page.getByText(label, { exact: true }).first();

const setGloss = async (message, value) => {
  const c = client();
  const raw = await c.documents.get(documentId, true);
  const span = raw.textLayers
    .flatMap((tl) => tl.tokenLayers || [])
    .flatMap((tkl) => tkl.spanLayers || [])
    .flatMap((sl) => sl.spans || [])[0];
  await c.withOperation(message, async () => {
    await c.spans.update(span.id, value);
  });
};

const openDocument = async (page) => {
  await page.goto(documentPath());
  await expect(page.getByRole('tab', { name: 'Analyze' })).toBeVisible({ timeout: 20_000 });
  await expect(glossCell(page)).toBeVisible({ timeout: 20_000 });
};

const openHistory = async (page) => {
  // Not the edge rail, which opens the same drawer under another name.
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByText(/^\d+ entries$/)).toBeVisible({ timeout: 15_000 });
};

// The audit time an entry travels to, which is also the `as-of` its snapshot
// read carries.
const entryTime = async (message) => {
  const entries = await client().documents.audit(documentId);
  const entry = entries.find((e) => e.message === message);
  expect(entry, `audit entry "${message}"`).toBeTruthy();
  return entry.endTime || entry.time;
};

test.beforeAll(async () => {
  ({ projectId, documentId } = await createScratchProject({
    name: `E2E Restore Fixture ${Date.now()}`,
    docName: 'Restorable Document',
    body: 'Alpha beta gamma.',
  }));
  const c = client();
  const raw = await c.documents.get(documentId, true);
  const tl = raw.textLayers[0];
  const glossLayer = tl.tokenLayers
    .flatMap((t) => t.spanLayers || [])
    .find((s) => s.name === 'Gloss');
  const morphemes = tl.tokenLayers
    .find((t) => t.config?.plaid?.role === 'morpheme')
    .tokens.slice()
    .sort((a, b) => a.begin - b.begin);
  await c.withOperation('Seed the original gloss', async () => {
    await c.spans.create(glossLayer.id, [morphemes[0].id], 'ORIGINAL');
  });
  seededEntries = (await c.documents.audit(documentId)).length;
});

test.afterAll(async () => {
  if (!projectId) return;
  await client()
    .projects.delete(projectId)
    .catch((e) => console.error('cleanup failed:', e.message));
});

test('a snapshot can be viewed, left, and restored to', async ({ page }) => {
  await seedAuth(page);
  await openDocument(page);
  await expect(glossCell(page)).toHaveValue('ORIGINAL');

  // An edit through the grid, so the entry the restore goes back past is one a
  // linguist actually made.
  const cell = glossCell(page);
  await cell.click();
  await cell.fill('CHANGED');
  await cell.press('Enter');
  await expect(cell).toHaveValue('CHANGED');
  await expect
    .poll(async () => (await client().documents.audit(documentId)).length, { timeout: 15_000 })
    .toBeGreaterThan(seededEntries);

  await openHistory(page);
  await entryRow(page, 'Seed the original gloss').click();

  // The document on screen is the earlier one, and it says so.
  await expect(page.getByText('Historical state')).toBeVisible();
  await expect(page.getByText(/This is the document as of/)).toBeVisible();
  await expect(glossCell(page)).toHaveValue('ORIGINAL', { timeout: 15_000 });

  await page.getByRole('button', { name: 'Return to current' }).click();
  await expect(page.getByText('Historical state')).toHaveCount(0);
  await expect(glossCell(page)).toHaveValue('CHANGED', { timeout: 15_000 });

  // Back to the entry, and this time restore to it.
  await entryRow(page, 'Seed the original gloss').click();
  await expect(glossCell(page)).toHaveValue('ORIGINAL', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Restore', exact: true }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Changes')).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByText('1 annotation in Gloss')).toBeVisible();

  await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 20_000 });

  // Live again, at the earlier value, with the restore itself in the rail.
  await expect(page.getByText('Historical state')).toHaveCount(0);
  await expect(glossCell(page)).toHaveValue('ORIGINAL', { timeout: 20_000 });
  await expect(page.getByText(/Restore to /).first()).toBeVisible({ timeout: 15_000 });

  // The restore is one audit write, and the message the dialog composed is that
  // write's own description (an `?audit-message=` names the op, not a group).
  const entries = await client().documents.audit(documentId);
  const restores = entries.flatMap((e) => e.ops || []).filter((o) => o.type === 'document/restore');
  expect(restores).toHaveLength(1);
  expect(restores[0].description).toContain('Seed the original gloss');
  const raw = await client().documents.get(documentId, true);
  const values = raw.textLayers
    .flatMap((tl) => tl.tokenLayers || [])
    .flatMap((tkl) => tkl.spanLayers || [])
    .flatMap((sl) => sl.spans || [])
    .map((s) => s.value);
  expect(values).toContain('ORIGINAL');
});

// Slow one snapshot read down, so two clicks can be in flight at once.
const delaySnapshot = (page, asOf, ms) =>
  page.route(
    (url) =>
      url.pathname.endsWith(`/documents/${documentId}`) && url.searchParams.get('as-of') === asOf,
    async (route) => {
      await new Promise((r) => setTimeout(r, ms));
      await route.continue();
    },
  );

// Every value the Gloss cell has HELD, in order, not just the one it ends on.
// The end state proves nothing here: a stale snapshot committed on top of a
// newer one is healed by the very effect that let it through (`doc.asOf` no
// longer matches `asOf`, so it re-reads), and five seconds later the grid is
// back where it should be with the flicker gone.
const watchGloss = (page) =>
  page.evaluate((sel) => {
    window.__glossSeq = [];
    setInterval(() => {
      const v = document.querySelector(sel)?.value;
      if (!v) return;
      const seq = window.__glossSeq;
      if (seq[seq.length - 1] !== v) seq.push(v);
    }, 25);
  }, GLOSS_CELL);

test('the snapshot the reader clicked past is never shown', async ({ page }) => {
  // Two entries in quick succession, and the first read is the slower one. The
  // second click is what the reader is looking at, so the first read has to be
  // thrown away rather than committed on top of it.
  await setGloss('Change the gloss to MIDDLE', 'MIDDLE');
  await setGloss('Change the gloss to LATEST', 'LATEST');
  // The heal is slowed too, so that a stale commit would be on screen for long
  // enough to be seen rather than passing between two samples.
  await delaySnapshot(page, await entryTime('Seed the original gloss'), 3000);
  await delaySnapshot(page, await entryTime('Change the gloss to MIDDLE'), 500);

  await seedAuth(page);
  await openDocument(page);
  await expect(glossCell(page)).toHaveValue('LATEST');
  await watchGloss(page);
  await openHistory(page);

  await entryRow(page, 'Seed the original gloss').click();
  await entryRow(page, 'Change the gloss to MIDDLE').click();

  await expect(glossCell(page)).toHaveValue('MIDDLE', { timeout: 15_000 });
  await expect(page.getByText('Change the gloss to MIDDLE').last()).toBeVisible();
  // Long enough for the abandoned read to land and for a heal to follow it.
  await page.waitForTimeout(6000);
  await expect(glossCell(page)).toHaveValue('MIDDLE');
  expect(await page.evaluate(() => window.__glossSeq)).toEqual(['LATEST', 'MIDDLE']);
});
