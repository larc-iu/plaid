// Every confirm dialog this app opens is titled as a question ("Delete node?",
// "Discard the drafted graph?"), as in every Plaid app. Read from the source,
// so a new call site is held to it without a test of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

const sources = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.(js|jsx)$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : [];
  });

// The `title:` of each `confirm({ ... })`, as source text: from the key to
// the next key of the options object.
const confirmTitles = (text) =>
  [...text.matchAll(/confirm\(\{\s*title:\s*([\s\S]*?),\s*\n\s*\w+:/g)].map((m) => m[1]);

// The string and template literals in a title expression: a ternary has one
// per branch.
const literals = (expr) =>
  [...expr.matchAll(/'([^']*)'|`([^`]*)`|"([^"]*)"/g)].map((m) => m[1] ?? m[2] ?? m[3]);

test('every confirm dialog title is a question', () => {
  const found = [];
  sources(SRC).forEach((file) => {
    confirmTitles(fs.readFileSync(file, 'utf8')).forEach((expr) => {
      const texts = literals(expr);
      assert.ok(texts.length, `${path.relative(SRC, file)}: a title with no literal: ${expr}`);
      texts.forEach((t) => found.push([path.relative(SRC, file), t]));
    });
  });
  assert.ok(found.length >= 3, 'the scan finds the canvas dialogs');
  found.forEach(([file, t]) => assert.ok(t.trim().endsWith('?'), `${file}: "${t}"`));
});
