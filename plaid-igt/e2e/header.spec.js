import { test, expect, seedAuth } from './fixtures.js';

// The header band, which is meant to be the same band as plaid-ud's.
//
// Administration is the server's, not this project's and not this screen's, so
// it sits with the account on the right rather than in the nav beside Projects
// and Vocabularies. plaid-ud says it in the same place.

const band = (page) => page.locator('header');
const account = (page) => band(page).getByRole('button', { name: /a@b\.com/ });

test('Admin sits with the account and not in the nav', async ({ page }) => {
  await seedAuth(page);
  await page.goto('/#/projects');
  const admin = band(page).getByRole('link', { name: 'Admin' });
  await expect(admin).toBeVisible({ timeout: 15000 });

  // Not among Projects, Vocabularies and Guide.
  await expect(band(page).locator('nav').getByRole('link', { name: 'Admin' })).toHaveCount(0);

  const [a, guide, acct] = await Promise.all([
    admin.boundingBox(),
    band(page).getByRole('link', { name: 'Guide' }).boundingBox(),
    account(page).boundingBox(),
  ]);
  expect(a.x).toBeGreaterThan(guide.x + guide.width);
  expect(a.x + a.width).toBeLessThanOrEqual(acct.x + 1);
});

test('signing out is inside the account, not beside it', async ({ page }) => {
  await seedAuth(page);
  await page.goto('/#/projects');
  await expect(account(page)).toBeVisible({ timeout: 15000 });
  await expect(band(page).getByRole('button', { name: 'Logout' })).toHaveCount(0);

  await account(page).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: /Profile/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /Logout/ })).toBeVisible();
  // That signing out works is asserted in plaid-ud's header spec. Here it
  // cannot be: this app's logout reloads the page, and `seedAuth` primes the
  // session again on every load, so the app comes straight back signed in.
});
