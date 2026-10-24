// A write whose outcome is unknown is no answer (status 0) or a proxy's 502 or
// 504 (conc D1). One predicate says so, isUnknownOutcome in plaid-client-js
// and plaid-ui's errors.js: an app that tests `status === 0` itself misses the
// other two and tells the person a stored write did not land (R4-3-3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = normalize(join(dirname(fileURLToPath(import.meta.url)), '../..'));

const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === 'node_modules' ? [] : walk(p);
    return /\.(js|jsx)$/.test(f) && !/\.test\.jsx?$/.test(f) ? [p] : [];
  });

test('no app source tests for status 0 by hand', () => {
  const found = [];
  for (const app of ['plaid-ud', 'plaid-umr', 'plaid-igt', 'plaid-dict', 'plaid-ui']) {
    for (const file of walk(join(REPO, app, 'src'))) {
      const rel = file.slice(REPO.length + 1);
      if (rel === 'plaid-ui/src/lib/errors.js') continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/status\)? ?(===|==) ?0\b/.test(line)) found.push(`${rel}:${i + 1}`);
        });
    }
  }
  assert.deepEqual(found, []);
});
