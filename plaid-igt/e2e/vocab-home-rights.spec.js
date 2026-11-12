import { test, expect } from './fixtures.js';
import { adminClient, buildWorld, dropWorld, signInAs } from './vocabHome.js';

// What each role sees of a vocabulary that belongs to project A and that
// project B borrows (SPEC 1.2, 5.4, rulings 11.3 and 11.4): in Analyze, a
// writer of B links B's words to its entries and adds or retypes none, a
// writer of A does both, in A's documents and in B's. On the vocabulary's
// page, a writer of A edits entries, a reader of A and every member of B
// read, and only a maintainer of A has Settings.

let world;

test.beforeAll(async () => {
  world = await buildWorld({
    roles: {
      hm: { A: 'maintainer' },
      hw: { A: 'writer' },
      hr: { A: 'reader' },
      bw: { B: 'writer' },
      br: { B: 'reader' },
      xw: { A: 'writer', B: 'writer' },
      xr: { A: 'reader', B: 'writer' },
    },
  });
});

test.afterAll(async () => {
  await dropWorld(world);
});

const pop = (page) => page.locator('.igt-vocab-pop');
const createRow = (page) => page.locator('.igt-vocab-pop__create');
const entryType = (page) =>
  pop(page).getByRole('combobox', { name: 'Lexicon entry morpheme type' });

async function openAnalyze(page, who, project) {
  await signInAs(page, who);
  await page.goto(`/#/projects/${project.id}/documents/${project.documentId}?tab=analyze`);
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  await page.waitForLoadState('networkidle');
}

async function openPopover(page, tokenId) {
  await page.locator(`button[data-vocab-opener="${tokenId}"]`).click();
  await pop(page).waitFor({ state: 'visible' });
}

const linkedTo = async (project, tokenId) => {
  const raw = await adminClient().documents.get(project.documentId, true);
  return raw.textLayers
    .flatMap((t) => t.tokenLayers)
    .flatMap((l) => l.vocabs || [])
    .flatMap((v) => v.vocabLinks || [])
    .filter((l) => l.tokens.includes(tokenId))
    .map((l) => l.vocabItem?.id ?? l.vocabItem);
};

test("in Analyze, a writer of the borrowing project links to the lexicon's entries and adds none", async ({
  page,
}) => {
  await openAnalyze(page, 'bw', world.B);
  await openPopover(page, world.B.morphemes.zorro);
  await expect(pop(page).locator('.igt-vocab-pop__borrowed')).toHaveText(
    `“${world.V.name}” belongs to another project.`,
  );
  await expect(createRow(page)).toHaveCount(0);

  // Linking to an existing entry is a write in B's document, open to B's writers.
  await page.locator('.igt-vocab-pop__search').fill('gato');
  await page.keyboard.press('Enter');
  await expect.poll(() => linkedTo(world.B, world.B.morphemes.zorro)).toEqual([world.entries.gato]);

  // A linked entry's type is the entry's, so it is not B's to change.
  await openPopover(page, world.B.morphemes.kat);
  await expect(entryType(page)).toBeDisabled();
});

