// A substitution function for one (find, matchType, replacement) triple,
// shared by the project's Bulk Edit tab and a vocabulary's Replace dialog.
// `matchType` is one of the search tab's MATCH_TYPES ids: `contains` (case-
// insensitive, literal), `exact`, or `regex`, or MATCH_EMPTY below, which only
// the vocabulary's Replace dialog offers.
//
// `contains` and `regex` go through translatePattern, the same reading of the
// pattern that Search sends to the server, so a value is rewritten here
// exactly when the server's search finds it. The server reads the pattern and
// the value in NFC, so `pʰá` typed composed finds it stored decomposed, and so
// does this: the match is found in the composed value, the place it covers is
// mapped back onto the value as stored, and only that place is rewritten,
// with the replacement as typed (plaid-agent's core/replace.py, the same rule).

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

const nfc = (s) => s.normalize('NFC');

// `s` cut where NFC changes nothing across the cut, each piece with its NFC
// form: a character and the marks after it, joined to the piece before when
// the two compose together (Hangul jamo, a vowel sign).
const canonicalPieces = (s) => {
  const out = [];
  const push = (p) => {
    const n = nfc(p);
    const last = out[out.length - 1];
    if (last && nfc(last[0] + p) !== last[1] + n) {
      last[0] += p;
      last[1] = nfc(last[0]);
    } else out.push([p, n]);
  };
  let piece = '';
  for (const ch of s) {
    if (piece && !/\p{M}/u.test(ch)) {
      push(piece);
      piece = '';
    }
    piece += ch;
  }
  if (piece) push(piece);
  return out.map(([, n]) => n).join('') === nfc(s) ? out : [[s, nfc(s)]];
};

// `$1`, `$<name>`, `$&` and the rest in a replacement, as String.replace
// reads them, for one match of `matchAll`.
const expand = (template, m) =>
  template.replace(/\$([$&`']|\d{1,2}|<[^>]*>)/g, (all, t) => {
    if (t === '$') return '$';
    if (t === '&') return m[0];
    if (t === '`') return m.input.slice(0, m.index);
    if (t === "'") return m.input.slice(m.index + m[0].length);
    if (t[0] === '<') return m.groups ? (m.groups[t.slice(1, -1)] ?? '') : all;
    const two = Number(t);
    if (t.length === 2 && two >= 1 && two < m.length) return m[two] ?? '';
    const one = Number(t[0]);
    return one >= 1 && one < m.length ? (m[one] ?? '') + t.slice(1) : all;
  });

// `value` with every match of `re` (global) in its NFC form rewritten by
// `by(match)`, mapped back onto `value` as stored. A match that starts or
// ends inside a piece NFC rewrote takes the whole piece.
const replaceCanonical = (value, re, by) => {
  const pieces = canonicalPieces(value);
  const stored = [];
  const normal = [];
  let a = 0;
  let b = 0;
  for (const [p, n] of pieces) {
    stored.push(a);
    normal.push(b);
    a += p.length;
    b += n.length;
  }
  const at = (x, end) => {
    if (x >= b) return value.length;
    let k = normal.length - 1;
    while (normal[k] > x) k -= 1;
    const off = x - normal[k];
    const [p, n] = pieces[k];
    if (off === 0 || p === n) return stored[k] + off;
    return stored[k] + (end ? p.length : 0);
  };
  let out = '';
  let last = 0;
  re.lastIndex = 0;
  for (const m of nfc(value).matchAll(re)) {
    const from = Math.max(at(m.index, false), last);
    const to = Math.max(at(m.index + m[0].length, true), last);
    out += value.slice(last, from) + by(m);
    last = to;
  }
  return out + value.slice(last);
};

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
      nfc(find),
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
      if (!re.test(nfc(v))) return null;
      re.lastIndex = 0;
      if (v !== nfc(v)) {
        next = replaceCanonical(v, re, (m) =>
          matchType === 'regex'
            ? expand(replacement, m)
            : keepCase
              ? matchCase(m[0], replacement)
              : replacement,
        );
      } else {
        next =
          matchType === 'regex'
            ? v.replace(re, replacement)
            : // A function replacer so `$` in a literal replacement stays literal.
              v.replace(re, keepCase ? (m) => matchCase(m, replacement) : () => replacement);
      }
    }
    return next === v ? null : next;
  };
  return { apply, error: null };
}
