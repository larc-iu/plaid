import { describe, it, expect } from 'vitest';
import { gitGrep, scratchRepo } from './src/test/repoGates.js';
import { repoRoot } from './src/test/apps.js';

// The Enter that confirms an input method's candidate (typing Chinese or
// Japanese) is the input method's, never the Enter that sends or commits
// what was typed. Every Enter is read by plaid-ui's `isEnter`
// (src/lib/chords.js), with no exceptions: no other source file of plaid-ui
// or plaid-igt compares a key to 'Enter' itself.

const PATHSPECS = [
  'plaid-ui/src/**',
  'plaid-igt/src/**',
  ':!*.test.*',
  ':!**/src/test/**',
  ':!plaid-ui/src/lib/chords.js',
];

const BY_HAND = [
  `(===|!==|==|!=)\\s*['"]Enter['"]`,
  `['"]Enter['"]\\s*(===|!==|==|!=)`,
  `case\\s+['"]Enter['"]`,
];

const offenders = (root) =>
  gitGrep(root, BY_HAND, PATHSPECS).map(
    ({ file, line, text }) => `${file}:${line}: ${text.trim()}`,
  );

describe('Enter is read only by isEnter', () => {
  it('holds over plaid-ui and plaid-igt', () => {
    const found = offenders(repoRoot());
    expect(
      found,
      `Read Enter with isEnter(e) from plaid-ui/src/lib/chords.js:\n  ${found.join('\n  ')}`,
    ).toEqual([]);
  });

  it('finds every way of comparing a key to Enter', () => {
    const root = scratchRepo({
      'plaid-ui/src/a.jsx': "onKeyDown={(e) => e.key === 'Enter' && send()}\n",
      'plaid-igt/src/b.js': "if (event.key !== 'Enter') return;\n",
      'plaid-igt/src/c.js': "if ('Enter' === e.key) go();\n",
      'plaid-igt/src/d.js': 'if (e.code === "Enter") go();\n',
      'plaid-igt/src/e.js': "switch (e.key) {\n  case 'Enter':\n    go();\n}\n",
      'plaid-igt/src/clean.js': 'if (isEnter(e)) send();\n',
      'plaid-ui/src/lib/chords.js': "export const isEnter = (e) => e?.key === 'Enter';\n",
    });
    expect(offenders(root).map((f) => f.split(': ')[0])).toEqual([
      'plaid-igt/src/b.js:1',
      'plaid-igt/src/c.js:1',
      'plaid-igt/src/d.js:1',
      'plaid-igt/src/e.js:2',
      'plaid-ui/src/a.jsx:1',
    ]);
  });
});
