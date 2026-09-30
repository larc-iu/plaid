// The folder of real sample files (FieldWorks backups, a .flextext, the SIL
// sample projects) that the sample tests and live scripts read. They are too
// large and not ours to check in, so each developer keeps them in
// ~/.plaid_fixtures, or wherever PLAID_FIXTURES points.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const FIXTURES_DIR = process.env.PLAID_FIXTURES ?? join(homedir(), '.plaid_fixtures');

// A path inside the fixtures folder.
export const fixture = (...parts) => join(FIXTURES_DIR, ...parts);

const reported = new Set();

// Whether a sample is there. When it is not, says so once per path, naming the
// variable that points at it, so a skipped suite is never a silent one.
// Straight to stderr: vitest's default reporter drops console output from a
// file whose tests were all skipped. Each test file runs in its own module
// scope, so two files missing the same sample each say so.
export function haveFixture(path, variable = 'PLAID_FIXTURES') {
  if (existsSync(path)) return true;
  if (!reported.has(path)) {
    reported.add(path);
    process.stderr.write(`skipping: ${path} is missing (set ${variable})\n`);
  }
  return false;
}
