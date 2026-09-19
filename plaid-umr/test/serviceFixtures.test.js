// The AnCast service's writer is judged (in services/tests) against two
// fixtures the app's own importer and exporter produce. This keeps those
// fixtures current: a change to what the exporter writes fails here, with
// the command that regenerates them, instead of leaving the Python oracle
// judging against yesterday's output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildFixtures, FIXTURE_PATHS } from '../services/tests/make_umr_raw_fixture.mjs';

test('the service fixtures are what the app writes today', () => {
  const { raw, expected } = buildFixtures();
  const hint = 'Regenerate with: node services/tests/make_umr_raw_fixture.mjs';
  assert.equal(fs.readFileSync(FIXTURE_PATHS.expected, 'utf8'), expected, hint);
  assert.equal(fs.readFileSync(FIXTURE_PATHS.raw, 'utf8'), raw, hint);
});
