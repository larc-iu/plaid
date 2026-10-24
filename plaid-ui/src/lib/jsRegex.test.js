import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeJsRegex } from './jsRegex.js';

describe('escapeJsRegex', () => {
  it('makes a pattern that matches the text itself', () => {
    const text = 'a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o';
    expect(new RegExp(`^${escapeJsRegex(text)}$`).test(text)).toBe(true);
    expect(new RegExp(escapeJsRegex('a.b')).test('axb')).toBe(false);
  });
});

// One escaper per language: a second copy of this one-liner in the apps that
// share plaid-ui drifts from it. The Markdown escaper replaces with the same
// `'\\$&'` and is the one Markdown escaper.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCANNED = ['plaid-ui/src', 'plaid-igt/src', 'plaid-umr/src'];
const ALLOWED = new Set([
  'plaid-ui/src/lib/jsRegex.js',
  'plaid-ui/src/components/assistant/citations.js',
]);

const files = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules') return [];
    if (statSync(path).isDirectory()) return files(path);
    return /\.(js|jsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });

describe('one JavaScript regex escaper', () => {
  it('has no copy beside jsRegex.js', () => {
    const copies = SCANNED.flatMap((dir) => files(join(ROOT, dir)))
      .map((path) => relative(ROOT, path))
      .filter((path) => !ALLOWED.has(path))
      .filter((path) => readFileSync(join(ROOT, path), 'utf8').includes("'\\\\$&'"));
    expect(copies).toEqual([]);
  });
});
