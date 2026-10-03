// A substitution function for one (find, matchType, replacement) triple,
// shared by the project's Bulk Edit tab and a vocabulary's Replace dialog.
// `matchType` is one of the search tab's MATCH_TYPES ids: `contains` (case-
// insensitive, literal), `exact`, or `regex`, or MATCH_EMPTY below, which only
// the vocabulary's Replace dialog offers.
//
// `contains` and `regex` go through translatePattern, the same reading of the
// pattern that Search sends to the server, so a value is rewritten here
// exactly when the server's search finds it.

import { translatePattern } from '@ui/domain/javaRegex.js';

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

const isUpper = (c) => c !== c.toLowerCase() && c === c.toUpperCase();
const isLower = (c) => c !== c.toUpperCase() && c === c.toLowerCase();

/**
 * The replacement for one match of an any-case search, in the matched text's
 * capitals: `ka` to `ga` makes `Kalamang` `Galamang` and `KA` `GA`. A match
 * whose cased letters are all capitals (two or more) takes the replacement in
 * capitals, a match that starts with a capital takes it with its first letter
 * a capital, and any other match takes it as typed. Only used when neither
 * the find text nor the replacement has a capital: `PFV` to `pfv` asks for
 * those very capitals to go.
 */
function matchCase(matched, replacement) {
  const letters = Array.from(matched).filter((c) => isUpper(c) || isLower(c));
  if (!letters.length || !replacement) return replacement;
  if (letters.length > 1 && letters.every(isUpper)) return replacement.toUpperCase();
  if (!isUpper(letters[0])) return replacement;
  const chars = Array.from(replacement);
  const k = chars.findIndex((c) => isLower(c));
  if (k < 0 || chars.slice(0, k).some(isUpper)) return replacement;
  chars[k] = chars[k].toUpperCase();
  return chars.join('');
}

// Returns { apply, error }: `apply(value)` gives the rewritten value, or null
// when the value is unchanged (no match, or the match rewrites to itself).
// A pattern that cannot be used yields `error` and an `apply` that never
// matches.
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
  if (matchType === 'regex' || matchType === 'contains') {
    const { source, error } = translatePattern(
      find,
      matchType === 'contains' ? { literal: true, caseInsensitive: true } : {},
    );
    if (error) return { apply: never, error };
    re = new RegExp(source, 'gu');
  }
  const hasCapital = (s) => Array.from(s ?? '').some(isUpper);
  const keepCase = matchType === 'contains' && !hasCapital(find) && !hasCapital(replacement);
  const apply = (value) => {
    const v = value ?? '';
    if (v === '') return null;
    let next;
    if (matchType === 'exact') {
      if (v !== find) return null;
      next = replacement;
    } else {
      re.lastIndex = 0;
      if (!re.test(v)) return null;
      re.lastIndex = 0;
      next =
        matchType === 'regex'
          ? v.replace(re, replacement)
          : // A function replacer so `$` in a literal replacement stays literal.
            v.replace(re, keepCase ? (m) => matchCase(m, replacement) : () => replacement);
    }
    return next === v ? null : next;
  };
  return { apply, error: null };
}
