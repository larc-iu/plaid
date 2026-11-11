import { test, expect, seedAuth } from './fixtures.js';
import { getFixture, makeClient } from './fixtureProject.js';

// The info bubble beside a run dialog's Method, opened inside the modal
// Auto-analyze dialog. The dialog locks scrolling outside itself, and the
// bubble is drawn outside it, so a wheel over the bubble did nothing and only
// its scroll bar moved it. A probe analysis service with a long summary is
// registered for the length of the spec, so it runs on a fresh database.

const PROBE = {
  serviceId: 'e2e:popover-probe',
  serviceName: 'Probe glosser',
  description: 'Proposes segmentation and glosses',
};

// Hard-wrapped like every service's summary, and long enough to scroll.
const PARAGRAPH = `**Probe glosser** proposes a morpheme segmentation and
glosses for every word of the document in one pass, from the words and each
sentence's free translation.`;
const ITEMS = Array.from(
  { length: 14 },
  (_, i) => `- **Option ${i + 1}**: what the option does, written over two lines
  as a service's own summary is.`,
).join('\n');
const SUMMARY = `${PARAGRAPH}\n\n${ITEMS}\n\nThe last paragraph.\n`;

let client;
let projectId;
let documentId;
let registration;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  client = makeClient();
  ({ projectId, documentId } = await getFixture());
  registration = client.messages.serve(
    projectId,
    PROBE,
    (_data, helper) => helper.error('not served'),
    {
      schemaVersion: 1,
      tasks: ['analyze'],
      summary: SUMMARY,
      // A list longer than its box, for the Select test below.
      parameters: [
        {
          key: 'variety',
          label: 'Variety',
          type: 'enum',
          options: Array.from({ length: 40 }, (_, i) => ({
            value: `v${i + 1}`,
            label: `Variety ${i + 1}`,
          })),
        },
      ],
    },
  );
  await expect
    .poll(
      async () =>
        (await client.messages.discoverServices(projectId)).some(
          (s) => s.serviceId === PROBE.serviceId && s.online,
        ),
      { timeout: 15000 },
    )
    .toBe(true);
});

test.afterAll(async () => {
  registration?.stop();
  await expect
    .poll(
      () =>
        client.messages.discardService(projectId, PROBE.serviceId).then(
          () => true,
          () => false,
        ),
      { timeout: 30000 },
    )
    .toBe(true);
});

async function openBubble(page) {
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=analyze`);
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  await page.getByRole('button', { name: /Auto-analyze/ }).click();
  const dialog = page.getByRole('dialog', { name: /Auto-analyze/ });
  await expect(dialog).toBeVisible();
  const step = dialog.getByRole('checkbox', { name: /Propose segmentation and glosses/ });
  if (!(await step.isChecked())) await step.check();
  // Another analysis service may be online too: pick the probe.
  const method = dialog.getByRole('combobox').filter({ hasNotText: 'Variety' });
  if (await method.count()) {
    await method.first().click();
    await page.getByRole('option', { name: PROBE.serviceName }).click();
  }
  const info = dialog.getByRole('button', { name: `About ${PROBE.serviceName}` });
  await info.click();
  const bubble = page.locator('[data-radix-popper-content-wrapper] > *', {
    hasText: 'The last paragraph.',
  });
  await expect(bubble).toBeVisible();
  return { dialog, info, bubble };
}

const scrollTopOf = (locator) => locator.evaluate((el) => el.scrollTop);

test('the wheel scrolls the info bubble inside the Auto-analyze dialog', async ({ page }) => {
  const { dialog, bubble } = await openBubble(page);
  const sizes = await bubble.evaluate((el) => [el.scrollHeight, el.clientHeight]);
  expect(sizes[0]).toBeGreaterThan(sizes[1]);
  expect(await scrollTopOf(bubble)).toBe(0);

  const box = await bubble.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 120);
  await expect.poll(() => scrollTopOf(bubble)).toBeGreaterThan(0);

  // Wheeling past its end scrolls nothing behind it: not the dialog's body and
  // not the page.
  // Every scroll position in the dialog, its own and its body's.
  const dialogScroll = () =>
    dialog.evaluate((el) => [el, ...el.querySelectorAll('*')].map((n) => n.scrollTop).join(','));
  const before = {
    dialog: await dialogScroll(),
    page: await page.evaluate(() => document.scrollingElement.scrollTop),
  };
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 400);
  await expect
    .poll(() => bubble.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1))
    .toBe(true);
  await page.waitForTimeout(200);
  expect(await dialogScroll()).toBe(before.dialog);
  expect(await page.evaluate(() => document.scrollingElement.scrollTop)).toBe(before.page);
});

test('the bubble scrolls by keyboard, and closes as before', async ({ page }) => {
  const { dialog, info, bubble } = await openBubble(page);
  // Opened, it holds focus, so the keys scroll it.
  await page.keyboard.press('PageDown');
  await expect.poll(() => scrollTopOf(bubble)).toBeGreaterThan(0);

  // Escape closes the bubble and not the dialog, and focus goes back to the
  // button that opened it.
  await page.keyboard.press('Escape');
  await expect(bubble).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(info).toBeFocused();

  // A click elsewhere in the dialog closes it too.
  await info.click();
  await expect(bubble).toBeVisible();
  await dialog.getByText('Propose segmentation and glosses').click();
  await expect(bubble).toHaveCount(0);
  await expect(dialog).toBeVisible();
});

test("a summary's hard-wrapped lines flow, and its paragraphs and list items stay apart", async ({
  page,
}) => {
  const { bubble } = await openBubble(page);
  const body = bubble.locator('.md-body');
  await expect(body.locator('br')).toHaveCount(0);
  await expect(body.locator('p')).toHaveCount(2);
  await expect(body.locator('li')).toHaveCount(14);
  // The first paragraph's three source lines lay out as running text: its
  // first line is full, not cut at the source's newline after "and".
  const lines = await body
    .locator('p')
    .first()
    .evaluate((p) => {
      const range = document.createRange();
      range.selectNodeContents(p);
      return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
    });
  expect(lines).toBeLessThan(5);
  await expect(body.locator('p').first()).toContainText('segmentation and glosses for every word');
});
for (const dir of ['ltr', 'rtl']) {
  test(`the bubble stays on screen in a narrow window, ${dir}`, async ({ page }) => {
    await page.setViewportSize({ width: 520, height: 560 });
    await page.addInitScript((d) => {
      document.addEventListener('DOMContentLoaded', () => {
        document.documentElement.dir = d;
      });
    }, dir);
    const { bubble } = await openBubble(page);
    const box = await bubble.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(520);
    expect(box.y + box.height).toBeLessThanOrEqual(560);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 120);
    await expect.poll(() => scrollTopOf(bubble)).toBeGreaterThan(0);
  });
}

// A Select in the dialog holds a scroll lock of its own and always scrolled:
// kept here so the popover change is seen to leave it so.
test("a parameter's Select list in the dialog scrolls under the wheel", async ({ page }) => {
  const { dialog } = await openBubble(page);
  await page.keyboard.press('Escape');
  await dialog.getByRole('combobox').filter({ hasText: 'Variety 1' }).click();
  const list = page.locator('[data-radix-select-viewport]');
  await expect(list).toBeVisible();
  const box = await list.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 200);
  await expect.poll(() => scrollTopOf(list)).toBeGreaterThan(0);
});
