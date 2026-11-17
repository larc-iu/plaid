import { describe, it, expect } from 'vitest';
import { gitGrep, isComment, scratchRepo, unmarked } from './src/test/repoGates.js';
import { repoRoot } from './src/test/apps.js';

// The Enter that confirms an input method's candidate (typing Chinese or
// Japanese) is the input method's, never the Enter that sends or commits
// what was typed. One rule in one helper, plaid-ui's `isEnter` (or an early
// return on `isImeKey` for every key a handler reads). A handler that reads
// Enter by hand says why it may: its element takes no typed text, or a guard
// before it already returned on `isImeKey`.

const PATHSPECS = [
  'plaid-ui/src/**',
  'plaid-igt/src/**',
  ':!*.test.*',
  ':!**/src/test/**',
  ':!plaid-ui/src/lib/chords.js',
];

const ENTER_BY_HAND = `\\.key\\s*(===|!==)\\s*['"]Enter['"]`;

const offenders = (root) =>
  unmarked(
    root,
    gitGrep(root, [ENTER_BY_HAND], PATHSPECS).filter(({ text }) => !isComment(text)),
    'enter-ok',
  );

const failure = (found) =>
  `Enter read by hand, which also takes the Enter of an input-method composition:\n  ${found.join('\n  ')}\n` +
  'Ask `isEnter(e)` from plaid-ui/src/lib/chords.js. If the element takes no typed text, or a guard ' +
  'above returns on `isImeKey`, say so on the line or the line above: `// enter-ok: <reason>`.';

describe('no Enter read past an input-method composition', () => {
  it('holds over plaid-ui and plaid-igt', () => {
    const found = offenders(repoRoot());
    expect(found, failure(found)).toEqual([]);
  });

  it('finds an Enter read by hand and lets a marked or helper line through', () => {
    const root = scratchRepo({
      'plaid-ui/src/bad.jsx': "onKeyDown={(e) => e.key === 'Enter' && send()}\n",
      'plaid-igt/src/bad.js': "if (event.key !== 'Enter') return;\n",
      'plaid-igt/src/clean.js': [
        'if (isEnter(e)) send();',
        '// enter-ok: a button, it takes no typed text',
        "if (e.key === 'Enter' || e.key === ' ') open();",
        '',
      ].join('\n'),
    });
    expect(offenders(root).map((f) => f.split(': ')[0])).toEqual([
      'plaid-igt/src/bad.js:1',
      'plaid-ui/src/bad.jsx:1',
    ]);
  });
});
