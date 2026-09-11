// Tolerant syntax highlighter for the Grew query box. Returns an HTML string
// (CodeEditor paints it into a <pre> under a transparent textarea). It mirrors
// the token rules of src/grew/lexer.js but never throws on partial/while-typing
// input — anything unrecognized is emitted as plain text.
//
// The colors are named once in src/index.css, as the `--grew-*` variables, so
// the palette is in one place and the highlighter stays a pure string function.

const COLORS = {
  keyword: 'var(--grew-keyword)',
  global: 'var(--grew-global)',
  string: 'var(--grew-string)',
  number: 'var(--grew-number)',
  operator: 'var(--grew-operator)',
  punct: 'var(--grew-punct)',
  comment: 'var(--grew-comment)',
};

// Ordered alternation — longest / most specific first. Group index → class.
const SPEC = [
  ['comment', /%[^\n]*/y],
  ['string', /re"(?:\\.|[^"\\])*"|"(?:\\.|[^"\\])*"/y],
  ['string', /\/(?:\\.|[^/\n\\])*\/[A-Za-z]*/y], // /pcre/flags
  [
    'keyword',
    /#BEGIN\b|#END\b|\b(?:pattern|with|without|global|rule|commands|strat|del_edge|add_edge|del_node|add_node|shift_in|shift_out|shift|del_feat|append_feats|prepend_feats)\b/y,
  ],
  ['global', /\bis_[A-Za-z_]+\b|\b(?:Onf|Iter|Seq|Alt|Pick|Try|Empty)\b/y],
  ['operator', /->>|-\[|->|><|<<|>>|<>|<=|>=|==>|=\[|\]=>|:<|:>|[<>=|^!$*+]/y],
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
    if (!matched) {
      out += escapeHtml(code[i]);
      i += 1;
    } // safety net
  }
  return out;
}
