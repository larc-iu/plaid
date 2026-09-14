import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';
import { executeProjectSetup } from '../src/components/projects/setup/executeSetup.js';

// Creating an export preset, through the dialog rather than the API.
//
// Nothing covered this path. The format writers have 220-odd unit tests
// between them and the ELAN pair even round-trips, but no test had ever opened
// the New preset dialog, so the one gesture that decides which of those writers
// runs was untested. A stress-test agent then reported that the Format dropdown
// swallowed its clicks and that Create "closed the dialog and created nothing,
// with no error", which cost it the FLEx and ELAN round trips it was sent to do.
//
// That report came from a browser-extension agent driving a BACKGROUND tab,
// where Chrome never starts CSS animations, so a Radix popper never finishes
// its exit animation, never unmounts, and leaves `pointer-events: none` on
// document.body: every later click lands on <html> and no request is sent.
// Playwright drives a real visible page and does not reproduce that, which is
// exactly why this belongs here rather than in the extension harness.
//
// Throwaway project, deleted afterwards, so it never touches the shared
// fixture project other specs and other sessions rely on.

const CORE = 'http://localhost:8085';

let client;
let projectId;
let vocabId;
let auth;

test.beforeAll(async () => {
  const { token, userId } = readToken();
  auth = { token, userId };
  client = new PlaidClient(CORE, token);
  const name = `export-preset ${Date.now()}`;
  const setup = await executeProjectSetup({
    client,
    isNewProject: true,
    resumeProjectId: null,
    setupData: {
      basicInfo: { projectName: name },
      orthographies: { orthographies: [{ name: 'Baseline', isBaseline: true }] },
      fields: {
        fields: [{ name: 'Gloss', scope: 'Morpheme', isCustom: true }],
        ignoredTokens: {
          mode: 'unicode-punctuation',
          unicodePunctuationExceptions: [],
          explicitIgnoredTokens: [],
        },
      },
      vocabulary: {
        vocabularies: [{ id: 'new-1', name: `${name} Lexicon`, enabled: true, isCustom: true }],
      },
      documentMetadata: { enabledFields: [] },
    },
    // The id is recorded the moment the project exists, not after the whole
    // setup returns: a step that fails throws past the assignment below, and an
    // afterAll that never learned the id leaves the project on the dev core for
    // good.
    onProjectCreated: (id) => {
      projectId = id;
    },
  });
  // Both before the throw, for the same reason: a setup that fails partway has
  // still made them.
  projectId = setup.projectId ?? projectId;
  vocabId = setup.resources?.vocabularies?.[0]?.id;
  if (setup.failures.length) throw new Error(setup.failures.join('; '));
});

test.afterAll(async () => {
  if (projectId) await client.projects.delete(projectId).catch(() => {});
  if (vocabId) await client.vocabLayers.delete(vocabId).catch(() => {});
});

async function openPresets(page) {
  if (page.url() !== 'about:blank') await page.goto('about:blank');
  await seedAuth(page, auth);
  await page.goto(`/#/projects/${projectId}/export`);
  await page.getByRole('button', { name: 'New preset' }).waitFor({ state: 'visible' });
}

/** Pick a format in the dialog's Select, the way a person does. */
async function chooseFormat(page, label) {
  await page.locator('#new-preset-format').click();
  await page.getByRole('option', { name: label, exact: true }).click();
  // The trigger reflects the COMMITTED value, so this is the assertion that
  // separates "the list highlighted an item" from "the value changed".
  await expect(page.locator('#new-preset-format')).toContainText(label);
}

test('creates a preset in a format chosen from the dropdown', async ({ page }) => {
  await openPresets(page);
  await page.getByRole('button', { name: 'New preset' }).click();

  await chooseFormat(page, 'ELAN annotation file (.eaf)');
  const name = `ELAN via the dialog ${Date.now()}`;
  await page.locator('#new-preset-name').fill(name);
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  // Creating opens the new preset, under the format that was picked and not
  // the default. (Asserting a row in the LIST is a race: the list renders the
  // new preset for a frame and the navigation then leaves it.)
  await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
  await expect(page).toHaveURL(/\/export\/[^/]+$/);
  await expect(page.getByText('ELAN annotation file (.eaf)').first()).toBeVisible();

  // And it is really stored, not just rendered.
  const project = await client.projects.get(projectId);
  const presets = project.config?.igt?.export?.presets || [];
  const stored = presets.find((p) => p.name === name);
  expect(stored, 'the preset reached the project config').toBeTruthy();
  expect(stored.format).toBe('elan');
});

test('changing the format twice keeps the last choice, not the first', async ({ page }) => {
  // The reported failure was a dropdown that appeared to accept a choice
  // without committing it, which would leave the FIRST format in place.
  await openPresets(page);
  await page.getByRole('button', { name: 'New preset' }).click();

  await chooseFormat(page, 'FLEx (.flextext + .lift)');
  await chooseFormat(page, 'CLDF TextCorpus (.zip dataset)');

  const name = `CLDF after FLEx ${Date.now()}`;
  await page.locator('#new-preset-name').fill(name);
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
  const project = await client.projects.get(projectId);
  const stored = (project.config?.igt?.export?.presets || []).find((p) => p.name === name);
  expect(stored.format).toBe('cldf');
});

test('Create is refused, visibly, when the name is empty', async ({ page }) => {
  // The other half of the report was Create doing nothing silently. It has one
  // legitimate reason to do nothing, and it says so by being disabled.
  await openPresets(page);
  await page.getByRole('button', { name: 'New preset' }).click();
  await page.locator('#new-preset-name').fill('');
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
});
