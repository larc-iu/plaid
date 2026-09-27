import { test, expect, seedAuth } from './fixtures.js';
import { headerAccount, headerBandTests } from '../../plaid-ui/e2e/headerBand.js';

// The header band, which is the same band as plaid-igt's: `headerItem` and
// `UserButton` in plaid-ui draw it, so the two tests that are about it are
// there too (`headerBandTests`). What stays here is what this app supplies:
// its guide, and a sign-out that can be watched through.

headerBandTests({
  test,
  expect,
  seedAuth,
  guide: 'ud-guide.html',
  signOut: async (page, menu) => {
    await menu.getByRole('menuitem', { name: /Sign out/ }).click();
    // It really signs out: the login screen, and no account in the band.
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(headerAccount(page)).toHaveCount(0);
  },
});
