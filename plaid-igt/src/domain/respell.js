// Respelling a word in place: the text write Bulk Edit's Respell words sends
// (components/projects/bulk). Offsets are code points.

// Text edit directives for one text's respell rows ({ begin, end, new }).
// Applied in order server-side, so later (higher-offset) replacements go
// first: each op's indices then refer to text no earlier op has shifted.
// Every op is a whole-token replace, which is what keeps the token (see
// plaid.algos.text.ops `token-edit`).
export function respellOps(rows) {
  return [...rows]
    .sort((a, b) => b.begin - a.begin)
    .map((r) => ({ type: 'replace', index: r.begin, length: r.end - r.begin, value: r.new }));
}
