// Tolerant syntax highlighter for the Grew query box. Returns an HTML string
// (react-simple-code-editor renders it under a transparent textarea). It mirrors
// the token rules of src/grew/lexer.js but never throws on partial/while-typing
// input — anything unrecognized is emitted as plain text.
//
// Colors use Mantine CSS variables so they track the active theme.

const COLORS = {
  keyword: 'var(--mantine-color-blue-7)',
  global: 'var(--mantine-color-grape-6)',
  string: 'var(--mantine-color-teal-7)',
  number: 'var(--mantine-color-orange-7)',
  operator: 'var(--mantine-color-violet-6)',
  punct: 'var(--mantine-color-gray-6)',
  comment: 'var(--mantine-color-gray-5)',
};

// Ordered alternation — longest / most specific first. Group index → class.
const SPEC = [
  ['comment', /%[^\n]*/y],
  ['string', /re"(?:\\.|[^"\\])*"|"(?:\\.|[^"\\])*"/y],
  ['string', /\/(?:\\.|[^/\n\\])*\/[A-Za-z]*/y], // /pcre/flags
  ['keyword', /\b(?:pattern|with|without|global)\b/y],
  ['global', /\bis_[A-Za-z_]+\b/y],
  ['operator', /->>|-\[|->|><|<<|<>|<=|>=|[<>=|^!$*]/y],
  ['number', /-?\d+/y],
  ['plain', /[A-Za-z_][A-Za-z0-9_]*/y], // identifiers (default color)
  ['punct', /[{}[\](),;:.]/y],
  ['plain', /\s+/y],
  ['plain', /[\s\S]/y], // any single leftover char
];

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function highlightGrew(code) {
  let out = '';
  let i = 0;
  while (i < code.length) {
    let matched = false;
    for (const [cls, re] of SPEC) {
      re.lastIndex = i;
      const m = re.exec(code);
      if (!m || m.index !== i) continue;
      const text = escapeHtml(m[0]);
      if (cls === 'plain') {
        out += text;
      } else {
        const weight = cls === 'keyword' ? ';font-weight:600' : '';
        const style = cls === 'comment' ? ';font-style:italic' : '';
        out += `<span style="color:${COLORS[cls]}${weight}${style}">${text}</span>`;
      }
      i += m[0].length;
      matched = true;
      break;
    }
    if (!matched) { out += escapeHtml(code[i]); i += 1; } // safety net
  }
  return out;
}
