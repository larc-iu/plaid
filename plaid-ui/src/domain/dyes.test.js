import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DYES, CATEGORICAL } from './dyes.js';
import { gitGrep } from '../test/repoGates.js';
import { appTrees, repoRoot } from '../test/apps.js';

// The dyes have one home, DYES. CSS reads the copy in plaid-ui's index.css and
// Tailwind the preset's, and every other surface names a dye rather than
// restating its value, so a palette change moves every surface together.

const repo = repoRoot();
const HOMES = ['plaid-ui/src/domain/dyes.js', 'plaid-ui/src/index.css'];

describe('the dyes', () => {
  it('are the categorical palette, in its order', () => {
    expect(CATEGORICAL).toEqual(Object.values(DYES));
  });

  it("index.css names each dye with DYES' value", () => {
    const css = fs.readFileSync(path.join(repo, 'plaid-ui/src/index.css'), 'utf8');
    const stated = Object.fromEntries(
      [...css.matchAll(/--plaid-dye-([a-z]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1], m[2]]),
    );
    expect(stated).toEqual({ ...DYES });
  });

  it('are written as values nowhere else', () => {
    const hexes = Object.values(DYES).map((hex) => hex.slice(1));
    const hits = gitGrep(
      repo,
      [`(?i)#(${hexes.join('|')})\\b`],
      ['plaid-ui', ...appTrees('src'), 'plaid-dict/src', ...HOMES.map((h) => `:!${h}`)],
    );
    expect(hits.map((h) => `${h.file}:${h.line}`)).toEqual([]);
  });
});
