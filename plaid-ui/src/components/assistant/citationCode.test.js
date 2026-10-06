import { describe, it, expect } from 'vitest';
import { fencedLines, linkifyCitations } from './citations.js';
import { replyToMarkdown } from './exportMarkdown.js';

// A1-IGT-3: a reference the model wrote in backticks became a Markdown link
// inside a code span, which shows as raw `[label](#/...)` text that wraps over
// six lines and links nowhere. Code stays code.

const adapter = {
  CITE_RE: /(?<![\w{.])s\d+(?:\.w\d+(?:\.m\d+)?)?\b/g,
  citationTitle: (c) => `sentence ${c.n}`,
  citationHref: (_origin, projectId, c) => `#/projects/${projectId}/s${c.n}`,
  citationToMarkdown: (c) => `TABLE ${c.n}`,
};
const byKey = new Map([
  ['s2', { key: 's2', n: 2 }],
  ['s2.w16.m1', { key: 's2.w16.m1', n: 2 }],
]);
const linkify = (text) => linkifyCitations(adapter, text, byKey, { projectId: 'p' });

describe('citations in code', () => {
  it('leaves a reference in a code span as code', () => {
    expect(linkify('`s2.w16.m1` (lam) and s2')).toBe(
      '`s2.w16.m1` (lam) and [sentence 2](#/projects/p/s2)',
    );
    expect(linkify('``s2 `x` s2``, s2')).toBe('``s2 `x` s2``, [sentence 2](#/projects/p/s2)');
  });

  it('leaves a fenced block as it is written', () => {
    const text = ['See s2:', '```', 's2.w16.m1 lam', '```', 'and s2.'].join('\n');
    expect(linkify(text).split('\n')).toEqual([
      'See [sentence 2](#/projects/p/s2):',
      '```',
      's2.w16.m1 lam',
      '```',
      'and [sentence 2](#/projects/p/s2).',
    ]);
  });

  it('reads an unclosed backtick as a backtick', () => {
    expect(linkify('a ` then s2')).toBe('a ` then [sentence 2](#/projects/p/s2)');
  });

  it('knows where a fence ends', () => {
    expect(fencedLines(['a', '~~~', '```', '~~~~', 'b', '```js', 'x', '````', 'c'])).toEqual([
      false,
      true,
      true,
      true,
      false,
      true,
      true,
      true,
      false,
    ]);
    // Backticks after an opening run of backticks make it inline code.
    expect(fencedLines(['```x``` s2', 'b'])).toEqual([false, false]);
  });

  it('exports a reference in a fence or a code span as code', () => {
    const text = ['`s2`', '```', 's2', '```', 's2'].join('\n');
    const md = replyToMarkdown(text, [...byKey.values()], { adapter, projectId: 'p' });
    // The bare line outside the fence is the card, the one inside stays code.
    expect(md.split('\n').slice(0, 5)).toEqual(['`s2`', '```', 's2', '```', 'TABLE 2']);
  });
});
