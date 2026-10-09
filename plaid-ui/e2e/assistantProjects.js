// Both apps' spec for a conversation that reads other projects beside its own.
//
// The chips, the "Add project" list, the "With" line and a citation into
// another project are all in this package (src/components/assistant/), so the
// tests are written once and each app drives them with its own paths. No model
// and no service process: the conversation is seeded straight into the user's
// key/value store, and an assistant is made to look online, in the projects it
// runs in, by answering the discovery GET.
//
// It imports NOTHING, for the reason assistantChrome.js gives: `test`,
// `expect`, `seedAuth` and a client factory come in as arguments.

import { assistantStub } from './assistantChrome.js';

export const assistantProjectsTests = ({
  test,
  expect,
  seedAuth,
  app,
  // () => a PlaidClient signed in as the e2e admin, and () => that user's id.
  client,
  userId,
  // () => the home project's id, and () => {id, name} of the project the
  // assistant also runs in and of one it does not.
  home,
  served,
  unserved,
  // (projectId, conversationId | null) => the hash route of the Assistant tab.
  assistantPath,
  // (projectId) => a resolved citation of a sentence in that project, keyed by
  // the tag the reply carries, in this app's card shape.
  citation,
}) => {
  const stub = assistantStub(app);
  const service = { ...stub[0], extras: { ...stub[0].extras, maxProjects: 5 } };
  const seeded = [];
  const key = (kind, id) => `${app}:assistant:${home()}:${kind}:${id}`;

  // Online wherever discovery is asked, except in the one project it does not
  // run in. A turn is never answered: the request is refused at once, and
  // what each one asked for is kept in `asked` (the assistant service, not
  // the page, writes the record, so the request is where the set shows).
  const asked = [];
  const withAssistant = async (page) => {
    await page.route('**/api/v1/projects/*/services', (route) => {
      const there = route.request().url().includes(`/projects/${unserved().id}/`);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(there ? [] : [service]),
      });
    });
    await page.route('**/api/v1/projects/*/services/*/requests*', (route) => {
      try {
        asked.push(route.request().postDataJSON());
      } catch {
        // Not a body this spec reads.
      }
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    });
  };

  const seed = async (display) => {
    const id = crypto.randomUUID();
    seeded.push(id);
    const now = new Date().toISOString();
    const c = client();
    await c.userData.put(userId(), key('conv', id), { messages: [], display });
    await c.userData.put(userId(), key('meta', id), {
      id,
      title: 'E2E other projects',
      createdAt: now,
      updatedAt: now,
      serviceId: service.serviceId,
      model: 'test/model',
      turns: 2,
      pending: null,
    });
    return id;
  };

  test.afterAll(async () => {
    const c = client();
    for (const id of seeded) {
      for (const kind of ['conv', 'meta']) {
        await c.userData.delete(userId(), key(kind, id)).catch(() => {});
      }
    }
  });

  test.beforeEach(async ({ page }) => {
    await seedAuth(page);
    await withAssistant(page);
  });

  test('a message names the projects it read, and a citation links into its own project', async ({
    page,
  }) => {
    const B = served();
    const C = unserved();
    const cite = citation(B.id);
    const id = await seed([
      { kind: 'user', text: 'compare the two', projects: [B, C] },
      {
        kind: 'assistant',
        text: `In the other project:\n\n${cite.key}`,
        citations: [cite],
        unavailableProjects: [C],
        plan: null,
        status: null,
        model: 'test/model',
        steps: [],
        stepsSummary: '',
      },
      { kind: 'user', text: 'and again', projects: [B, C] },
    ]);
    await page.goto(assistantPath(home(), id));
    // Named where the set changed, which is the first message only.
    await expect(page.getByText(`With ${B.name}, ${C.name}`)).toHaveCount(1);
    await expect(page.getByText(`${C.name} could not be opened.`)).toBeVisible();
    await expect(
      page.locator(`a[href*="/projects/${B.id}/documents/${cite.documentId}"]`).first(),
    ).toBeVisible();
    // The composer picks the set up from the last message.
    await expect(page.getByRole('button', { name: `Remove ${B.name}` })).toBeVisible();
    await expect(page.getByRole('button', { name: `Remove ${C.name}` })).toBeVisible();
  });

  test('Add project joins a project the assistant runs in, and refuses one it does not', async ({
    page,
  }) => {
    const B = served();
    const C = unserved();
    await page.goto(assistantPath(home(), null));
    const add = page.getByRole('button', { name: 'Add project' });

    await add.click();
    await page.getByRole('combobox', { name: 'Project' }).fill(C.name);
    await page.getByRole('option', { name: C.name, exact: true }).click();
    // Refused in the list itself, and no toast.
    const said = page.getByRole('status').filter({
      hasText: `${service.serviceName} is not running in ${C.name}.`,
    });
    await expect(said).toBeVisible();
    await expect(
      page.locator('[data-sonner-toast]').filter({ hasText: 'is not running' }),
    ).toHaveCount(0);
    await expect(page.getByRole('button', { name: `Remove ${C.name}` })).toHaveCount(0);

    // The list stays open after a refusal, for another pick.
    await page.getByRole('combobox', { name: 'Project' }).fill(B.name);
    await page.getByRole('option', { name: B.name, exact: true }).click();
    await expect(page.getByRole('button', { name: `Remove ${B.name}` })).toBeVisible();

    // Sent, the set goes with the message, which the service stores on it and
    // reads it from. This stub refuses the request, so the message is not
    // taken and comes back to the box.
    const box = page.getByPlaceholder(/Message the assistant/);
    await box.fill('what is in the other one?');
    await box.press('Enter');
    await expect
      .poll(() => asked.find((d) => d?.op === 'send')?.projects ?? null)
      .toEqual([{ id: B.id, name: B.name }]);
    await expect(box).toHaveValue('what is in the other one?');
  });
};
