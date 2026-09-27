// The copy formats keep every value inside its own cell and line, whatever
// characters it holds: a `//` ends an ExPex line, a tab or newline splits a
// Leipzig word or breaks the plain-text columns, and a blank line ends a TeX
// paragraph inside a macro argument.
import { describe, expect, it } from 'vitest';
import { formatExpex, formatGb4e, formatLeipzig, formatPlain } from './igtExport.js';

const F = { morphFields: ['Gloss'], wordFields: [], sentFields: ['Translation'] };
const sentence = (words, translation = '') => ({
  annotations: translation ? { Translation: { value: translation } } : {},
  tokens: words.map(([form, gloss]) => ({
    content: form,
    annotations: {},
    morphemes: [{ metadata: { form }, annotations: { Gloss: { value: gloss } } }],
  })),
});

describe('ExPex', () => {
  it('braces a cell holding // so the line does not end inside it', () => {
    const out = formatExpex(
      sentence([
        ['http://x.org', 'PST//FUT'],
        ['two', 'two'],
      ]),
      F,
    );
    expect(out).toContain('\\gla {http://x.org} two //');
    expect(out).toContain('\\glb {\\textsc{pst}//\\textsc{fut}} two //');
  });

  it('braces the free translation so a // inside it does not end the line', () => {
    const out = formatExpex(sentence([['a', 'a']], 'See http://example.org/a now'), F);
    expect(out).toContain("\\glft {`See http://example.org/a now'} //");
  });

  // ExPex stops with "Extra \else", or misaligns the example, on a \gla word
  // that is one escaped special alone (compiled with ExPex 5.1b from CTAN).
  // An empty group in front, which prints nothing, keeps it an ordinary word.
  it('opens a cell that starts with a LaTeX special with an empty group', () => {
    const out = formatExpex(
      sentence([
        ['{', '}'],
        ['_', 'x{y}'],
        ['~a', '$'],
        ['\\', 'a\\'],
      ]),
      F,
    );
    expect(out).toContain('\\gla {}\\{ {}\\_ {}\\textasciitilde{}a {}\\textbackslash{} //');
    expect(out).toContain('\\glb {}\\} x\\{y\\} {}\\$ a\\textbackslash{} //');
  });

  it('keeps a translation with a blank line in one paragraph', () => {
    expect(formatExpex(sentence([['a', 'a']], 'one\n\ntwo'), F)).toContain("\\glft {`one two'} //");
    expect(formatGb4e(sentence([['a', 'a']], 'one\n\ntwo'), F)).toContain("\\glt `one two'");
  });
});

describe('Leipzig and plain text', () => {
  const s = sentence([
    ['a\tb', 'x\ny'],
    ['c', 'z'],
  ]);

  it('keeps a cell holding a tab or newline as one Leipzig word', () => {
    const out = formatLeipzig(s, F);
    expect(out).toContain('<p>a b c</p>');
    expect(out).toContain('<p>x y z</p>');
  });

  it('keeps the plain-text columns on their lines', () => {
    expect(formatPlain(s, F).split('\n')).toEqual(['a b  c', 'x y  z']);
  });
});
