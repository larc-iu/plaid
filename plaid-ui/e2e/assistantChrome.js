// Both apps' assistant-chrome spec: the harness they drive the panel with, and
// the tests that are about the panel rather than about either app.
//
// The panel, the chip, the rail and the gutter are one component in this
// package (src/components/assistant/AssistantChrome.jsx), so the specs that
// held its behaviour still were the same spec twice: the same stub service, the
// same route interception, a conversation seeded the same way straight into the
// user's key/value store, the same four locators, and then thirteen tests of
// which 270 lines out of 355 were byte-identical. What genuinely differs is the
// app's tag, where its screens are, and what says one has arrived.
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

// The tests themselves, for the app-agnostic half.
//
// Thirteen of them were written twice, once per app, and 270 of the two specs'
// 355 lines were byte-identical: every one is about the CHROME, which is one
// component in this package, so neither copy could ever be right about
// something the other was wrong about. What each app supplies is where its
// screens are and what says one has arrived.
//
// `test`, `expect` and `seedAuth` come in as arguments for the same reason the
// harness's do: this file can resolve neither Playwright nor the app's fixtures
// from here.
//
// A `place` is `{path, seen}`: where to go, and an assertion that waits until
// the screen is there. Paths are functions because a spec learns its ids in
// `beforeAll`.
export const assistantChromeTests = ({
  test,
  expect,
  seedAuth,
  chrome,
  // () => the id of the document with annotation on it.
  documentId,
  // A second document in the same project, to walk to.
  secondDocument,
  // A screen of the same project that is not about a document.
  projectScreen,
  // Somewhere else again that still holds the thread: another KIND of subject,
  // or another project screen.
  elsewhere,
  // A screen with no project in scope at all.
  projectlessScreen,
  // The full Assistant tab.
  assistantTab,
  // Every screen the control has to be offered on, after the projects list.
  screensWithControl,
  // What `@` is typed, what the list then shows, and what Enter leaves behind.
  mention,
  // () => the name of the project to pick in the empty state's picker.
  projectName,
  // The app's own "Ask", which the panel is what makes usable. `hide` runs at
  // 800px and `show` after widening again, because one app's grid does not
  // repaint on a resize and has to be reloaded to be read.
  ask,
  // (title, text, updatedAt) => Promise<id>, remembered by the spec for cleanup.
  seedConversation,
}) => {
  const { withAssistant, panelOf, toggle, rail, openDock, gotoDocument, contentSelector } = chrome;
  const open = async (page) => {
    await seedAuth(page);
    await withAssistant(page);
    await gotoDocument(page, documentId());
    await openDock(page);
  };
  const go = async (page, place) => {
    await page.goto(place.path());
    await place.seen(page);
  };

  test.describe('assistant chrome', () => {
    test('the panel keeps its conversation across a navigation', async ({ page }) => {
      // The whole point. A half-typed message is the cheapest observable proof
      // that the panel was not torn down and rebuilt: its composer is component
      // state, so it cannot survive a remount. Nothing about the assistant is
      // stubbed beyond discovery, so this needs no service to answer.
      await open(page);
      await panelOf(page).getByRole('textbox').fill('half a question about');

      // To another document in the same project.
      await go(page, secondDocument);
      await expect(panelOf(page)).toBeVisible();
      await expect(panelOf(page).getByRole('textbox')).toHaveValue('half a question about');

      // And on to the project's own screens, which are not about a document.
      await go(page, projectScreen);
      await expect(panelOf(page)).toBeVisible();
      await expect(panelOf(page).getByRole('textbox')).toHaveValue('half a question about');
    });

    test('the panel holds its project on a screen that has none', async ({ page }) => {
      // The assistant is per project all the way down, so the panel keeps the
      // one it has rather than emptying itself or closing.
      await open(page);
      await panelOf(page).getByRole('textbox').fill('still here');

      await go(page, projectlessScreen);
      await expect(panelOf(page)).toBeVisible();
      await expect(panelOf(page).getByRole('textbox')).toHaveValue('still here');
    });

    test('the panel stays shut across a navigation once it is shut', async ({ page }) => {
      // The flip side, and the reason the state is remembered per browser
      // rather than per screen: a reader who closed it does not want it back on
      // the next screen, or on the next visit.
      await open(page);
      await panelOf(page).getByTitle('Hide the assistant').click();
      await expect(panelOf(page)).toHaveCount(0);

      await go(page, projectScreen);
      await expect(panelOf(page)).toHaveCount(0);
      await expect(toggle(page)).toBeVisible();

      // Reloading the app does not bring it back either.
      await gotoDocument(page, documentId());
      await expect(panelOf(page)).toHaveCount(0);
    });

    test('the handle waits at the edge, widens under the pointer, and does not open on hover', async ({
      page,
    }) => {
      // The affordance the panel is reached by, and the reason it can start
      // shut: a sliver against the right edge that widens to show its mark.
      // Hover must NOT open the panel, or it would open itself every time the
      // cursor drifted out to a scrollbar.
      await seedAuth(page);
      await withAssistant(page);
      await gotoDocument(page, documentId());

      const handle = rail(page);
      await expect(handle).toBeVisible();
      const viewport = page.viewportSize();
      const idle = await handle.boundingBox();
      // Against the right edge, and vertically centred.
      expect(idle.x + idle.width).toBeGreaterThan(viewport.width - 2);
      expect(Math.abs(idle.y + idle.height / 2 - viewport.height / 2)).toBeLessThan(2);
      expect(idle.width).toBeLessThan(20);

      await handle.hover();
      await expect
        .poll(async () => (await handle.boundingBox()).width)
        .toBeGreaterThan(idle.width * 2);
      // Widened, but the panel is still shut: hovering is not opening.
      await expect(panelOf(page)).toHaveCount(0);

      await handle.click();
      await expect(panelOf(page)).toBeVisible();
      // And both ways in step out of the way once the panel is open.
      await expect(handle).toHaveCount(0);
      await expect(toggle(page)).toHaveCount(0);
    });

    test('`@` offers the sentences of the open document, and Enter takes one', async ({ page }) => {
      // The reader's half of the reference vocabulary. Ask can only point at
      // the row you are looking at. `@` names a sentence you are not, and it
      // matches on what the sentence SAYS, because nobody knows they want s2.
      await open(page);

      const composer = panelOf(page).getByRole('textbox');
      await composer.fill(mention.typed);
      const list = panelOf(page).getByText('Sentences', { exact: true });
      await expect(list).toBeVisible();
      await expect(panelOf(page).getByText(mention.shows)).toBeVisible();

      // Enter takes the highlighted row. It must NOT send: this composer sends
      // on Enter, and arbitrating that is the whole risk in the gesture.
      await composer.press('Enter');
      // The composer still HOLDING the text is the proof that nothing was
      // sent: send() clears it.
      await expect(composer).toHaveValue(mention.inserts);
      await expect(panelOf(page).getByText('Sentences', { exact: true })).toHaveCount(0);

      // Escape closes the list and leaves what was typed alone.
      await composer.fill('about @s');
      await expect(panelOf(page).getByText('Sentences', { exact: true })).toBeVisible();
      await composer.press('Escape');
      await expect(panelOf(page).getByText('Sentences', { exact: true })).toHaveCount(0);
      await expect(composer).toHaveValue('about @s');
    });

    test('the panel comes back open if that is how it was left', async ({ page }) => {
      // Remembered per browser, and across a LOAD rather than only within the
      // session: a thread the reader was in the middle of is the likeliest
      // reason they came back to the app at all. A reader who has never opened
      // it still gets it shut, which is what the first assertion stands on.
      await seedAuth(page);
      await withAssistant(page);
      await gotoDocument(page, documentId());
      await expect(panelOf(page)).toHaveCount(0);

      await openDock(page);
      await page.reload();
      await expect(page.locator(contentSelector).first()).toBeVisible({ timeout: 15000 });
      await expect(panelOf(page)).toBeVisible();
      // Open, so neither way in is offered.
      await expect(toggle(page)).toHaveCount(0);
      await expect(rail(page)).toHaveCount(0);

      // And shut stays shut across one too.
      await panelOf(page).getByTitle('Hide the assistant').click();
      await expect(panelOf(page)).toHaveCount(0);
      await page.reload();
      await expect(page.locator(contentSelector).first()).toBeVisible({ timeout: 15000 });
      await expect(panelOf(page)).toHaveCount(0);
    });

    test('the control is offered on every screen after signing in', async ({ page }) => {
      // "Always available" means the control does not come and go with the
      // route. On a screen with no project in scope it opens the picker
      // instead of the chat, which is why it is offered there too rather than
      // hidden.
      await seedAuth(page);
      await withAssistant(page);

      await page.goto('/#/projects');
      await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
      await expect(toggle(page)).toBeVisible();

      for (const place of screensWithControl) {
        await go(page, place);
        await expect(toggle(page)).toBeVisible();
      }
    });

    test('the panel is not offered on the Assistant tab, which is the same thread', async ({
      page,
    }) => {
      // Both would draw the same live turn, each with its own step list, Stop
      // button and composer, and nothing would say which one was the live one.
      await open(page);

      await go(page, assistantTab);
      await expect(panelOf(page)).toHaveCount(0);
      await expect(toggle(page)).toHaveCount(0);
      await expect(rail(page)).toHaveCount(0);

      // Off that tab and the panel is back, still open: the reader never shut
      // it.
      await go(page, projectScreen);
      await expect(panelOf(page)).toBeVisible();
    });

    test('a window too narrow for a side panel is not offered one', async ({ page }) => {
      await open(page);

      await page.setViewportSize({ width: 800, height: 800 });
      // Taking a third of 800px leaves neither the annotation nor the chat
      // usable.
      await expect(panelOf(page)).toHaveCount(0);
      await expect(toggle(page)).toHaveCount(0);
      // Including the grid's own "Ask": it hands the shell a reference and the
      // shell opens the panel on it, so here it would do nothing at all.
      await ask.hide(page);

      // Widening gives it back, still open: the reader never closed it.
      await page.setViewportSize({ width: 1400, height: 800 });
      await ask.show(page);
      await expect(panelOf(page)).toBeVisible();
    });

    test('toasts do not land on top of the panel', async ({ page }) => {
      // Every toast in the app is bottom-right, which is exactly where the
      // dock's composer is. The shell publishes the dock's width and the
      // toaster steps left by it.
      await open(page);

      const width = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--plaid-dock-width'),
      );
      expect(parseInt(width, 10)).toBeGreaterThan(0);

      // Sonner only paints its container once a toast is raised, so the rule is
      // checked against a stand-in carrying the attributes it sets.
      await page.evaluate(() => {
        const el = document.createElement('div');
        el.setAttribute('data-sonner-toaster', '');
        el.setAttribute('data-x-position', 'right');
        el.style.position = 'fixed';
        el.style.bottom = '0';
        document.body.appendChild(el);
      });
      const right = await page.evaluate(
        () => getComputedStyle(document.querySelector('[data-sonner-toaster]')).right,
      );
      expect(parseInt(right, 10)).toBeGreaterThan(parseInt(width, 10));
    });

    test("the panel resumes the project's newest thread and holds it while the reader moves", async ({
      page,
    }) => {
      // The decision this pins down: ONE thread per project, wherever you are
      // in it. Each subject used to remember its own, which is right for a
      // panel that belongs to one screen and wrong for one that does not:
      // walking to the next document swapped the conversation under the
      // reader, so nothing spanning two screens could be asked at all.
      await seedAuth(page);
      await withAssistant(page);
      const older = await seedConversation(
        'chrome older thread',
        'the older question',
        '2020-01-01T00:00:00.000Z',
      );
      const newer = await seedConversation(
        'chrome newer thread',
        'the newer question',
        '2030-01-01T00:00:00.000Z',
      );
      expect(older).not.toBe(newer);

      await gotoDocument(page, documentId());
      await openDock(page);

      // The newest, not a blank one: the panel comes back on every screen and
      // on every visit, so starting empty would mean going to find your own
      // thread.
      const panel = panelOf(page);
      await expect(panel.getByText('the newer question')).toBeVisible();

      // To another document. The SAME thread, not one about the new document
      // and not a fresh one.
      await go(page, secondDocument);
      await expect(panel.getByText('the newer question')).toBeVisible();
      await expect(panel.getByText('the older question')).toHaveCount(0);

      // And on somewhere else again.
      await go(page, elsewhere);
      await expect(panel.getByText('the newer question')).toBeVisible();
    });

    test('the panel opens a past conversation without leaving the screen', async ({ page }) => {
      // The panel is where the assistant lives now, so the list of past
      // conversations cannot live only in the tab: going there to find one
      // means leaving the annotation the question was about. It hangs off the
      // panel's own header instead, and picking a thread does not navigate.
      await seedAuth(page);
      await withAssistant(page);
      await seedConversation(
        'chrome archived thread',
        'the archived question',
        '2021-01-01T00:00:00.000Z',
      );

      await gotoDocument(page, documentId());
      await openDock(page);
      const panel = panelOf(page);
      // From a blank conversation, so what the panel shows next can only have
      // come from the list.
      await panel.getByTitle('New conversation').click();
      await expect(panel.getByText('the archived question')).toHaveCount(0);

      const url = page.url();
      await panel.getByTitle('Past conversations').click();
      const history = page.getByRole('dialog');
      await history.getByText('chrome archived thread').click();
      await expect(panel.getByText('the archived question')).toBeVisible();
      // The popover closes on the way: it takes a third of the panel's height
      // and covers the thread it was asked to open.
      await expect(history).toHaveCount(0);
      // Still on the document. The conversation is not in this URL because the
      // URL belongs to the screen behind the panel.
      expect(page.url()).toBe(url);
    });

    test('the panel is reachable on the screen a reader lands on, and asks which project', async ({
      page,
    }) => {
      // "Always available after login" has to include the FIRST screen.
      // Nothing is in scope there, and the assistant cannot work without a
      // project, so the panel asks for one rather than sitting empty or
      // refusing to open.
      await seedAuth(page);
      await withAssistant(page);
      await page.goto('/#/projects');
      await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

      await toggle(page).click();
      const panel = panelOf(page);
      await expect(panel).toBeVisible();
      await expect(panel.getByText('Choose a project')).toBeVisible();

      // And it can be shut from here, the way the chat can, before any project
      // is chosen. A panel with no way out is not "available", it is in the
      // way.
      await panel.getByTitle('Hide the assistant').click();
      await expect(panel).toHaveCount(0);
      await toggle(page).click();
      await expect(panel.getByText('Choose a project')).toBeVisible();

      // Choosing one is what gives the panel something to be about, without
      // leaving the screen the reader is on.
      await panel.getByRole('button', { name: projectName() }).click();
      await expect(panel.getByText('Choose a project')).toHaveCount(0);
      await expect(panel.getByRole('textbox')).toBeVisible();
      await expect(page).toHaveURL(/#\/projects$/);
    });
  });
};
