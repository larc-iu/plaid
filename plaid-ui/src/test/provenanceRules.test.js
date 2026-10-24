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
// The keys themselves are written only in plaid-client: an app names one as
// PROV.key, PROV.sourceKey and the rest, so a key name in quotes is one of the
// rules above restated (beta review REV-PROV-4).
//
// Tests are exempt, and so is anything under a src/test directory: they
// state what the rules produce. Comments are exempt, a trailing one too.

const KEY_LITERAL = /['"`](prov|provSource|provConfirmed|provDetail|provProb)['"`]/;

const PATTERNS = [
  [KEY_LITERAL, 'a provenance key in quotes: use PROV and PROVENANCE_KEYS'],
  [
    /(startsWith|indexOf)\(\s*PROV\.key\s*\)|\/\^prov|['"`]\^prov/,
    'a prov prefix test: use PROVENANCE_KEYS',
  ],
  [
    /(^|[{,])\s*provProb\s*:\s*(null|undefined)\b|probKey\]\s*:\s*(null|undefined)\b|\bdelete\s+[\w$.?[\]]*(\.provProb\b|\[\s*PROV\.probKey\s*\])|path\s*:\s*\[\s*PROV\.probKey\s*\]/,
    'a hand-written provProb drop: use writer.valueEditStamp',
  ],
  // The same drop as an assignment, and as a destructure that keeps the rest.
  [
    /\[\s*PROV\.probKey\s*\]\s*=(?!=)|\.provProb\s*=(?!=)|\{[^}]*(\bprovProb\b|\[\s*PROV\.probKey\s*\])[^}]*\.\.\.[\w$]+\s*\}\s*=(?!=)/,
    'a hand-written provProb drop: use writer.valueEditStamp',
  ],
  [/\bPROV\.\w*[kK]ey\s*,\s*PROV\.\w*[kK]ey\b/, 'a hand list of the keys: use PROVENANCE_KEYS'],
];

const isComment = (line) => /^\s*(\/\/|\/?\*)/.test(line);

// The line without a trailing comment. A `//` counts as one only after
// whitespace, so the `//` of a URL in a string stays code.
const codeOf = (line) => line.replace(/(^|\s)\/\/.*$/, '');

// The rules a source line breaks, each as its reason.
const broken = (line) =>
  isComment(line) ? [] : PATTERNS.filter(([p]) => p.test(codeOf(line))).map(([, why]) => why);

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
            for (const why of broken(line))
              found.push(`${path.relative(repo, file)}:${i + 1}: ${why}`);
          });
      }
    }
    expect(found).toEqual([]);
  });

  // The shapes the gate exists for, each written once in some app before.
  it.each([
    'const m = { provProb: null };',
    "const m = { 'provProb': null };",
    '  provProb: null,',
    'const m = { ...s, [PROV.probKey]: undefined };',
    "ops.push({ op: 'delete', path: ['provProb'] });",
    'ops.push({ op: OP, path: [PROV.probKey] });',
    'delete m.provProb;',
    'delete m[PROV.probKey];',
    "const own = keys.filter((k) => !k.startsWith('prov'));",
    'const own = keys.filter((k) => !k.startsWith(PROV.key));',
    'const own = keys.filter((k) => !/^prov/.test(k));',
    "const own = keys.filter((k) => k.slice(0, 4) !== 'prov');",
    "const KEYS = ['prov', 'provSource', 'provConfirmed', 'provDetail', 'provProb'];",
    'const KEYS = [PROV.key, PROV.sourceKey, PROV.confirmedKey, PROV.detailKey];',
    'm[PROV.probKey] = null;',
    'm.provProb = null;',
    'm.provProb = undefined;',
    'const { provProb, ...rest } = m;',
    'const { [PROV.probKey]: _drop, ...rest } = m;',
    'const own = keys.filter((k) => k.indexOf(PROV.key) !== 0);',
  ])('flags %s', (line) => {
    expect(broken(line)).not.toEqual([]);
  });

  it.each([
    'const p = ok ? provProb : null;',
    'const p = ok\n  ? provProb\n  : null;',
    'save(m); // provProb: null was written here once',
    '// { provProb: null }',
    'const detail = metadata?.[PROV.detailKey];',
    'const fragment = { ...stamp, [PROV.detailKey]: { ...stamp[PROV.detailKey], ...detail } };',
    "const url = 'https://example.org/prov';",
    "const label = 'provenance';",
    'const same = m.provProb === p;',
    'const { provProb } = m;',
  ])('passes %s', (line) => {
    for (const part of line.split('\n')) expect(broken(part)).toEqual([]);
  });
});
