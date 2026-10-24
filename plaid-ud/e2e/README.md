# e2e

`bb e2e ud` (from the repo root) runs this suite on a core of its own: a
plaid-core from source with a fresh database, a token minted on it, and a Vite
dev server proxying to it, all on free ports, so nothing reaches the dev core.
Pass Playwright arguments after `--`, e.g. `bb e2e ud -- e2e/smoke.spec.js`.
The nightly runs it.

Run by hand, the specs talk to the core in `PLAID_CORE_URL` (the LIVE dev core,
`:8085`, when unset) as the admin `a@b.com`, with the token in
`PLAID_E2E_TOKEN`, else the non-expiring one in `../.token`. Specs and fixture
builders take the core from `CORE` in `fixtures.js` and never write a port.
Run from `plaid-ud/` with Node 24 (`nvm use 24.1.0`).

**Point it at your own dev server, not the shared one.** `PLAYWRIGHT_BASE_URL`
does that, and every spec that builds an absolute URL reads `BASE_URL` from
`fixtures.js` rather than writing a port again:

```
npx vite --port 5183 &
PLAYWRIGHT_BASE_URL=http://localhost:5183 npm run test:e2e
```

Running against a server someone else is looking at makes their page reload
under them, and editing `src/` while a run is in flight reloads the page under
the TEST, which looks exactly like flakiness. If a run fails oddly, check
nothing was being edited before believing it.

- `*.spec.js`: the Playwright suite, `npm run test:e2e`, and part of the gate.
- `fixtures.js`: the Playwright helpers (`test`, `expect`, `seedAuth`,
  `readToken`, `BASE_URL`, `collectClientErrors`), most of them handed on from
  `../../plaid-ui/e2e/appFixtures.js`.
- `../../plaid-ui/e2e/`: the specs plaid-ud and plaid-igt SHARE, because what
  they cover is one component in that package: `assistantChrome.js`,
  `assistantPanel.js`, `headerBand.js`, plus `appFixtures.js`. They import
  nothing an app owns, so `test`, `expect`, `seedAuth` and a client factory go in
  as arguments, and each app's spec supplies only its routes and selectors. A
  failure there names the shared file, which is where the fix goes.
- `fixtureProject.js`: the shared "E2E UD Fixture" project, created or found by
  `node e2e/fixtureProject.js`. Its layers come from `createUdProject`, the same
  function the New Project modal calls: never rebuild them by hand here, which
  is what rotted before.
- `seedUdDoc.js`: a throwaway project with one tokenized document, for the specs
  that need annotated words of their own. Same rule: the layers come from
  `createUdProject`.
- `live/`: engine-level checks driven through node with no browser, each with a
  usage line at the top. Run by hand when the code they cover changes.
- `scripts/`: probes, seeders and one-offs. Not part of any suite.
- `bugbash/`: the headless integrity fuzzer.

## Writing one

A spec that seeds its own project deletes it in `afterAll`. A spec that uses the
shared fixture leaves it alone: it is reused across runs on purpose.

**Check that a new assertion can fail**, by reintroducing the bug it is meant to
catch and watching it go red. Every assertion added on 2026-09-11 was checked
that way, and two of them were wrong before it. An assertion that cannot fail is
worse than none: it reads as coverage.

Two traps worth knowing, both of which have cost time here:

- A synthetic `KeyboardEvent` or `FocusEvent` does not reach React 19. Drive
  gestures with Playwright's own `press`/`click`, never with a dispatched event.
- `seedAuth` works through `addInitScript`, which runs on EVERY navigation, and
  a `/#/...` navigation is a hash change that never reloads the document. One
  identity per test, and seed localStorage only when it is unset if a test needs
  to observe what the app saved.
