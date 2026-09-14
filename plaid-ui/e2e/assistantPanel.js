// Both apps' assistant-panel spec: the panel beside an open document.
//
// `assistantChrome.js` holds what the panel is as APP chrome (it survives a
// navigation, it keeps one thread per project, it is reachable everywhere).
// This holds what it is beside a document: whether it is offered at all, how
// tall it is, that it never covers the annotation, and what the app's own "Ask"
// hands it.
//
// All of that is one component in this package
// (src/components/assistant/AssistantChrome.jsx and AssistantDock.jsx), so the
// two specs were the same spec twice: the same stub service, the same route
// interception, the same two locators, and six tests whose bodies differed only
// in which selector names the annotation and how the app spells "Ask". Neither
// copy could be right about something the other was wrong about.
//
// It imports only its sibling in this directory. This file sits outside both
// apps and can resolve neither Playwright nor `@larc-iu/plaid-client` from
// here, so `test`, `expect` and `seedAuth` come in as arguments.

import { assistantStub } from './assistantChrome.js';

const OTHER = { igt: 'ud', ud: 'igt' };

// Short enough that a document of a few sentences really scrolls, and wide
// enough that a side panel is still offered.
const SHORT_VIEWPORT = { width: 1400, height: 400 };

export const assistantPanelHarness = ({
  app,
  expect,
  // () => the hash route that opens a document for annotating.
  documentPath,
  // What says that document has finished loading, and what the panel must
  // never be drawn on top of.
  contentSelector,
}) => {
  const stub = assistantStub(app);
  // The OTHER app's assistant, online on this very project. UD and IGT share
  // projects, so that is the ordinary state of a shared one, not a contrivance.
  const foreign = assistantStub(OTHER[app], { serviceName: 'Assistant from the other app' });

  // The one call that decides whether an assistant exists. An empty list is how
  // "none running" looks to the app.
  const withAssistant = (page, services = stub) =>
    page.route('**/api/v1/projects/*/services', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(services),
      }),
    );

  const panelOf = (page) => page.locator('aside.border-l');
  const toggle = (page) => page.getByRole('button', { name: 'Assistant', exact: true });

  const openDocument = async (page) => {
    await page.goto(documentPath());
    await expect(page.locator(contentSelector).first()).toBeVisible({ timeout: 15000 });
  };

  return { stub, foreign, withAssistant, panelOf, toggle, openDocument, contentSelector };
};

