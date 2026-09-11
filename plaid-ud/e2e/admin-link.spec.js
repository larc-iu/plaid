// Item 13.1: this app has no admin area of its own, and links to the one the
// server does have.
//
// The release jar always ships plaid-ud, plaid-igt and plaid-dict together on
// one server, so there is exactly one admin area and it is plaid-igt's. A
// second here would be a second answer to the same questions, which is why
// /admin/users is gone rather than kept in parallel.
import { test, expect, seedAuth } from './fixtures.js';

test("an admin is offered the server's admin area, in the app that hosts it", async ({ page }) => {
  await seedAuth(page);
  await page.goto('/#/projects');

  const link = page.getByRole('link', { name: 'Admin' });
  await expect(link).toBeVisible({ timeout: 15000 });

  // A full page load into the other app, not a router Link: VITE_IGT_URL names
  // it in development, and the jar's default is /igt.
  const href = await link.getAttribute('href');
  expect(href).toMatch(/\/#\/admin$/);
  expect(href).not.toMatch(/^#/);
});

test('this app no longer has a user administration page of its own', async ({ page }) => {
  await seedAuth(page);
  await page.goto('/#/admin/users');

  // The route is gone, so this is the app's not-found, not a working screen.
  await expect(page.getByRole('heading', { name: 'Create User' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Create user/i })).toHaveCount(0);
});

test('a non-admin is not offered it', async ({ page }) => {
  await seedAuth(page, {
    token: 'ignored-by-the-check-below',
    userId: 'nobody@x.com',
    displayName: 'nobody@x.com',
    isAdmin: false,
  });
  await page.goto('/#/projects');
  await expect(page.getByRole('link', { name: 'Admin' })).toHaveCount(0);
});
