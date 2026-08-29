import { existsSync } from 'node:fs';
import { test, expect, seedAuth } from './fixtures.js';

// The FLEx import review screen: upload the Lezgi backup, check the Lexicon
// card (new lexicon with an editable name, or an existing one the user
// maintains) and the opt-in Lexicon fields card. Nothing is imported; the
// backup is a large local file, so the suite is skipped where it is absent.

const BACKUP = '/home/luke/Downloads/Lezgi-Qusar dialect 2019-12-12 0934 change_comps.fwbackup';

test.describe.configure({ timeout: 180_000 });

test.skip(!existsSync(BACKUP), 'Lezgi backup not on this machine');

test('review screen: lexicon destination + opt-in lexicon fields', async ({ page }) => {
  await page.goto('about:blank');
  await seedAuth(page);
  await page.goto('/#/projects/import');
  await page.locator('input[type="file"]').setInputFiles(BACKUP);
  await page.getByLabel('Project name').waitFor({ state: 'visible', timeout: 120_000 });
  await expect(page.getByLabel('Project name')).toHaveValue('Lezgi-Qusar dialect');

  // New lexicon by default, named after the project, and renamable.
  const newRadio = page.getByRole('radio', { name: 'Create a new lexicon' });
  await expect(newRadio).toBeChecked();
  const name = page.getByLabel('Lexicon name');
  await expect(name).toHaveValue('Lezgi-Qusar dialect Lexicon');
  await page.getByLabel('Project name').fill('Qusar');
  await expect(name).toHaveValue('Qusar Lexicon'); // follows the project until edited
  await name.fill('Qusar dictionary');
  await page.getByLabel('Project name').fill('Qusar 2');
  await expect(name).toHaveValue('Qusar dictionary');
  const importBtn = page.getByRole('button', { name: /^Import/ });
  await expect(importBtn).toBeEnabled();
  await name.fill('   ');
  await expect(importBtn).toBeDisabled();
  await name.fill('Qusar dictionary');

  // Existing lexicon: only ones this user maintains (admin sees all); the
  // button waits for a choice.
  const existingRadio = page.getByRole('radio', { name: /Add to a lexicon you maintain/ });
  await expect(existingRadio).toBeEnabled();
  await existingRadio.check();
  await expect(name).toHaveCount(0);
  await expect(importBtn).toBeDisabled();
  const select = page.getByLabel('Existing lexicon');
  await select.selectOption({ label: 'IGT Lexicon' });
  await expect(importBtn).toBeEnabled();
  await newRadio.check();
  await expect(name).toHaveValue('Qusar dictionary');

  // The other FLEx lexicon fields, unticked, with counts.
  const card = page
    .locator('div', { has: page.getByText('Lexicon fields', { exact: true }) })
    .last();
  const note = card.getByRole('checkbox', { name: /Socio Linguistics Note/ });
  await expect(note).not.toBeChecked();
  await expect(card.getByText(/Socio Linguistics Note/)).toBeVisible();
  await expect(card.getByText(/54 senses/)).toBeVisible();
  await expect(card.getByText(/16 entries/)).toBeVisible();
  await note.check();
  await expect(note).toBeChecked();
});
