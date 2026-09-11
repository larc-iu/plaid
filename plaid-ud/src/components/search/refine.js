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
// Braces are counted, and a brace inside a STRING is not a brace: a pattern
// may legally look for one (`V [lemma=re".*}.*"]`), and counting it closed the
// block early and inserted the clause into the middle of the regex. Grew's
// strings are double-quoted with backslash escapes, which is all this has to
// know to skip them.
export const refinePattern = (text, node, field, value) => {
  const clause = clauseFor(node, field, value);
  if (!clause) return null;
  const open = /\bpattern\s*\{/.exec(text || '');
  if (!open) return null;
  let depth = 0;
  let quote = null;
  for (let i = open.index + open[0].length - 1; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth > 0) continue;
      // Keep the body exactly as the user wrote it, including its line breaks.
      const before = text.slice(0, i).replace(/\s+$/, '');
      const separator = /[{;]$/.test(before) ? '' : ';';
      return `${before}${separator} ${clause} ${text.slice(i)}`;
    }
  }
  return null;
};
