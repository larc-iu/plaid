import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// The fidelity runs (`bb fidelity`) drive runExport from plain node, where
// plaid-ui's files resolve their packages from plaid-ui and the repository
// root, not from this app. A static import of an app-only package anywhere
// under runExport stops every one of those runs before it starts.
const IGT = resolve(import.meta.dirname, '../..');

describe('runExport in plain node', () => {
  it('loads with the aliases the fidelity runs use', () => {
    const out = execFileSync(
      process.execPath,
      [
        '--import',
        './e2e/live/aliases.mjs',
        '--input-type=module',
        '-e',
        "const m = await import('./src/export/runExport.js'); console.log(typeof m.runExport);",
      ],
      { cwd: IGT, encoding: 'utf8' },
    );
    expect(out.trim()).toBe('function');
  });
});
