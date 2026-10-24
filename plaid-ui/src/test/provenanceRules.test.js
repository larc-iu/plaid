import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { appTrees, repoRoot } from './apps.js';

// The provenance convention's rules live in plaid-client's provenance.js, and
// the apps read them from there (beta review A7-1, A7-4, A7-8). Each pattern
// below is a copy that drifted once:
//
//  - a key told from provenance by the prefix `prov`, which hid a lexicon
//    field of the user's own named "provenance" or "proverb";
//  - a value edit dropping provProb by hand, written three ways in three apps
//    and missed in two edit paths (writer.valueEditStamp is the one rule);
//  - the five keys listed by hand, which a sixth key would slip past
//    (PROVENANCE_KEYS).
//
// Tests are exempt, and so is anything under a src/test directory: they
// state what the rules produce. Comments are exempt.

const PATTERNS = [
  [/startsWith\(\s*['"]prov['"]\s*\)/, 'a prov prefix test: use PROVENANCE_KEYS'],
  [
    /\bprovProb\s*:\s*null|probKey\]\s*:\s*null/,
    'a hand-written provProb drop: use writer.valueEditStamp',
  ],
  [
    /['"]provProb['"]\s*,|PROV\.confirmedKey,\s*PROV\.probKey/,
    'a hand list of the keys: use PROVENANCE_KEYS',
  ],
];

const isComment = (line) => /^\s*(\/\/|\/?\*)/.test(line);

const sources = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'test' || e.name === 'node_modules' ? [] : sources(full);
    return e.isFile() && /\.jsx?$/.test(e.name) && !/\.test\.jsx?$/.test(e.name) ? [full] : [];
  });

describe('the provenance rules have one home', () => {
  it('no app or plaid-ui source restates them', () => {
    const repo = repoRoot();
    const found = [];
    for (const tree of [...appTrees('src'), 'plaid-ui/src']) {
      for (const file of sources(path.join(repo, tree))) {
        fs.readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (isComment(line)) return;
            for (const [pattern, why] of PATTERNS) {
              if (pattern.test(line)) found.push(`${path.relative(repo, file)}:${i + 1}: ${why}`);
            }
          });
      }
    }
    expect(found).toEqual([]);
  });
});
