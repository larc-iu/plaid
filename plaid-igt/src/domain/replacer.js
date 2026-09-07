// A substitution function for one (find, matchType, replacement) triple,
// shared by the project's Bulk Edit tab and a vocabulary's Replace dialog.
// `matchType` is one of the search tab's MATCH_TYPES ids: `contains` (case-
// insensitive, literal), `exact`, or `regex`, or MATCH_EMPTY below, which only
// the vocabulary's Replace dialog offers.

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Fill a value that is not there. The three search match types all skip an
 * empty value (a `contains` search must not match every blank entry, and an
 * empty `find` matches nothing at all), so setting a field on the entries that
 * lack it needs its own kind. It has no `find`: the empty value IS the match.
 *
 * This is what makes a whole imported lexicon publishable in one pass, since
 * an import writes no status on anything.
 */
export const MATCH_EMPTY = 'empty';

// Returns { apply, error }: `apply(value)` gives the rewritten value, or null
// when the value is unchanged (no match, or the match rewrites to itself).
// A bad regex yields `error` and an `apply` that never matches.
export function buildReplacer(find, matchType, replacement) {
  const never = () => null;
  if (matchType === MATCH_EMPTY) {
    const next = replacement ?? '';
    // Replacing nothing with nothing changes nothing.
    if (next === '') return { apply: never, error: null };
    return { apply: (value) => ((value ?? '') === '' ? next : null), error: null };
  }
  if (!find) return { apply: never, error: null };
  let re = null;
  if (matchType === 'regex') {
    try {
      re = new RegExp(find, 'g');
    } catch (err) {
      return { apply: never, error: err.message || 'Invalid regular expression.' };
    }
  } else if (matchType === 'contains') {
    re = new RegExp(escapeRegex(find), 'gi');
  }
  const apply = (value) => {
    const v = value ?? '';
    if (v === '') return null;
    let next;
    if (matchType === 'exact') {
      if (v !== find) return null;
      next = replacement;
    } else if (matchType === 'regex') {
      re.lastIndex = 0;
      if (!re.test(v)) return null;
      re.lastIndex = 0;
      next = v.replace(re, replacement);
    } else {
      re.lastIndex = 0;
      if (!re.test(v)) return null;
      re.lastIndex = 0;
      // A function replacer so `$` in a literal replacement stays literal.
      next = v.replace(re, () => replacement);
    }
    return next === v ? null : next;
  };
  return { apply, error: null };
}
