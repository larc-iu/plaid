# e2e

Everything here runs against the LIVE dev core (`:8085`) and dev server (`:5174`),
as the admin `a@b.com` whose non-expiring token is in `../.token`. Run from
`plaid-igt/` with Node 24 (`nvm use 24.1.0`).

- `*.spec.js`: the Playwright suite, `npm run test:e2e`. Specs share the
  "E2E IGT Fixture" project that `node e2e/fixtureProject.js` creates or finds.
- `fixtures.js`: the Playwright helpers (`test`, `expect`, `seedAuth`, `readToken`).
  `fixtureProject.js`: the fixture project builder.
- `live/`: engine-level checks that drive the importers, exporters, services,
  and the domain model through node with no browser, each with a usage line at
  the top. They are run by hand when the code they cover changes.
- `scripts/`: seeders, demos, screenshots, and one-off data fixes. `uxseed.mjs`
  and `uxshot.mjs` seed and screenshot the grid headlessly.
- `bugbash/`: the headless integrity fuzzer and its harness (`harness.mjs` is
  also the client and fixture lookup the live scripts use).