// The tests themselves, for the app-agnostic half.
//
// What each app supplies is where its document is, what names the annotation on
// it, and how a reader asks about a sentence.
export const assistantPanelTests = ({
  test,
  expect,
  seedAuth,
  panel: harness,
  // The document's name, which the panel's header must not repeat.
  documentName,
  // How this app offers to ask about a sentence.
  //   absent: assert the app's own affordance is not offered.
  //   first:  ask about the first sentence, which opens the panel by itself.
  //   last:   scroll the last sentence into view and answer with
  //           `{watch, click}`: the element whose place on screen must not
  //           move, and how to ask about it.
  ask,
  // Anything else this app hides when no assistant is online. Runs last, so it
  // may navigate.
  alsoHidden = async () => {},
}) => {
  const { stub, foreign, withAssistant, panelOf, toggle, openDocument, contentSelector } = harness;

  const open = async (page, services = stub) => {
    await seedAuth(page);
    await withAssistant(page, services);
    await openDocument(page);
  };

  test.describe('the assistant panel beside a document', () => {
    test('nothing offers an assistant when none is online', async ({ page }) => {
      // A control that opens an empty panel is worse than no control.
      await open(page, []);
      await expect(toggle(page)).toHaveCount(0);
      await ask.absent(page);
      await alsoHidden(page);
    });

    test("the OTHER app's assistant does not count as one", async ({ page }) => {
      // It happened: the filter asked only whether a service does `assist`, so
      // one app offered the other's `assist` service on a shared project. A
      // conversation's record is namespaced by the app it was started in, so
      // every turn came back "No such conversation" and the thread could never
      // be answered.
      await open(page, foreign);
      await expect(toggle(page)).toHaveCount(0);
      await ask.absent(page);
      await alsoHidden(page);
    });

    test('the panel is exactly as tall as the screen, composer and all', async ({ page }) => {
      await open(page);
      await toggle(page).click();

      const panel = panelOf(page);
      await expect(panel).toBeVisible();
      // ONE header bar. The panel used to carry a second one above the
      // assistant's own row, repeating the document's name, which the page's
      // heading says a few pixels to the left. The hide button lives in the
      // remaining row.
      await expect(panel.locator('header')).toHaveCount(1);
      await expect(panel.locator('header')).not.toContainText(documentName);
      await expect(panel.getByTitle('Hide the assistant')).toBeVisible();

      const box = await panel.boundingBox();
      const viewport = page.viewportSize();
      // It is fixed to the viewport, so this holds by construction rather than
      // by measurement. It did not always: guessing a height in CSS put the
      // composer off the bottom of the screen, because an app header,
      // breadcrumbs, a tab strip, a run banner and a history drawer all sit
      // above where the panel used to start, and not one is a fixed height.
      expect(box.y).toBe(0);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
      expect(box.y + box.height).toBeGreaterThan(viewport.height - 4);

      const composer = panel.getByRole('textbox');
      const cbox = await composer.boundingBox();
      expect(cbox.y + cbox.height).toBeLessThanOrEqual(viewport.height);
    });

    test('the panel never covers the annotation', async ({ page }) => {
      // The dock is fixed and the shell pads by its width. Padding the wrong
      // element (or none) leaves the page as wide as it was and the panel
      // sitting on top of the annotation, which is the one thing it must never
      // do.
      await open(page);
      await toggle(page).click();
      const box = await panelOf(page).boundingBox();

      const overlap = await page.evaluate(
        ([selector, panelLeft]) =>
          document.querySelector(selector).getBoundingClientRect().right - panelLeft,
        [contentSelector, box.x],
      );
      expect(overlap).toBeLessThanOrEqual(0);
      // And the app header stops short of it too, rather than running
      // underneath.
      const header = await page.locator('header').first().boundingBox();
      expect(header.x + header.width).toBeLessThanOrEqual(box.x + 1);
    });

    test('Ask puts the sentence in the composer and then lets go of it', async ({ page }) => {
      await open(page);
      // The gesture opens the panel by itself: it is how you start asking.
      await ask.first(page);

      const panel = panelOf(page);
      await expect(panel).toBeVisible();
      await expect(panel).toContainText('Sentence');
      await expect(panel).toContainText('s1');

      // Removing the chip leaves the conversation alone.
      await panel.getByRole('button', { name: 'Remove' }).click();
      await expect(panel).not.toContainText('Sentence');
    });

    test('Ask keeps the reader where they were', async ({ page }) => {
      // Opening the panel used to dump the reader at the top of the document:
      // measuring the docked height puts the page at the top to do it, and the
      // discarded offset was the reader's place. Worst on "Ask", whose whole
      // point is the sentence in front of you. The dock is fixed in the shell
      // now, so nothing measures anything and the page is never touched, and
      // the assertion is correspondingly stronger: the scroll position is not
      // restored to within a line, it is UNCHANGED.
      await seedAuth(page);
      await withAssistant(page);
      await page.setViewportSize(SHORT_VIEWPORT);
      await openDocument(page);

      const { watch, click } = await ask.last(page);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
      const scrolledTo = await page.evaluate(() => window.scrollY);
      const before = await watch.boundingBox();

      await click();
      await expect(panelOf(page)).toBeVisible();
      expect(await page.evaluate(() => window.scrollY)).toBe(scrolledTo);

      // The sentence asked about is still on screen, within a line of where it
      // was. Not exactly where it was: the dock takes width, so the column
      // narrows and what is above re-wraps. That reflow is the reason for a
      // tolerance here, and it is why the scroll position above is the
      // assertion that can be exact.
      const after = await watch.boundingBox();
      expect(after).not.toBeNull();
      expect(after.y).toBeGreaterThan(0);
      expect(after.y).toBeLessThan(SHORT_VIEWPORT.height);
      expect(Math.abs(after.y - before.y)).toBeLessThan(80);
    });
  });
};
