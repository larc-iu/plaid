// Regex helpers for the Grew → Plaid-QL compiler.
//
// Plaid runs java.util.regex patterns as a substring search against the decoded
// value, so we anchor with ^/$ wherever we mean a whole-value match. FEATS are
// stored one span per feature with value "Key=Value", which is why feature
// constraints become anchored patterns over that "Key=Value" string.

const META = /[.\\+*?(){}\[\]^$|]/g;

// Escape a literal so it matches itself inside a Java regex.
export const escapeRegex = (s) => String(s).replace(META, '\\$&');

// Plaid supports only the case-insensitive flag; drop anything else.
export const normalizeFlags = (flags) => (flags && flags.includes('i') ? 'i' : '');

// A FEATS span value that means "feature `name` is defined (any value)".
export const featDefinedRegex = (name) => `^${escapeRegex(name)}=`;

// "feature `name` is defined AND its value is not `val`" — a negative lookahead
// over the stored "name=value" string.
export const featNeqRegex = (name, val) => `^${escapeRegex(name)}=(?!${escapeRegex(val)}$)`;

// The exact stored value for `feat=val`.
export const featEqValue = (name, val) => `${name}=${val}`;

// A deprel value that is NOT exactly one of `labels` (Grew `-[^a|b]->`).
export const negatedLabelRegex = (labels) =>
  `^(?!(?:${labels.map(escapeRegex).join('|')})$)`;

// A deprel value whose main type is `label`, matching the bare label and any
// subtype: `nsubj` matches "nsubj" and "nsubj:pass" (Grew `-[1=nsubj]->`).
export const subtypeRegex = (label) => `^${escapeRegex(label)}(:|$)`;

// "value is not exactly `val`" for a single-valued span layer (upos<>VERB).
export const notExactlyRegex = (val) => `^(?!${escapeRegex(val)}$)`;

// Build the deprel regex for an edge-feature label like `1=nsubj, 2=pass`.
// Keys are joined in numeric order with ':' (UD subtype separator), then matched
// as a subtype prefix. `!key` / non-numeric keys are unsupported (caller checks).
export const featuresLabelRegex = (feats) => {
  const ordered = [...feats].sort((a, b) => Number(a.key) - Number(b.key));
  const joined = ordered.map(f => f.val).join(':');
  return subtypeRegex(joined);
};
