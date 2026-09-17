import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';
import { getFixture } from './fixtureProject.js';

// A person's own shortcut, end to end: bound on the Profile screen, heard by
// the handler it replaces, printed by the legend, kept on the account across a
// reload, and gone again after Reset all.
//
// It writes to the shared dev account's keymap, so both shortcuts it changes
// are ones no other spec presses, and it clears the entry whatever happens.

const CORE = 'http://localhost:8085';
const KEY = 'igt:keymap';

let client;
let userId;

const clear = () => client.userData.delete(userId, KEY).catch(() => {});

test.beforeAll(async () => {
  const me = readToken();
  client = new PlaidClient(CORE, me.token);
  userId = me.userId;
  await clear();
});
test.afterAll(clear);

const rebind = async (page, label, chord) => {
  await page.getByRole('button', { name: `Change the shortcut for ${label}` }).click();
  await expect(page.getByRole('button', { name: /^Press the new shortcut/ })).toBeFocused();
  await page.keyboard.press(chord);
};

test('a rebound shortcut works, shows in the legend, and survives a reload', async ({ page }) => {
  const { projectId, documentId } = await getFixture();
  await seedAuth(page);
  await page.goto('/#/profile');
  await expect(page.getByText('Keyboard shortcuts', { exact: true })).toBeVisible();

  // Refused, with the reason, and still listening.
  await rebind(page, 'List the other values seen for this form', 'Control+Enter');
  await expect(page.getByRole('status')).toHaveText(
    'Ctrl+Enter is “Accept everything proposed on the word or sentence”.',
  );
  await page.keyboard.press('Alt+l');
  await expect(page.getByRole('status')).toHaveCount(0);

  await rebind(page, 'Type a zero morph ∅', 'Alt+9');
  await page.screenshot({
    path: '/tmp/claude-1000/-home-luke-local-plaid/0c8e98de-36ac-4d38-b4ca-ba0d45a2d154/scratchpad/keyboard.png',
    fullPage: true,
  });
  await expect
    .poll(async () => (await client.userData.get(userId, KEY)).value.metadata)
    .toEqual({ 'analyze.alternatives': ['Alt+l'], 'morph.zero': ['Alt+9'] });

  // A fresh page load reads them off the account.
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=analyze`);
  await page.reload();
  const form = page.locator('.igt-morph-field').first();
  await form.waitFor({ state: 'visible' });
  await form.click();
  const before = await form.inputValue();
  await page.keyboard.press('End');
  await page.keyboard.press('Alt+0');
  await expect(form).toHaveValue(before); // the old chord is dead
  await page.keyboard.press('Alt+9');
  await expect(form).toHaveValue(`${before}∅`);
  await page.keyboard.press('Escape'); // put the form back, write nothing

  await page.getByRole('button', { name: 'Keyboard & scope help' }).click();
  const legend = page.locator('.igt-legend');
  await expect(legend).toContainText('9 types a zero morph');
  await expect(legend).toContainText('L lists the rest');

  await page.goto('/#/profile');
  await page.getByRole('button', { name: 'Reset all' }).click();
  await expect(page.getByRole('button', { name: 'Reset all' })).toHaveCount(0);
  await expect
    .poll(() =>
      client.userData.get(userId, KEY).then(
        () => 'there',
        (e) => e.status,
      ),
    )
    .toBe(404);
});
