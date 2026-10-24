// A literal goes into a server (Java) regex through one escaper,
// src/grew/literals.js literalRegex (A6-3). A second copy drifts: an edge
// case fixed in one is missed in the other. Any other `'\\$&'` replacement
// under src/ is such a copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const ALLOWED = new Set(['grew/literals.js']);

const files = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(js|jsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });

test('no regex escaper beside literals.js', () => {
  const copies = files(SRC)
    .filter((path) => !ALLOWED.has(relative(SRC, path)))
    .filter((path) => readFileSync(path, 'utf8').includes("'\\\\$&'"));
  assert.deepEqual(
    copies.map((path) => relative(SRC, path)),
    [],
  );
});
