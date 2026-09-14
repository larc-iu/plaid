import { test, expect } from './fixtures.js';

// Real login through the shared LoginForm (no seedAuth shortcut).
test('login form authenticates and lands on projects', async ({ page }) => {
  await page.goto('/#/login');
  await page.getByLabel('Email address').fill('a@b.com');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/projects/, { timeout: 10000 });
  await expect(page.getByText(/Projects/i).first()).toBeVisible();
});
