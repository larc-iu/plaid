// An opt-in check for specs that read the server right after an edit.
//
// Every edit in every app is on screen before its write lands, so a spec that
// makes an edit through the page and then reads the document back through the
// client must first wait for the server to have the write. A networkidle
// reached on load is no barrier, and a fixed sleep only holds on a fast core.
// With PLAID_E2E_WRITE_DELAY_MS set, every write the page sends to /api is
// held that long before it goes out, so a spec that reads too early fails
// every time instead of once in a while.
//
//   PLAID_E2E_WRITE_DELAY_MS=800 npx playwright test
//
// Unset (the default), nothing is routed and the suite runs as before.

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Reads that go out as a POST. Holding these too keeps the page from reaching
// networkidle, which then waits past the write as well and hides the race.
const POST_READS = /\/api\/v1\/(query|invites\/lookup|login)(\?|$)/;

// Whether a request to /api is a write.
const isWrite = (req) => WRITES.has(req.method()) && !POST_READS.test(req.url());

const writeDelayMs = () => Number(process.env.PLAID_E2E_WRITE_DELAY_MS) || 0;

// Holds the context's writes to /api for `ms` before sending them on.
export async function delayWrites(context, ms = writeDelayMs()) {
  if (!ms) return;
  await context.route(/\/api\//, async (route) => {
    if (isWrite(route.request())) await new Promise((r) => setTimeout(r, ms));
    // The page may have closed while the write was held.
    await route.continue().catch(() => {});
  });
}

// A Playwright `context` fixture that installs the delay, for an app's
// `test = base.extend(...)`.
export const writeDelayFixtures = {
  // Playwright's `use`, named apart from React's so the hooks lint leaves it be.
  context: async ({ context }, provide) => {
    await delayWrites(context);
    await provide(context);
  },
};

// A page in a browser context of its own, for a spec with two tabs on one
// document. `tab.writes` counts the writes it sends, and `tab.hold()` holds
// every later one until the function it answers is called. The app signs the
// page in and opens it.
export async function countingTab(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const tab = { ctx, page, writes: 0, gate: null };
  await page.route(/\/api\/v1\//, async (route) => {
    if (isWrite(route.request())) {
      tab.writes += 1;
      if (tab.gate) await tab.gate;
    }
    await route.continue().catch(() => {});
  });
  tab.hold = () => {
    let release;
    tab.gate = new Promise((r) => (release = r));
    return () => {
      tab.gate = null;
      release();
    };
  };
  return tab;
}
