# e2e

Everything here runs against the LIVE dev core (`:8085`) and dev server (`:5174`),
as the admin `a@b.com` whose non-expiring token is in `../.token`. Run from
`plaid-igt/` with Node 24 (`nvm use 24.1.0`).

**Point it at your own dev server, not the shared one**, the way plaid-ud's
README says. `npm run test:e2e:own` starts a private one and stops it
afterwards, and `PLAYWRIGHT_BASE_URL` points the suite at one you started
yourself:

```
npx vite --port 5185 &
PLAYWRIGHT_BASE_URL=http://localhost:5185 npm run test:e2e
```

Running against a server someone else is looking at reloads their page, and
editing `src/` while a run is in flight reloads the page under the TEST, which
looks exactly like flakiness. If a run fails oddly, check nothing was being
edited before believing it. A run started with `PLAYWRIGHT_OWN_SERVER=1` also
keeps its artifacts in `test-results/<port>`, so two runs from this directory do
not clobber each other's and fail with `browserContext.close: ENOENT`.

- `*.spec.js`: the Playwright suite, `npm run test:e2e`. Specs share the
  "E2E IGT Fixture" project that `node e2e/fixtureProject.js` creates or finds.
  A spec that writes into it puts it back; `node e2e/scripts/reset-fixture.mjs`
  says whether one did not.
- `fixtures.js`: the Playwright helpers (`test`, `expect`, `seedAuth`, `readToken`,
  `collectClientErrors`), most of them handed on from
  `../../plaid-ui/e2e/appFixtures.js`. Every spec here navigates by relative path,
  so the base URL stays Playwright's own. `fixtureProject.js`: the fixture project
  builder.
- `../../plaid-ui/e2e/`: the specs plaid-igt and plaid-ud SHARE, because what
  they cover is one component in that package: `assistantChrome.js`,
  `assistantPanel.js`, `headerBand.js`, plus `appFixtures.js`. They import
  nothing an app owns, so `test`, `expect`, `seedAuth` and a client factory go in
  as arguments, and each app's spec supplies only its routes and selectors. A
  failure there names the shared file, which is where the fix goes.
- `live/`: engine-level checks that drive the importers, exporters, services,
  and the domain model through node with no browser, each with a usage line at
  the top. They are run by hand when the code they cover changes. Run them with
  `node --import ./e2e/live/aliases.mjs <script>`: app code is written against
  Vite's `@/` and `@ui/` aliases, and node resolves neither, so without it a
  script dies at import the moment it reaches a module using one.
- `scripts/`: seeders, demos, and screenshots. `uxseed.mjs` and `uxshot.mjs` seed
  and screenshot the grid headlessly. `reset-fixture.mjs` reports and removes
  anything the shared fixture document carries that `fixtureProject.js` did not
  seed, and takes `--dry-run`.
- `bugbash/`: the headless integrity fuzzer and its harness (`harness.mjs` is
  also the client and fixture lookup the live scripts use).
- `fidelity/`: the import/export fidelity campaign. Unlike everything above it
  runs on a PRIVATE core it boots from source (`core.mjs`), never on :8085.
  `kitchenSink.mjs` builds projects holding every feature in
  `src/test/fidelity/catalog.js`, `snapshot.mjs` reads a project back as one
  id-free value, and `coverage.mjs` checks the one against the other.
  `roundTrip.mjs` exports the kitchen sink through native, CLDF and ELAN
  (`drivers.mjs`, the screens' own calls), imports each export, and compares the
  new project with what the format's loss list says should come back
  (`src/test/fidelity/expect/`), then exports it again and compares that with
  the first export (`fixedPoint.mjs`). The per-format loss lists and the guards
  that keep the catalog in step with core are in `src/test/fidelity/` and run
  with `npm test`.
