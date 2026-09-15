// The Guidelines tab, driven in whichever app is running it.
//
// One screen serves plaid-igt and plaid-ud, so the tests that are about the
// SCREEN are here, and each app's spec supplies what differs: the path its tab
// lives at (a `?tab=` in IGT, a route in UD) and the project to put them on.
//
// Everything a run creates is titled with its own suffix and deleted in
// afterAll, so two apps' suites can run against one dev server and neither
// leaves anything on the shared fixture project.

// How long the rich-text editor is given to appear. It is lazy and it is the
// largest chunk either app ships, so the FIRST time a dev server sees it the
// wait includes Vite optimizing half a megabyte of ProseMirror. Twenty seconds
// was enough warm and not enough cold, which read as flake.
const EDITOR_TIMEOUT = 45000;

// The row for a guideline by title.
const rowFor = (page, title) =>
  page.locator('button', { has: page.locator(`text="${title}"`) }).first();

export const guidelinesTests = ({
  test,
  expect,
  seedAuth,
  // () => a PlaidClient authenticated as the test user.
  client,
  // () => the project the tab is opened on.
  projectId,
  // The path this app serves the tab at, given the project id.
  tabPath,
  // A suffix that makes this run's titles its own.
  suffix,
}) => {
  const titled = (name) => `${name} ${suffix}`;
  const created = [];

  const seed = async (attrs) => {
    const { id } = await client().guidelines.create(
      projectId(),
      titled(attrs.title),
      attrs.summary,
      { body: attrs.body, pinned: attrs.pinned },
    );
    created.push(id);
    return id;
  };

  const open = async (page) => {
    await seedAuth(page);
    await page.goto(tabPath(projectId()));
    await expect(page.getByRole('tab', { name: 'Guidelines' })).toBeVisible({ timeout: 15000 });
  };

  test.afterAll(async () => {
    const c = client();
    for (const id of created.splice(0)) {
      await c.guidelines.delete(id).catch(() => {});
    }
  });

  test('a seeded guideline is listed, and a pinned one is listed first', async ({ page }) => {
    await seed({ title: 'Zeta', summary: 'Last by title.', body: 'z' });
    await seed({ title: 'Alpha', summary: 'Pinned, so first of all.', body: 'a', pinned: true });
    await open(page);

    const titles = page.locator('button[class*="border-b"] span.font-medium');
    await expect(titles.first()).toBeVisible({ timeout: 15000 });
    const shown = (await titles.allTextContents()).filter((t) => t.endsWith(suffix));
    expect(shown).toEqual([titled('Alpha'), titled('Zeta')]);
  });

  test('opening one fetches its body and renders it as Markdown', async ({ page }) => {
    await seed({
      title: 'Rendered',
      summary: 'Markdown, not its source.',
      body: '## A heading\n\nLoanwords are **not** segmented.\n\n- one\n- two',
    });
    await open(page);
    await rowFor(page, titled('Rendered')).click();

    const body = page.locator('.md-body');
    await expect(body.locator('h2')).toHaveText('A heading');
    await expect(body.locator('strong')).toHaveText('not');
    await expect(body.locator('li')).toHaveCount(2);
    // The source must not leak through as text.
    await expect(body).not.toContainText('**not**');
  });

  test('the open guideline is in the address, so the view can be linked', async ({ page }) => {
    const id = await seed({ title: 'Linkable', summary: 'In the URL.', body: 'x' });
    await open(page);
    await rowFor(page, titled('Linkable')).click();
    await expect(page).toHaveURL(new RegExp(`guideline=${id}`));
  });

  test('a new guideline is written through the editor and comes back rendered', async ({
    page,
  }) => {
    await open(page);
    await page.getByRole('button', { name: 'New', exact: true }).click();

    const title = titled('Written here');
    await page.locator('#guideline-title').fill(title);
    await page.locator('#guideline-summary').fill('Typed in the browser.');

    // The rich-text editor is lazy, so it arrives after the form does.
    const doc = page.locator('.guideline-editor__doc');
    await expect(doc).toBeVisible({ timeout: EDITOR_TIMEOUT });
    await doc.click();
    await page.keyboard.type('Ergative subjects are marked ');
    await page.keyboard.type('here.');

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.md-body')).toContainText('Ergative subjects are marked here.');

    // Remembered for cleanup: it was made through the UI, not through seed().
    const rows = await client().guidelines.list(projectId());
    const mine = rows.find((r) => r.title === title);
    expect(mine, 'the guideline reached the server').toBeTruthy();
    created.push(mine.id);
  });

  test('saving without typing leaves the text exactly as it was', async ({ page }) => {
    // The round trip the serializer is tested on, through the real editor:
    // opening a guideline and saving it is what every edit does first.
    const body =
      '## Glossing\n\nLoanwords are **not** segmented.\n\n- Keep the speaker punctuation.\n- Gloss `3SG`, never `3sg`.\n\n> Ruled 2026-03-01.';
    const id = await seed({ title: 'Untouched', summary: 'Saved without typing.', body });
    await open(page);
    await rowFor(page, titled('Untouched')).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.locator('.guideline-editor__doc')).toBeVisible({ timeout: EDITOR_TIMEOUT });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.md-body')).toBeVisible();

    const after = await client().guidelines.get(id);
    expect(after.body).toBe(body);
  });

  test('pinning shows on the row without restating the guideline', async ({ page }) => {
    const id = await seed({ title: 'Pin me', summary: 'Not pinned yet.', body: 'p' });
    await open(page);
    await rowFor(page, titled('Pin me')).click();
    await page.getByRole('button', { name: 'Pin', exact: true }).click();

    await expect(page.getByRole('button', { name: 'Unpin', exact: true })).toBeVisible();
    const after = await client().guidelines.get(id);
    expect(after.pinned).toBe(true);
    expect(after.summary).toBe('Not pinned yet.');
  });

  test('a title already in use is a note while typing, not a refusal at save', async ({ page }) => {
    // Deliberately not enforced. The note appears before a word of the body has
    // been written, and the save goes through: refusing here would throw away a
    // document someone had just typed to prevent two rows sharing a name.
    await seed({ title: 'Taken', summary: 'The first one.', body: 't' });
    await open(page);
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.locator('#guideline-title').fill(titled('Taken'));
    await expect(page.locator('#guideline-title-taken')).toHaveText(
      'Another guideline has this title.',
    );

    await page.locator('#guideline-summary').fill('The second one.');
    await expect(page.locator('.guideline-editor__doc')).toBeVisible({ timeout: EDITOR_TIMEOUT });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('[data-sonner-toast]')).toContainText('Guideline created.');

    const both = (await client().guidelines.list(projectId())).filter(
      (g) => g.title === titled('Taken'),
    );
    expect(both).toHaveLength(2);
    both.forEach((g) => created.push(g.id));
  });
};
