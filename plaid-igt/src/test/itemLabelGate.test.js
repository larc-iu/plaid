import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// An entry's name as text ("kwatha 1.2") is written by itemLabel in
// domain/vocabDictionary.js and nowhere else, so a change to how a numbered
// entry is written lands everywhere at once (beta review R4-5-5). The app's
// code only: src/test holds oracles that work the answer out on their own.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = path.join(SRC, 'domain', 'vocabDictionary.js');
const TESTS = path.join(SRC, 'test');

const sources = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return full === TESTS || e.name === 'node_modules' ? [] : sources(full);
    return e.isFile() && /\.jsx?$/.test(e.name) && !/\.test\.jsx?$/.test(e.name) ? [full] : [];
  });

// `${x.form} ${n}`, a form and a number joined by hand.
const BY_HAND = /`\$\{[\w.?]*\bform\} \$\{/;

describe('entry names', () => {
  it('are joined from form and number only by itemLabel', () => {
    const found = sources(SRC)
      .filter((f) => f !== OWNER)
      .flatMap((f) =>
        fs
          .readFileSync(f, 'utf8')
          .split('\n')
          .flatMap((line, i) => (BY_HAND.test(line) ? [`${path.relative(SRC, f)}:${i + 1}`] : [])),
      );
    expect(found).toEqual([]);
  });
});
