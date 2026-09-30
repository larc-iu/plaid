// The folder of real sample files the live scripts read, kept out of the
// repository: ~/.plaid-fixtures, or wherever PLAID_FIXTURES points.
import { homedir } from 'node:os';
import { join } from 'node:path';

export const FIXTURES_DIR = process.env.PLAID_FIXTURES ?? join(homedir(), '.plaid-fixtures');

// A path inside the fixtures folder.
export const fixture = (...parts) => join(FIXTURES_DIR, ...parts);
