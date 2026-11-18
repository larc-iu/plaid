import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken, CORE } from './fixtures.js';
import { getFixture } from './fixtureProject.js';

// Validation on a document metadata field with a tagset (H2-12-2). Show
// occurrences on an off-list value lists the document that holds it, against
// a real core (the query was refused there, and only its shape was tested).
test('a document metadata value off its list is located', async ({ page }) => {
  const { projectId } = await getFixture();
  const client = new PlaidClient(CORE, readToken().token);
  const field = `Region ${Date.now()}`;
  const tagset = `Regions ${Date.now()}`;
  const docName = `Metadata doc ${Date.now()}`;
  const before = await client.projects.get(projectId);
  const igt = before.config?.igt || {};
  await client.projects.setConfig(projectId, 'igt', 'tagsets', {
    ...(igt.tagsets || {}),
    [tagset]: { delimiters: '', mode: 'suggest', values: [{ value: 'North' }] },
  });
  await client.projects.setConfig(projectId, 'igt', 'documentMetadata', [
    ...(igt.documentMetadata || []),
    { name: field, tagset },
  ]);
  const doc = await client.documents.create(projectId, docName, { [field]: 'South' });
  try {
    await seedAuth(page);
    await page.goto(`/#/projects/${projectId}?tab=validate`);
    const row = page
      .locator('div.flex.items-center.gap-3')
      .filter({ has: page.locator('code', { hasText: /^South$/ }) })
      .first();
    const toggle = page.getByRole('button', { name: /not written in capitals|not in the tagset/ });
    await expect(toggle.first()).toBeVisible({ timeout: 20_000 });
    if (!(await row.isVisible())) {
      for (const b of await toggle.all()) {
        await b.click();
        if (await row.isVisible()) break;
      }
    }
    await expect(row).toBeVisible();
    // Bulk Edit cannot change a document's metadata (H2-12-4).
    await expect(row.getByRole('link', { name: 'Fix in Bulk Edit' })).toHaveCount(0);
    await row.locator('button[title="Show occurrences"]').click();
    await expect(page.getByRole('link', { name: docName })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Failed to search for this value')).toHaveCount(0);
  } finally {
    await client.documents.delete(doc.id);
    const now = await client.projects.get(projectId);
    const { [tagset]: _gone, ...tagsets } = now.config?.igt?.tagsets || {};
    await client.projects.setConfig(projectId, 'igt', 'tagsets', tagsets);
    await client.projects.setConfig(
      projectId,
      'igt',
      'documentMetadata',
      (now.config?.igt?.documentMetadata || []).filter((f) => f.name !== field),
    );
  }
});
