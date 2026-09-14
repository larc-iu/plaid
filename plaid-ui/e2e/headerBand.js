// Both apps' header spec: the band across the top, which is meant to be one
// band in two apps.
//
// It had drifted once already, plaid-ud carrying the account as three bare text
// buttons at a smaller size than plaid-igt's with Logout a stray click away
// from Profile, and the two specs that caught that were written apart: each
// asserted half of the arrangement, so neither app was covered by what the
// other knew. The shared look is `headerItem` and `UserButton` in this package,
// so the assertions belong together.
//
// It imports nothing. This file sits outside both apps and can resolve neither
// Playwright nor `@larc-iu/plaid-client` from here, so `test`, `expect` and
// `seedAuth` come in as arguments.

export const headerBand = (page) => page.locator('header');
export const headerAccount = (page) => headerBand(page).getByRole('button', { name: /a@b\.com/ });

export const headerBandTests = ({
  test,
  expect,
  seedAuth,
  // A screen every signed-in reader can reach, where the band is drawn.
  landing = '/#/projects',
  // What the reader is left with after picking Logout. plaid-igt cannot say:
  // its logout reloads the page, and `seedAuth` primes the session again on
  // every load, so the app comes straight back signed in.
  signOut,
  // The nav on the left of the band, where this app has one: `{ rightOf }`
  // names a destination Admin must sit to the right of, and Admin must not be
  // among them.
  nav = null,
}) => {
  const band = headerBand;
  const account = headerAccount;

  test.describe('the header band', () => {
    test('signing out is inside the account, not beside it', async ({ page }) => {
      await seedAuth(page);
      await page.goto(landing);
      await expect(account(page)).toBeVisible({ timeout: 15000 });
      await expect(band(page).getByRole('button', { name: 'Logout' })).toHaveCount(0);

      await account(page).click();
      const menu = page.getByRole('menu');
      await expect(menu.getByRole('menuitem', { name: /Profile/ })).toBeVisible();
      await expect(menu.getByRole('menuitem', { name: /Logout/ })).toBeVisible();
      await signOut(page, menu);
    });

    test('Admin sits on the right of the band, immediately left of the account', async ({
      page,
    }) => {
      // Administration is the server's, not this project's and not this
      // screen's, so it sits with the account rather than among the app's own
      // destinations.
      await seedAuth(page);
      await page.goto(landing);
      const admin = band(page).getByRole('link', { name: 'Admin' });
      await expect(admin).toBeVisible({ timeout: 15000 });

      const [a, acct, bar] = await Promise.all([
        admin.boundingBox(),
        account(page).boundingBox(),
        band(page).boundingBox(),
      ]);
      expect(a.x).toBeGreaterThan(bar.x + bar.width / 2);
      expect(a.x + a.width).toBeLessThanOrEqual(acct.x + 1);

      if (nav) {
        await expect(band(page).locator('nav').getByRole('link', { name: 'Admin' })).toHaveCount(0);
        const last = await band(page).getByRole('link', { name: nav.rightOf }).boundingBox();
        expect(a.x).toBeGreaterThan(last.x + last.width);
      }
    });
  });
};
