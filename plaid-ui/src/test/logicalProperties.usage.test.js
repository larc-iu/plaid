import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { APPS, repoRoot } from './apps.js';

// The rule that keeps both grids working in Arabic, checked against the source.
//
// An interlinear block and a dependency grid are MIRRORED: one `dir` on the
// sentence container flips the column order, the label column and the
// morpheme chains together. That works only while every rule inside those
// blocks positions itself along the INLINE axis rather than the left-right one.
// A single `border-left` in there is a bug that renders perfectly in English
// and puts a column rule on the wrong side of every Arabic word.
//
// A static read is a crude tool and the right one here: the property is "this
// stylesheet does not say `left`", which a reader of the source can see and no
// renderer can, because happy-dom and jsdom lay nothing out and the bug only
// exists once a browser does.

const repo = repoRoot();

// The blocks that flip, by the class prefixes their rules are written under.
// Anything else in these stylesheets is chrome (the toolbar, the pager, the
// legend, the row menu, the lexicon popover) and reads one way whatever the
// grid is doing, so it keeps its physical properties.
const MIRRORED = [
  {
    file: 'plaid-igt/src/components/documents/analyze/island/igt-editor.css',
    // `.igt-vocab-pop` is deliberately absent: the lexicon popover is a panel
    // and carries `dir="ltr"` of its own.
    prefixes: [
      '.igt-sentence',
      '.igt-labels',
      '.igt-row-label',
      '.igt-tokens',
      '.igt-token-col',
      '.igt-token-form',
      '.igt-gap-col',
      '.igt-cell',
      '.igt-field',
      '.igt-morph',
      '.igt-mwe',
      '.igt-cmt-badge',
      // The sentence's tools and the chip under each word sit inside the
      // mirrored block. The tool row carries dir="ltr", and its insets are
      // logical all the same, so the rule reads the same in either.
      '.igt-copy',
      '.igt-ask',
      '.igt-vocab__',
    ],
  },
  {
    // plaid-igt's Tokenize tab. Each sentence row carries the document's
    // direction. `.sentence-row` itself is absent: its margin cancels the
    // container's padding, which sits outside the row and does not mirror.
    file: 'plaid-igt/src/components/documents/tokenize/DocumentTokenize.css',
    prefixes: [
      '.sentence-content',
      '.sentence-number',
      '.merge-',
      '.token',
      '.untokenized',
      '.splitter-',
    ],
  },
  {
    // plaid-umr's canvas. Only the WORD ROW mirrors: the graph above it is
    // placed at measured pixel offsets from the stage's left edge, and the
    // stage says `direction: ltr` so that axis and the constants lane drawn
    // along it stay put. What flips is the row of words, its gloss lines and
    // the names of those lines in the margin, which is where a physical
    // inset would land on the wrong side.
    file: 'plaid-umr/src/components/editor/annotation/canvas.css',
    prefixes: ['.umr-tokens', '.umr-word', '.umr-legend', '.umr-ilg-', '.umr-morph'],
  },
  {
    file: 'plaid-ud/src/components/editor/annotation/SentenceRow.css',
    prefixes: [
      '.sentence-',
      '.labels-column',
      '.token-column',
      '.token-form',
      '.row-label',
      '.annotation-cell',
      '.features-cell',
      '.feature-',
      '.editable-field',
    ],
  },
];

// Properties with a logical twin. `background-position` is not among them: it
// has none, and the one rule that needs it says itself twice under `:dir()`.
const PHYSICAL =
  /(^|[\s;{])((margin|padding|border)-(left|right)\b|border-(top|bottom)-(left|right)-radius\b|(left|right)\s*:|text-align\s*:\s*(left|right)\b)/;

// A shorthand is physical too when its left and right differ: four-value
// `margin: 0 4px 0 2px`, or `border-radius: 6px 0 0 6px`, whose corners are
// named top-left first whatever the direction.
const lopsidedShorthand = (decl) => {
  const m = /^(margin|padding|border-width|border-radius)\s*:\s*(.+)$/.exec(decl);
  if (!m) return false;
  const values = m[2].split('/')[0].trim().split(/\s+/);
  if (m[1] === 'border-radius') return new Set(values).size > 1;
  return values.length === 4 && values[1] !== values[3];
};
const physical = (decl) => PHYSICAL.test(`;${decl};`) || lopsidedShorthand(decl);

// Rules as (selector, body) pairs. Crude, and enough: these two files are
// plain CSS with no nesting and no at-rule bodies holding declarations
// directly, and a false positive here is a rule someone has to look at anyway.
const rules = (css) => {
  const out = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    out.push({ selector: m[1].trim(), body: m[2] });
  }
  return out;
};

describe('the mirrored blocks use logical properties', () => {
  it('names a grid in every app', () => {
    // Each live app draws one of these grids, and plaid-umr's canvas was
    // outside this check for the two weeks it took to notice. An app with no
    // entry here is an app whose grid nobody is holding to the rule.
    const covered = APPS.filter(({ dir }) => MIRRORED.some((m) => m.file.startsWith(`${dir}/`)));
    expect(covered.map((a) => a.tag)).toEqual(APPS.map((a) => a.tag));
  });

  for (const { file, prefixes } of MIRRORED) {
    const css = fs.readFileSync(path.join(repo, file), 'utf8');
    const parsed = rules(css);
    const mirrored = parsed.filter((r) =>
      r.selector.split(',').some((sel) => prefixes.some((p) => sel.trim().startsWith(p))),
    );

    it(`${file} still has rules under every prefix named here`, () => {
      // A renamed class would otherwise take its rules out of the check in
      // silence, which is the one way this test can stop meaning anything.
      const unmatched = prefixes.filter(
        (p) => !parsed.some((r) => r.selector.split(',').some((sel) => sel.trim().startsWith(p))),
      );
      expect(unmatched).toEqual([]);
    });

    it(`${file} says inline-start, never left`, () => {
      const findings = mirrored
        .flatMap((r) =>
          r.body
            .split(';')
            .map((d) => d.trim())
            .filter((d) => d && physical(d))
            .map((d) => `${r.selector} { ${d} }`),
        )
        .sort();
      expect(findings).toEqual([]);
    });
  }
});
