// A regex a person wrote in a Grew request (`re"…"` or `/…/i`), read once and
// written out for both engines that run it: the server's query (Java) for the
// search and for the rewrite's discovery, and this browser (a JS RegExp) for
// the rewrite's own matcher. Handing the pattern as typed to both did not
// agree: `\p{L}` matched every letter on the server and nothing here, so a
// `without` clause the search honoured blocked nothing in a rewrite.
//
// The reading is plaid-ui's translator (plaid-ui/src/domain/javaRegex.js), the
// one every Plaid regex box goes through: `\w`, `\d`, `\s` and `\b` read
// every script as the server reads them, a script such as `\p{IsArabic}` reads
// the same on both sides, `(?i)` and the `i` flag fold case the same way on
// both sides, and a construct the two dialects read differently is refused
// with a message. It is imported by a relative path, so the node test suite
// can load it.

import { translatePattern } from '../../../plaid-ui/src/domain/javaRegex.js';
import { GrewUnsupportedError } from './errors.js';
import { normalizeFlags } from './regex.js';

const translations = new Map();
const compiled = new Map();

const keyOf = (v) => `${normalizeFlags(v.flags)}/${v.pattern}`;

// { server, source, error } for a regex AST value. A user regex is a search
// anywhere in the value (Grew matches whole, a deliberate divergence).
const translate = (v) => {
  const key = keyOf(v);
  let t = translations.get(key);
  if (!t) {
    t = translatePattern(String(v.pattern), {
      caseInsensitive: normalizeFlags(v.flags) === 'i',
    });
    translations.set(key, t);
  }
  return t;
};

/** Why the regex cannot be read, or null when it can. */
export const regexError = (v) => translate(v).error;

const readable = (v) => {
  const t = translate(v);
  if (t.error) throw new GrewUnsupportedError('regex', t.error);
  return t;
};

/** The pattern for a query's `{regex}`. It carries its own case folding, so it
 * goes with no flags. */
export const serverRegex = (v) => readable(v).server;

/** The same pattern as a RegExp for the local matcher. */
const localRegExp = (v) => {
  const key = keyOf(v);
  let re = compiled.get(key);
  if (!re) {
    re = new RegExp(readable(v).source, 'u');
    compiled.set(key, re);
  }
  return re;
};

const composedRegExps = new Map();

// The pattern in NFC as a RegExp, or null when it already is NFC or cannot
// be read once composed (the pattern as typed then says it all).
const composedRegExp = (v) => {
  const key = keyOf(v);
  if (!composedRegExps.has(key)) {
    const pattern = String(v.pattern);
    const composed = pattern.normalize('NFC');
    const t =
      composed === pattern
        ? null
        : translatePattern(composed, { caseInsensitive: normalizeFlags(v.flags) === 'i' });
    composedRegExps.set(key, t && !t.error ? new RegExp(t.source, 'u') : null);
  }
  return composedRegExps.get(key);
};

/** Whether the local matcher finds the pattern in `actual`, as the server's
 * REGEXP decides: in the value as stored, or in its NFC form with the pattern
 * in NFC. So a pattern typed composed finds a form stored decomposed, and a
 * mark searched for on its own still finds it stored as a mark. */
export const localMatches = (v, actual) => {
  const s = String(actual);
  if (localRegExp(v).test(s)) return true;
  const n = s.normalize('NFC');
  const composed = composedRegExp(v);
  if (composed) return composed.test(n);
  return n !== s && localRegExp(v).test(n);
};
