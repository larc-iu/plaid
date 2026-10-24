import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// A reader takes the one spelling of a key its path gets (A8-1). The JS
// client camelCases every answer but a refusal's raw body and the opaque
// buckets, so a fallback from `wordsWritten` to `words_written`, or from
// `violationCount` to `['violation-count']`, never runs, and it would hide a
// path that skips the transform. These two shapes find such a fallback.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCANNED = [
  'plaid-ui/src',
  'plaid-igt/src',
  'plaid-ud/src',
  'plaid-umr/src',
  'plaid-dict/src',
  'plaid-client-js/src',
];
const FALLBACKS = [
  /\.([a-z]+)([A-Z][a-z]+)\w*\s*(\?\?|\|\|)\s*\S*\.\1_/,
  /\.([a-z]+)([A-Z][a-z]+)\w*\s*(\?\?|\|\|)\s*\S*\[['"]\1-/,
];

const files = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules') return [];
    if (statSync(path).isDirectory()) return files(path);
    return /\.(js|jsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });

describe('a key read under one spelling', () => {
  it('has no fallback to another casing of it', () => {
    const found = SCANNED.flatMap((dir) => files(join(ROOT, dir))).flatMap((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .map((line, i) => [line, i])
        .filter(([line]) => FALLBACKS.some((re) => re.test(line)))
        .map(([, i]) => `${relative(ROOT, path)}:${i + 1}`),
    );
    expect(found).toEqual([]);
  });
});
