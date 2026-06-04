import { test, expect } from './fixtures.js';

// Real login through the migrated shadcn LoginForm (no seedAuth shortcut) — also
// guards that the Tailwind/shadcn foundation coexists with the Mantine shell.
test('shadcn login form authenticates and lands on projects', async ({ page }) => {
  await page.goto('/#/login');
  await page.getByLabel('Username').fill('a@b.com');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await page.waitForURL(/projects/, { timeout: 10000 });
  await expect(page.getByText(/Projects/i).first()).toBeVisible();
});
