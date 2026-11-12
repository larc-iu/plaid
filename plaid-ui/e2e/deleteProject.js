// The Delete project confirm, driven in whichever app is running it (the card
// is plaid-ui's, in every app's General settings).
//
// What the delete would take is a read of its own, GET /projects/{id}/deletion,
// never the DELETE with a flag: a core or a client that did not know the flag
// deleted the project on the mere opening of the confirm (VH-UI's incident).
// So opening the confirm must send that GET and no write, Cancel must send
// nothing, and only Delete with the name typed sends the DELETE.
//
// Each run makes its own project through the API and the test deletes it.

export const deleteProjectTests = ({
  test,
  expect,
  seedAuth,
  // () => a PlaidClient authenticated as the test user.
  client,
  // The path this app serves General settings at, given the project id.
  generalPath,
  // A suffix that makes this run's project name its own.
  suffix,
}) => {
  test('Delete project asks what it takes with a GET, and deletes only on Delete', async ({
    page,
  }) => {
    const name = `Delete me ${suffix}`;
    const { id } = await client().projects.create(name);
    // Every request about this project but plain reads of it, as `METHOD path`.
    const sent = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (!u.pathname.startsWith(`/api/v1/projects/${id}`)) return;
      if (r.method() === 'GET' && !u.pathname.endsWith('/deletion')) return;
      for (const key of ['audit-message', 'group-id', 'group-message']) u.searchParams.delete(key);
      sent.push(`${r.method()} ${u.pathname}${u.search}`);
    });
    try {
      await seedAuth(page);
      await page.goto(generalPath(id));
      const open = page.getByRole('button', { name: 'Delete project' });
      await expect(open).toBeVisible({ timeout: 15000 });

      await open.click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog.getByRole('textbox')).toBeVisible();
      await expect.poll(() => [...sent]).toEqual([`GET /api/v1/projects/${id}/deletion`]);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toHaveCount(0);
      expect(sent).toEqual([`GET /api/v1/projects/${id}/deletion`]);
      expect((await client().projects.get(id)).name).toBe(name);

      sent.length = 0;
      await open.click();
      await dialog.getByRole('textbox').fill(name);
      await dialog.getByRole('button', { name: 'Delete project' }).click();
      await expect
        .poll(() =>
          client()
            .projects.get(id)
            .then(
              () => 'there',
              () => 'gone',
            ),
        )
        .toBe('gone');
      expect(sent).toEqual([
        `GET /api/v1/projects/${id}/deletion`,
        `DELETE /api/v1/projects/${id}`,
      ]);
    } finally {
      await client()
        .projects.delete(id)
        .catch(() => {});
    }
  });
};
