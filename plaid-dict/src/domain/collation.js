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
//
// A position is a GRAPHEME CLUSTER, not a code point, so a letter keeps the
// combining marks written on it. See splitClusters.

// Every unlisted grapheme ranks after every listed one, and among themselves by
// code point, so they gather after Z instead of scattering.
const UNLISTED = 1e7;

/**
 * A string with its marks folded away and its case dropped, for MATCHING
 * rather than for ordering.
 *
 * Ordering must NOT fold (see suggestAlphabet): in Yoruba a dot below makes a
 * letter, and folding dropped `ẹ` and `ọ` out of an alphabet. Matching is the
 * opposite case, and for the same reason — a speaker looking up `ọkọ` on a
 * keyboard that cannot make the marks types `oko`, and a dictionary that
 * answers nothing has failed them.
 *
 * Only combining marks go. NFKD leaves a letter with no canonical
 * decomposition alone, so `ł` and `ø` still match only themselves.
 */
export const foldDiacritics = (s) =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

// A single character, with the original kept when folding leaves nothing: a
// bare combining mark is its own unit, and splitGraphemes needs something.
const foldChar = (char) => foldDiacritics(char) || char;

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

// A string as GRAPHEME CLUSTERS, not code points. This is what keeps a
// combining mark attached to the letter it sits on. Splitting `ọ̀kọ̀` by code
// point made the bare U+0300 its own unit, which matched no alphabet entry and
// so ranked UNLISTED + 0x300 = 10000768, outranking every real letter: the word
// filed after every `ọ`-plus-letter word instead of beside its homonyms, and a
// search for `ọkọ` never reached it. Yoruba has no precomposed form for
// dot-below plus tone, so `ọ̀ ọ́ ẹ̀ ẹ́` are all two code points and this hit most
// of the tone-marked vowels in the language.
const splitClusters = (s) => {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].map(
      (part) => part.segment,
    );
  }
  return s.match(/\P{M}\p{M}*|\p{M}+/gu) || [];
};

/**
 * A form split into the alphabet's units. A position that matches no unit
 * yields one grapheme cluster, so every form splits into something.
 */
export const splitGraphemes = (form, units) => {
  const chars = splitClusters(String(form ?? '').toLowerCase());
  // Longest unit first, counted in clusters, so "ch" is tried before "c".
  const order = [...(units || [])].sort(
    (a, b) => splitClusters(b).length - splitClusters(a).length,
  );
  const span = new Map(order.map((unit) => [unit, splitClusters(unit).length]));
  const out = [];
  let at = 0;
  while (at < chars.length) {
    const rest = chars.slice(at).join('');
    const unit = order.find((candidate) => rest.startsWith(candidate));
    if (unit) {
      out.push(unit);
      // Advance whole clusters. A listed `ọ` matching the start of the cluster
      // `ọ̀` consumes the mark with it, which is the rule a tonal orthography
      // wants: the tone is not a letter and does not affect the order. The
      // `localeCompare` tie-break in `alphabetCollator` still separates two
      // forms that reduce to the same letters.
      at += span.get(unit) ?? 1;
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
 * one unit per distinct first grapheme, AS WRITTEN. N-graphs are the compiler's
 * to add, since nothing in the data says "ch" is a letter rather than c then h,
 * and marked letters are theirs to remove, for the mirror reason.
 *
 * This used to fold the mark away, which read as the safe default and was not.
 * Nothing in the data separates a letter-forming mark from a tone mark: a dot
 * below makes a letter in Yoruba and marks tone in Vietnamese. So the choice is
 * only which way to be wrong, and the two are not symmetric. Folding dropped
 * `ẹ` and `ọ` out of a Yoruba alphabet altogether, filing `ẹja` under E and
 * seven words under O with nothing on screen to say so. Offering them costs one
 * visible row the compiler deletes. Deleting it is safe now that an unlisted
 * mark files with its base letter (see splitGraphemes); before that fix it was
 * the deletion that broke the order.
 */
export const suggestAlphabet = (forms, collator = new Intl.Collator()) => {
  const units = new Set();
  for (const form of forms || []) {
    const first = splitClusters(String(form ?? '').toLowerCase())[0];
    if (first) units.add(first);
  }
  return [...units].sort(collator.compare);
};

/** The headwords whose first unit the alphabet does not account for. */
export const outsideAlphabet = (forms, units) => {
  if (!units?.length) return [];
  const listed = new Set(units);
  return (forms || []).filter((form) => !listed.has(splitGraphemes(form, units)[0]));
};
