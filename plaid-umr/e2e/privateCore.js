// Whether a fixture may delete what it finds: only on a core the round runner
// started for this run. The shared dev core is Luke's, and nothing on it is
// ever deleted. It answers on :8085 and, through each app's dev proxy, on
// 5173 to 5176, so a port that is not 8085 proves nothing. What does is the
// runner's own word (PLAID_E2E_PRIVATE_CORE, the core `bb e2e` started for the
// suite) matched by where the request really went, on a port of its own.

const SHARED_DEV_PORTS = new Set(['8085', '5173', '5174', '5175', '5176']);

const parse = (url) => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

/**
 * @param {string} requestUrl - Where a request to the core really went (a
 *   Response's `url`, after any redirect).
 * @param {string | undefined} runnerCore - The core `bb e2e` started
 *   for this run (`process.env.PLAID_E2E_PRIVATE_CORE`), unset outside it.
 */
export function isPrivateCore(requestUrl, runnerCore) {
  const got = parse(requestUrl);
  const want = runnerCore ? parse(runnerCore) : null;
  if (!got || !want) return false;
  // No port: a proxy in front of some core, which could be the shared one.
  if (!got.port || SHARED_DEV_PORTS.has(got.port)) return false;
  return got.origin === want.origin;
}