test('in Analyze, a writer of the home project adds entries and changes their type', async ({
  page,
}) => {
  await openAnalyze(page, 'hw', world.A);
  await openPopover(page, world.A.morphemes.perro);
  await expect(createRow(page)).toHaveText(/Create\s*“perro”/);
  await expect(pop(page).locator('.igt-vocab-pop__borrowed')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await openPopover(page, world.A.morphemes.kat);
  await expect(entryType(page)).toBeEnabled();
});

test("in Analyze of the borrowing project, a writer of the lexicon's project adds an entry to it", async ({
  page,
}) => {
  // "zorro" linked to nothing, whichever test ran before.
  const client = adminClient();
  const raw = await client.documents.get(world.B.documentId, true);
  for (const l of raw.textLayers
    .flatMap((t) => t.tokenLayers)
    .flatMap((t) => t.vocabs || [])
    .flatMap((v) => v.vocabLinks || [])
    .filter((x) => x.tokens.includes(world.B.morphemes.zorro)))
    await client.vocabLinks.delete(l.id);

  await openAnalyze(page, 'xw', world.B);
  await openPopover(page, world.B.morphemes.zorro);
  await expect(pop(page).locator('.igt-vocab-pop__borrowed')).toHaveCount(0);
  await expect(createRow(page)).toHaveText(/Create\s*“zorro”/);
  await createRow(page).click();
  await expect(page.locator('.igt-vocab-pop__create-input')).toBeVisible();
  await page.keyboard.press('Enter');

  // Stored in the lexicon of A, and B's "zorro" is linked to it.
  const made = async () =>
    (await adminClient().vocabLayers.get(world.V.id, true)).items
      .filter((it) => it.form === 'zorro')
      .map((it) => it.id);
  await expect.poll(made).toHaveLength(1);
  const [zorro] = await made();
  await expect.poll(() => linkedTo(world.B, world.B.morphemes.zorro)).toEqual([zorro]);

  await page.keyboard.press('Escape');
  await openPopover(page, world.B.morphemes.kat);
  await expect(entryType(page)).toBeEnabled();
});

test("in Analyze of the borrowing project, a reader of the lexicon's project adds no entry", async ({
  page,
}) => {
  await openAnalyze(page, 'xr', world.B);
  await openPopover(page, world.B.morphemes.kat);
  await expect(pop(page).locator('.igt-vocab-pop__borrowed')).toHaveText(
    `“${world.V.name}” belongs to another project.`,
  );
  await expect(createRow(page)).toHaveCount(0);
  await expect(entryType(page)).toBeDisabled();
});

test('a reader of the borrowing project reads the lexicon in Analyze and changes nothing', async ({
  page,
}) => {
  await openAnalyze(page, 'br', world.B);
  // A reader opens no lexicon popover at all, linked or not.
  await expect(page.locator(`button[data-vocab-opener="${world.B.morphemes.kat}"]`)).toBeDisabled();
  await expect(
    page.locator(`button[data-vocab-opener="${world.B.morphemes.zorro}"]`),
  ).toBeDisabled();
});

async function openVocabulary(page, who) {
  await signInAs(page, who);
  await page.goto(`/#/vocabularies/${world.V.id}`);
  await expect(page.getByRole('heading', { name: world.V.name })).toBeVisible({ timeout: 15000 });
  // An entry open, where a person who may not edit it is told so.
  await page.getByRole('link', { name: /^kat/ }).click();
  await expect(page.locator('input[id$="-form"]')).toHaveValue('kat');
}

const newEntry = (page) => page.getByRole('link', { name: 'New', exact: true });
const settingsTab = (page) => page.getByRole('tab', { name: 'Settings' });

for (const who of ['bw', 'br']) {
  test(`on the vocabulary's page, a member of the borrowing project (${who}) reads it only`, async ({
    page,
  }) => {
    await openVocabulary(page, who);
    await expect(page.getByText('Project: another project')).toBeVisible();
    await expect(
      page.getByText('Read only: this vocabulary belongs to another project.'),
    ).toBeVisible();
    await expect(newEntry(page)).toHaveCount(0);
    await expect(settingsTab(page)).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Maintainers' })).toHaveCount(0);
  });
}

test("on the vocabulary's page, a reader of its project reads it only, and is told why", async ({
  page,
}) => {
  await openVocabulary(page, 'hr');
  await expect(page.getByRole('link', { name: world.A.name })).toBeVisible();
  await expect(
    page.getByText(`Read only: you have reader access to “${world.A.name}”.`),
  ).toBeVisible();
  await expect(newEntry(page)).toHaveCount(0);
  await expect(settingsTab(page)).toHaveCount(0);
});

test("on the vocabulary's page, a writer of its project adds entries and has no Settings", async ({
  page,
}) => {
  await openVocabulary(page, 'hw');
  await expect(newEntry(page)).toBeVisible();
  await expect(page.getByText(/^Read only:/)).toHaveCount(0);
  await expect(settingsTab(page)).toHaveCount(0);
});

test("on the vocabulary's page, a maintainer of its project has Settings and the projects that use it", async ({
  page,
}) => {
  await openVocabulary(page, 'hm');
  await expect(newEntry(page)).toBeVisible();
  await settingsTab(page).click();
  await expect(page.getByRole('heading', { name: 'Used by other projects' })).toBeVisible();
  // hm has no role in B: the borrower is counted, not named.
  await expect(page.getByText('Another project', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unlink from another project' })).toBeVisible();
});
