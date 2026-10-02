// Regex helpers for the Grew → Plaid-QL compiler.
//
// Plaid runs java.util.regex patterns as a substring search against the decoded
// value, so we anchor with ^/$ wherever we mean a whole-value match. FEATS are
// stored one span per feature with value "Key=Value", which is why feature
// constraints become anchored patterns over that "Key=Value" string.

const META = /[.\\+*?(){}[\]^$|]/g;

// Escape a literal so it matches itself inside a Java regex.
const escapeRegex = (s) => String(s).replace(META, '\\$&');

// Plaid supports only the case-insensitive flag; drop anything else.
export const normalizeFlags = (flags) => (flags && flags.includes('i') ? 'i' : '');

// A FEATS span value that means "feature `name` is defined (any value)".
export const featDefinedRegex = (name) => `^${escapeRegex(name)}=`;

// "feature `name` is defined AND its value is not `val`" — a negative lookahead
// over the stored "name=value" string.
export const featNeqRegex = (name, val) => `^${escapeRegex(name)}=(?!${escapeRegex(val)}$)`;

// The exact stored value for `feat=val`.
export const featEqValue = (name, val) => `${name}=${val}`;

// A user's regex over one feature's VALUE, as a regex over the stored
// "name=value". The local matcher (rewrite/match.js) searches the value alone,
// so here too the regex is a search anywhere in the value, and the user's `^`
// means the start of the value: each one outside a character class becomes a
// lookbehind for "name=". Prefixing the regex as written read `^S` as
// `^Number=(?:^S)`, which matches nothing, and read `in` as "starts with in".
// A `$` needs nothing, the value ends where the span does.
export const featValueRegex = (name, pattern) => {
  const key = `^${escapeRegex(name)}=`;
  return `${key}.*?(?:${valueAnchors(pattern, `(?<=${key})`)})`;
};

// `pattern` with every `^` that is an anchor replaced by `start`. Escapes,
// `\Q…\E` quoting and character classes (nested, as Java reads them) are
// copied as they are, so `\^`, `[^a]` and `[a^]` keep their meaning.
const valueAnchors = (pattern, start) => {
  let out = '';
  let depth = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '\\') {
      const quoteEnd = pattern[i + 1] === 'Q' ? pattern.indexOf('\\E', i + 2) : -2;
      let end = i + 2;
      if (quoteEnd >= 0) end = quoteEnd + 2;
      else if (quoteEnd === -1) end = pattern.length;
      out += pattern.slice(i, end);
      i = end - 1;
    } else if (depth > 0) {
      if (c === '[') depth += 1;
      else if (c === ']') depth -= 1;
      out += c;
    } else if (c === '[') {
      depth = 1;
      out += c;
      // A `]` first in a class (after any `^`) is a literal, not its end.
      if (pattern[i + 1] === '^') out += pattern[(i += 1)];
      if (pattern[i + 1] === ']') out += pattern[(i += 1)];
    } else {
      out += c === '^' ? start : c;
    }
  }
  return out;
};

// A FEATS span that holds a feature: a name and a value either side of the
// first `=`, neither of them blank. The same reading as utils/feats.js
// `normalizeFeature`, which is how the local matcher reads a span.
const FEATURE_PAIR = '[^=]*[^=\\s][^=]*=[\\s\\S]*\\S';
export const featurePairRegex = `^${FEATURE_PAIR}`;

// A FEATS span that holds a feature other than exactly `pair`.
export const otherFeaturePairRegex = (pair) => `^(?!${escapeRegex(pair)}$)${FEATURE_PAIR}`;

// A deprel value that is NOT exactly one of `labels` (Grew `-[^a|b]->`).
export const negatedLabelRegex = (labels) => `^(?!(?:${labels.map(escapeRegex).join('|')})$)`;

// A deprel value whose main type is `label`, matching the bare label and any
// subtype: `nsubj` matches "nsubj" and "nsubj:pass" (Grew `-[1=nsubj]->`).
const subtypeRegex = (label) => `^${escapeRegex(label)}(:|$)`;

// "value is not exactly `val`" for a single-valued span layer (upos<>VERB).
export const notExactlyRegex = (val) => `^(?!${escapeRegex(val)}$)`;

// Build the deprel regex for an edge-feature label like `1=nsubj, 2=pass`.
// Keys are joined in numeric order with ':' (UD subtype separator), then matched
// as a subtype prefix. `!key` / non-numeric keys are unsupported (caller checks).
export const featuresLabelRegex = (feats) => {
  const ordered = [...feats].sort((a, b) => Number(a.key) - Number(b.key));
  const joined = ordered.map((f) => f.val).join(':');
  return subtypeRegex(joined);
};
