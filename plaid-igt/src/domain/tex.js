// THE TeX escaper. Every string of data that goes into LaTeX source (the copy
// formats in igtExport.js, the book export in export/latexBook.js) comes
// through here, so there is one set of rules to get right.
//
// The ten characters below are the ones LaTeX reads as syntax in running
// text. Everything else, every letter of every script included, is written as
// itself: the book compiles with LuaLaTeX and fontspec, which read UTF-8.

const LATEX_SPECIALS = {
  '\\': '\\textbackslash{}',
  '&': '\\&',
  '%': '\\%',
  $: '\\$',
  '#': '\\#',
  _: '\\_',
  '{': '\\{',
  '}': '\\}',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
};

/** Whether `ch` (one character) is one LaTeX reads as syntax. */
export const isTexSpecial = (ch) => Object.prototype.hasOwnProperty.call(LATEX_SPECIALS, ch);

// Control characters have no glyph, and a few of them (NUL, the form feed,
// DEL) stop a TeX run or print as ^^ codes. Tab and the line breaks are left
// for texLine, which makes them spaces.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g;

/** `s` as LaTeX text that prints as `s`. */
export const texEscape = (s) =>
  [...String(s ?? '').replace(CONTROL_RE, '')]
    .map((ch) => (isTexSpecial(ch) ? LATEX_SPECIALS[ch] : ch))
    .join('');

/**
 * `s` on one line with single spaces. A macro argument cannot hold a
 * paragraph break, and a blank line inside a gloss line would end it, so a
 * value set in one gets this before texEscape.
 */
export const texLine = (s) =>
  String(s ?? '')
    .replace(/[\s\u0085\u2028\u2029]+/gu, ' ')
    .trim();
