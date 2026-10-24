import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { scratchRepo } from './repoGates.js';

// A gate's self-test plants its lines in a scratch repo under the temp dir.
// The repo goes when the test ends, so no run leaves plaid-gate-* behind.
describe('scratchRepo', () => {
  let made;
  it('makes a repo holding the files', () => {
    made = scratchRepo({ 'a/b.js': 'x\n' });
    expect(fs.readFileSync(`${made}/a/b.js`, 'utf8')).toBe('x\n');
  });

  it('removes it when the test that made it ends', () => {
    expect(fs.existsSync(made)).toBe(false);
  });
});
