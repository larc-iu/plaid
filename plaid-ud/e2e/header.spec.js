import { test, expect, seedAuth } from './fixtures.js';

// The header band, which is meant to be the same band as plaid-igt's.
//
// It had drifted: this app carried the account as three bare text buttons at a
// smaller size than igt's, and Logout stood one stray click away from Profile.
// Both apps now put Admin and then the account on the right, with everything
// about being signed in inside the account's own menu.

const band = (page) => page.locator('header');
const account = (page) => band(page).getByRole('button', { name: /a@b\.com/ });

test('signing out is inside the account, not beside it', async ({ page }) => {
  await seedAuth(page);
  await page.goto('/#/projects');
  await expect(account(page)).toBeVisible({ timeout: 15000 });
  await expect(band(page).getByRole('button', { name: 'Logout' })).toHaveCount(0);

  await account(page).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: /Profile/ })).toBeVisible();
  await menu.getByRole('menuitem', { name: /Logout/ }).click();

  // It really signs out: the login screen, and no account in the band.
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(account(page)).toHaveCount(0);
});

test('Admin sits on the right of the band, immediately left of the account', async ({ page }) => {
  await seedAuth(page);
  await page.goto('/#/projects');
  const admin = band(page).getByRole('link', { name: 'Admin' });
  await expect(admin).toBeVisible({ timeout: 15000 });

  const [a, acct, bar] = await Promise.all([
    admin.boundingBox(),
    account(page).boundingBox(),
    band(page).boundingBox(),
  ]);
  expect(a.x).toBeGreaterThan(bar.x + bar.width / 2);
  expect(a.x + a.width).toBeLessThanOrEqual(acct.x + 1);
});
