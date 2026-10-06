import PlaidClient, { ROLES } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';
import { getFixture } from './fixtureProject.js';

// Opening a document in IGT writes nothing (2026-10-06). Until then a
// maintainer's open declared IGT's layer rules on a project whose layers held
// none, after repairing what they forbid (an orphan morpheme deleted), and
// every open wrote a drifted morph type onto its morpheme. The rules are now
// declared at setup and by a one-off script, so a project whose morpheme
// layer holds none keeps its orphan through an open, and gains no rule.
test('opening a document repairs nothing and declares no rule', async ({ page }) => {
  const { projectId, documentId } = await getFixture();
  const client = new PlaidClient('http://localhost:8085', readToken().token);
  const project = await client.projects.get(projectId);
  const tokenLayers = project.textLayers.flatMap((tl) => tl.tokenLayers || []);
  const morphemeLayer = tokenLayers.find((tl) => tl.config?.plaid?.role === ROLES.MORPHEME);
  const wordLayer = tokenLayers.find((tl) => tl.config?.plaid?.role === ROLES.WORD);
  const held = morphemeLayer.constraints?.igt ?? null;

  const doc = await client.documents.get(documentId, true);
  const text = doc.textLayers.map((tl) => tl.text).find(Boolean);
  const words = doc.textLayers
    .flatMap((tl) => tl.tokenLayers || [])
    .filter((tl) => tl.id === wordLayer.id)
    .flatMap((tl) => tl.tokens || []);
  // An orphan is a morpheme whose extent matches no word EXACTLY. Shrink a
  // real word's extent by one character until the result matches nothing.
  const wordExtents = new Set(words.map((w) => `${w.begin}:${w.end}`));
  const base = words.find((w) => w.end - w.begin > 1);
  expect(base, 'fixture has a word longer than one character').toBeTruthy();
  let end = base.end - 1;
  while (end > base.begin && wordExtents.has(`${base.begin}:${end}`)) end -= 1;
  // A layer that holds none of IGT's rules, as one made before them did.
  await client.tokenLayers.deleteConstraints(morphemeLayer.id, 'igt').catch((e) => {
    if (e.status !== 404) throw e;
  });
  const orphan = await client.tokens.create(morphemeLayer.id, text.id, base.begin, end, 1);

  try {
    await seedAuth(page);
    await page.goto(`/#/projects/${projectId}/documents/${documentId}`);
    await expect(page.getByRole('tab', { name: /Analyze/ })).toBeEnabled({ timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Sample IGT Document' })).toBeVisible();
    // Long enough for an open's writes to have landed, had it made any.
    await page.waitForTimeout(2_000);

    const after = await client.documents.get(documentId, true);
    const morphemeIds = after.textLayers
      .flatMap((tl) => tl.tokenLayers || [])
      .filter((tl) => tl.id === morphemeLayer.id)
      .flatMap((tl) => (tl.tokens || []).map((t) => t.id));
    expect(morphemeIds).toContain(orphan.id);
    const rules = (await client.projects.get(projectId)).textLayers
      .flatMap((tl) => tl.tokenLayers || [])
      .find((l) => l.id === morphemeLayer.id).constraints?.igt;
    expect(rules ?? []).toEqual([]);
  } finally {
    await client.tokens.delete(orphan.id).catch(() => {});
    if (held?.length) {
      await client.tokenLayers.setConstraints(morphemeLayer.id, 'igt', held, undefined, {
        expected: null,
      });
    }
  }
});
