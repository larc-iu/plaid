import { test, expect, seedAuth } from './fixtures.js';
import { headerBandTests } from '../../plaid-ui/e2e/headerBand.js';

// The header band, which is the same band as plaid-ud's and plaid-umr's: the
// shared AppShell draws it, so the tests that are about it are in plaid-ui too
// (`headerBandTests`). What stays here is what this app supplies: a nav of its
// own on the left beside the guide, and the fact that it cannot watch a
// sign-out through.

headerBandTests({
  test,
  expect,
  seedAuth,
  // This app's logout reloads the page, and `seedAuth` primes the session again
  // on every load, so the app comes straight back signed in. That signing out
  // really signs out is asserted in plaid-ud's half.
  signOut: async () => {},
  guide: 'igt-guide.html',
});

test('the nav names this app’s own destinations, and marks the one the reader is on', async ({
  page,
}) => {
  await seedAuth(page);
  await page.goto('/#/vocabularies');
  const nav = page.locator('header nav');
  await expect(nav.getByRole('link')).toHaveText(['Projects', 'Vocabularies', 'Guide']);
  await expect(nav.getByRole('link', { name: 'Vocabularies' })).toHaveClass(/bg-accent /);
  await expect(nav.getByRole('link', { name: 'Projects' })).not.toHaveClass(/bg-accent /);
});
