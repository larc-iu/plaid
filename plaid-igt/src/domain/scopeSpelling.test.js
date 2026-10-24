import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// A field's scope is Word, Morpheme or Sentence. Nothing writes 'Token', and
// a reader that took it for Word made a layer holding it a word field to the
// grid and the exports and no field at all to the rules, the tagsets and the
// assistant (A9-3). No reader names it.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCANNED = ['plaid-igt/src', 'plaid-umr/src', 'plaid-client-py/src/plaid_client/workflows'];
const TOKEN_SCOPE = /(scope|declared).{0,40}['"][Tt]oken['"]|'Token'.{0,20}'Word'/;

const files = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === '__pycache__') return [];
    if (statSync(path).isDirectory()) return files(path);
    return /\.(js|jsx|py)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });

describe("the 'Token' scope", () => {
  it('is read nowhere', () => {
    const readers = SCANNED.flatMap((dir) => files(join(ROOT, dir)))
      .filter((path) =>
        readFileSync(path, 'utf8')
          .split('\n')
          .some((l) => TOKEN_SCOPE.test(l)),
      )
      .map((path) => relative(ROOT, path));
    expect(readers).toEqual([]);
  });
});
