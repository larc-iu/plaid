import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Unknown progress is null, never 0, and a new step starts with its fraction
// unknown (memory plaid_igt_service_run_idiom). A bar at 0% while the first
// answer is awaited reads as hung (beta review R4-5-7). Read off the source
// of igt and plaid-ui.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOTS = [path.resolve(HERE, '..'), path.resolve(HERE, '../../../plaid-ui/src')];

const sources = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sources(full);
    return e.isFile() && /\.jsx?$/.test(e.name) && !/\.test\.jsx?$/.test(e.name) ? [full] : [];
  });

describe('progress', () => {
  it('never starts a step at a literal 0', () => {
    const found = ROOTS.flatMap(sources).flatMap((f) =>
      fs
        .readFileSync(f, 'utf8')
        .split('\n')
        .flatMap((line, i) => (/\bpercent: 0(?![\d.])/.test(line) ? [`${f}:${i + 1}`] : [])),
    );
    expect(found).toEqual([]);
  });
});
