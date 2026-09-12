import { lex, TT } from '../../grew/lexer.js';
import { BARE_KEY, exactRegex, quote } from '../../grew/literals.js';

// Narrowing a search to one value from the count table.
//
// A count row names a value of one node's field, and clicking it filters the
// hits to that value. A node may be mentioned more than once in a pattern, so
// the narrowing is a clause of its own rather than an edit to the clause
// already there: `pattern { V [upos=VERB] }` becomes
// `pattern { V [upos=VERB]; V [lemma="see"] }`.

// A FEATS count groups the whole `Key=Value` string, so the clause it makes
// names the KEY. Anything else is the field itself.
//
// A feature KEY is written bare, so it cannot be escaped, and a project can
// hold a key that is not bare-safe: that is exactly what the Validation tab
// lists. Those fall back to searching the whole FEATS string for the pair,
// which is what the span actually stores anyway.
export const clauseFor = (node, field, value) => {
  if (!BARE_KEY.test(node || '') || !BARE_KEY.test(field === 'FEATS' ? 'FEATS' : field || '')) {
    return null;
  }
  if (field === 'FEATS') {
    const text = String(value ?? '');
    const at = text.indexOf('=');
    if (at <= 0 || at === text.length - 1) return null;
    const key = text.slice(0, at);
    return BARE_KEY.test(key)
      ? `${node} [${key}=${quote(text.slice(at + 1))}]`
      : `${node} [FEATS=${exactRegex(text)}]`;
  }
  return `${node} [${field}=${quote(value)}]`;
};

// The clause added at the end of the FIRST `pattern { … }` block, which is the
// one the count was run against. Null when there is no such block to add to.
//
// The block's end is found by LEXING, not by counting braces. Grew has three
// value literals (`"…"`, `re"…"`, `/…/flags`) and a `%` comment to end of
// line, and a brace inside any of them is not a brace: a hand-rolled scanner
// that knew about one of them spliced the clause into the middle of a PCRE
// regex, and the result still parsed, as a silently different search. The app
// owns a lexer that knows all four contexts, so it answers this.
export const refinePattern = (text, node, field, value) => {
  const clause = clauseFor(node, field, value);
  if (!clause) return null;

  let tokens;
  try {
    tokens = lex(String(text ?? ''));
  } catch {
    return null; // not lexable, so the box is already showing a parse error
  }

  // Absolute offset of a token's 1-based {line, col}.
  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') lineStarts.push(i + 1);
  }
  const offsetOf = (t) => lineStarts[t.line - 1] + (t.col - 1);

  let i = tokens.findIndex(
    (t, k) =>
      t.type === TT.IDENT &&
      t.value === 'pattern' &&
      tokens[k + 1] &&
      tokens[k + 1].type === TT.LBRACE,
  );
  if (i < 0) return null;

  let depth = 0;
  for (i += 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type === TT.LBRACE) depth += 1;
    else if (t.type === TT.RBRACE) {
      depth -= 1;
      if (depth > 0) continue;
      const at = offsetOf(t);
      // Keep the body exactly as the user wrote it, including its line breaks.
      const raw = text.slice(0, at);
      // A `%` comment runs to the end of its line, so collapsing the newline
      // after one puts the new clause INSIDE the comment, where the lexer drops
      // it and the pattern stops parsing. Keep that break, and only that one.
      const trimmed = raw.replace(/\s+$/, '');
      const lastLine = trimmed.slice(trimmed.lastIndexOf('\n') + 1);
      const before = lastLine.includes('%') ? raw.replace(/[ \t]+$/, '') : trimmed;
      // The separator question is about the last thing WRITTEN, not the last
      // character, which above is deliberately a newline.
      const separator = /[{;]$/.test(before.replace(/\s+$/, '')) ? '' : ';';
      return `${before}${separator} ${clause} ${text.slice(at)}`;
    }
  }
  return null;
};
