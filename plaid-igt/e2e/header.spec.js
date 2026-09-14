import { test, expect, seedAuth } from './fixtures.js';
import { headerBandTests } from '../../plaid-ui/e2e/headerBand.js';

// The header band, which is the same band as plaid-ud's: `headerItem` and
// `UserButton` in plaid-ui draw it, so the two tests that are about it are
// there too (`headerBandTests`). What stays here is what this app supplies: a
// nav of its own on the left, and the fact that it cannot watch a sign-out
// through.

headerBandTests({
  test,
  expect,
  seedAuth,
  // This app's logout reloads the page, and `seedAuth` primes the session again
  // on every load, so the app comes straight back signed in. That signing out
  // really signs out is asserted in plaid-ud's half.
  signOut: async () => {},
  nav: { rightOf: 'Guide' },
});
