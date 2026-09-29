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

const writeDelayMs = () => Number(process.env.PLAID_E2E_WRITE_DELAY_MS) || 0;

// Holds the context's writes to /api for `ms` before sending them on.
export async function delayWrites(context, ms = writeDelayMs()) {
  if (!ms) return;
  await context.route(/\/api\//, async (route) => {
    const req = route.request();
    if (WRITES.has(req.method()) && !POST_READS.test(req.url()))
      await new Promise((r) => setTimeout(r, ms));
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
