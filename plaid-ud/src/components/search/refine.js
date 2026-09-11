// Narrowing a search to one value from the count table.
//
// A count row names a value of one node's field, and clicking it filters the
// hits to that value. A node may be mentioned more than once in a pattern, so
// the narrowing is a clause of its own rather than an edit to the clause
// already there: `pattern { V [upos=VERB] }` becomes
// `pattern { V [upos=VERB]; V [lemma="see"] }`.

const quote = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// A FEATS count groups the whole `Key=Value` string, so the clause it makes
// names the KEY. Anything else is the field itself.
export const clauseFor = (node, field, value) => {
  if (!node || !field) return null;
  if (field === 'FEATS') {
    const text = String(value ?? '');
    const at = text.indexOf('=');
    if (at <= 0 || at === text.length - 1) return null;
    return `${node} [${text.slice(0, at)}=${quote(text.slice(at + 1))}]`;
  }
  return `${node} [${field}=${quote(value)}]`;
};

// The clause added at the end of the FIRST `pattern { … }` block, which is the
// one the count was run against. Null when there is no such block to add to.
export const refinePattern = (text, node, field, value) => {
  const clause = clauseFor(node, field, value);
  if (!clause) return null;
  const open = /\bpattern\s*\{/.exec(text || '');
  if (!open) return null;
  let depth = 0;
  for (let i = open.index + open[0].length - 1; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
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
