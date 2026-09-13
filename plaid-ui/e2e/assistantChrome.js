// What both apps' assistant-chrome specs drive the panel with.
//
// The panel, the chip, the rail and the gutter are one component in this
// package (src/components/assistant/AssistantChrome.jsx), so the specs that
// hold its behaviour still were the same spec twice: the same stub service, the
// same route interception, a conversation seeded the same way straight into the
// user's key/value store, and the same four locators. What genuinely differs is
// the app's tag, the URL a document opens at, and the element that says a
// document has finished loading.
//
// It imports NOTHING. This file sits outside both apps and can resolve neither
// Playwright nor `@larc-iu/plaid-client` from here, so `expect` and a client
// factory come in as arguments. Each app's spec imports it by relative path
// (`../../plaid-ui/e2e/assistantChrome.js`).
//
// The project and the signed-in user are read through functions because a spec
// learns both in `beforeAll`, after this is built.

// An assistant made to look online by answering the one discovery GET. No model
// and no service process: everything these specs hold still is what a turn does
// not touch.
export const assistantStub = (app, over = {}) => [
  {
    serviceId: `${app}:assist:test`,
    serviceName: `${app.toUpperCase()} Assistant (test)`,
    description: 'A stand-in for the specs.',
    extras: { model: 'test/model', app, tasks: ['assist'] },
    tasks: ['assist'],
    online: true,
    ...over,
  },
];

export const assistantHarness = ({
  app,
  expect,
  // () => a PlaidClient signed in as the e2e admin.
  client,
  // () => the signed-in user's id, and () => the project the spec seeded.
  userId,
  projectId,
  // (documentId) => the hash route that opens a document for annotating.
  documentPath,
  // What says that document has finished loading.
  contentSelector,
}) => {
  const services = assistantStub(app);

  const withAssistant = (page, found = services) =>
    page.route('**/api/v1/projects/*/services', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(found),
      }),
    );

  const convKey = (kind, id, inProject = projectId()) =>
    `${app}:assistant:${inProject}:${kind}:${id}`;

  // A conversation is a record in the user's own key/value store that the
  // service writes, so one can be put straight in and the panel driven from
  // there. No model and no service needed.
  const seedConversation = async ({ id, title, text, updatedAt, inProject = projectId() }) => {
    const c = client();
    await c.userData.put(userId(), convKey('conv', id, inProject), {
      messages: [
        { role: 'user', content: text },
        { role: 'assistant', content: 'Noted.' },
      ],
      display: [
        { kind: 'user', text },
        {
          kind: 'assistant',
          text: `Reply to ${title}`,
          plan: null,
          citations: [],
          status: null,
          model: 'e2e/model',
          steps: [],
          stepsSummary: '',
        },
      ],
    });
    await c.userData.put(userId(), convKey('meta', id, inProject), {
      id,
      title,
      createdAt: updatedAt,
      updatedAt,
      serviceId: `${app}:assist:test`,
      model: 'test/model',
      turns: 1,
      pending: null,
    });
    return id;
  };

  // Both keys, for every project a spec may have written the conversation into.
  const dropConversations = async (ids, projects) => {
    const c = client();
    for (const id of ids) {
      for (const p of projects.filter(Boolean)) {
        for (const kind of ['conv', 'meta']) {
          await c.userData.delete(userId(), convKey(kind, id, p)).catch(() => {});
        }
      }
    }
  };

  // `aside.border-l` is the dock; the chip and the rail are named apart on
  // purpose, since two controls with one name is ambiguous for a screen reader
  // and for a locator.
  const panelOf = (page) => page.locator('aside.border-l');
  const toggle = (page) => page.getByRole('button', { name: 'Assistant', exact: true });
  const rail = (page) => page.getByRole('button', { name: 'Open the assistant' });

  const openDock = async (page) => {
    await toggle(page).click();
    await expect(panelOf(page)).toBeVisible();
  };

  // Open a document and wait until it is actually showing something, which is
  // what every test here needs before it can touch the panel beside it.
  const gotoDocument = async (page, documentId) => {
    await page.goto(documentPath(documentId));
    await expect(page.locator(contentSelector).first()).toBeVisible({ timeout: 15000 });
  };

  return {
    services,
    withAssistant,
    convKey,
    seedConversation,
    dropConversations,
    panelOf,
    toggle,
    rail,
    openDock,
    gotoDocument,
    contentSelector,
  };
};
