// Alphabetical order, the dictionary's own.
//
// `Intl.Collator` knows nothing about an orthography's n-graphs: it files
// "chapa" between "capa" and "cima" because it reads c-h-a-p-a. A dictionary
// whose alphabet has "ch" as a letter wants it after every plain c, and wants
// its own Ch heading in the index.
//
// So a dictionary may state its alphabet: an ordered list of units, each one
// or more characters. The order IS the collation, which is why an n-graph
// cannot be given on its own: "ch" means nothing until it has a place.
//
// Matching is longest-first at each position, so "ch" wins over "c". A
// character the alphabet does not list is matched again through its base form,
// so "á" files under a listed "a" (and under itself if the alphabet lists "á",
// which is matched first). One it still cannot place sorts after every letter,
// in code-point order, under a heading of its own.

// Every unlisted grapheme ranks after every listed one, and among themselves by
// code point, so they gather after Z instead of scattering.
const UNLISTED = 1e7;

const foldChar = (char) =>
  char
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase() || char;

/** The alphabet a person typed, as units: whitespace-separated, deduped. */
export const parseAlphabet = (text) => [
  ...new Set(
    String(text ?? '')
      .split(/\s+/)
      .map((unit) => unit.trim().toLowerCase())
      .filter(Boolean),
  ),
];

/** The units as a person edits them. */
export const formatAlphabet = (units) => (units || []).join(' ');

/**
 * A form split into the alphabet's units. A position that matches no unit
 * yields one code point, so every form splits into something.
 */
export const splitGraphemes = (form, units) => {
  const chars = [...String(form ?? '').toLowerCase()];
  // Longest unit first, counted in code points, so "ch" is tried before "c".
  const order = [...(units || [])].sort((a, b) => [...b].length - [...a].length);
  const out = [];
  let at = 0;
  while (at < chars.length) {
    const rest = chars.slice(at).join('');
    const unit = order.find((candidate) => rest.startsWith(candidate));
    if (unit) {
      out.push(unit);
      at += [...unit].length;
      continue;
    }
    // No unit as written. Try the character's base form, so an accented letter
    // files under the letter the alphabet does list.
    const folded = foldChar(chars[at]);
    out.push(order.includes(folded) ? folded : chars[at]);
    at += 1;
  }
  return out;
};

/** The heading a unit is filed under: "ch" reads Ch, never CH. */
const headingOf = (unit) => {
  const [first, ...rest] = [...String(unit ?? '')];
  return first ? first.toUpperCase() + rest.join('') : '';
};

/**
 * A collator over a stated alphabet. Same shape as the `Intl.Collator` the
 * dictionary otherwise uses, plus `letterOf` for the index headings.
 *
 * Sort keys are built once per form and remembered: a five thousand headword
 * dictionary is sorted with five thousand splits rather than one per
 * comparison.
 */
export const alphabetCollator = (units) => {
  const alphabet = units || [];
  const rank = new Map(alphabet.map((unit, i) => [unit, i]));
  const keys = new Map();

  const keyOf = (form) => {
    let key = keys.get(form);
    if (!key) {
      key = splitGraphemes(form, alphabet).map((grapheme) =>
        rank.has(grapheme) ? rank.get(grapheme) : UNLISTED + (grapheme.codePointAt(0) ?? 0),
      );
      keys.set(form, key);
    }
    return key;
  };

  const compare = (a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
      if (ka[i] !== kb[i]) return ka[i] - kb[i];
    }
    if (ka.length !== kb.length) return ka.length - kb.length;
    // Same letters: fall back on the text, so case and accents still settle it.
    return String(a).localeCompare(String(b));
  };

  const letterOf = (form) => headingOf(splitGraphemes(form, alphabet)[0] ?? '');

  return { compare, letterOf, alphabet };
};

/**
 * The alphabet units a dictionary's own headwords need, in the order the
 * fallback collator puts them: what the setup form offers as a starting point,
 * one unit per distinct first letter. N-graphs are the compiler's to add,
 * since nothing in the data says "ch" is a letter rather than c then h.
 */
export const suggestAlphabet = (forms, collator = new Intl.Collator()) => {
  const units = new Set();
  for (const form of forms || []) {
    const first = [...String(form ?? '')][0];
    if (first) units.add(foldChar(first));
  }
  return [...units].sort(collator.compare);
};

/** The headwords whose first unit the alphabet does not account for. */
export const outsideAlphabet = (forms, units) => {
  if (!units?.length) return [];
  const listed = new Set(units);
  return (forms || []).filter((form) => !listed.has(splitGraphemes(form, units)[0]));
};
