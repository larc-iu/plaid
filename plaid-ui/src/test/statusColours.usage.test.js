import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { APPS, repoRoot } from './apps.js';

// The success and warning hues (index.css) are for a tint, a border or an
// icon. As the colour of words they read at 3.7:1 and 2.1:1 on a card, under
// the 4.5:1 that text needs, so words take `text-success-foreground` or
// `text-warning-foreground`. A bare `text-success` is allowed only on a line
// that draws an icon.

const repo = repoRoot();
const ROOTS = ['plaid-ui/src', ...APPS.map((a) => `${a.dir}/src`)];
const BARE = /\btext-(success|warning)(?![-\w])/;
const ICON = /<[A-Z][A-Za-z]*(Icon)?\b[^>]*className=|iconClass|<Check|<AlertTriangle|<Circle/;

const sources = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(full);
    return /\.(jsx?|ts)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [full] : [];
  });

describe('success and warning colours', () => {
  it('colour icons and tints only, never words', () => {
    const found = [];
    for (const root of ROOTS) {
      for (const file of sources(path.join(repo, root))) {
        fs.readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (BARE.test(line) && !ICON.test(line)) {
              found.push(`${path.relative(repo, file)}:${i + 1}: ${line.trim()}`);
            }
          });
      }
    }
    expect(found).toEqual([]);
  });
});
