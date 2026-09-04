// Compose: type a backslash code to enter a character the keyboard does not
// have. `\sw` gives ə, `\ng` gives ŋ, `\0/` gives ∅, and `\u0250` gives any
// BMP code point by number. The codes are Praat's (see composeTable.js).
//
// WHY A PREFIX, not a bare digraph table. A bare `ue` -> ü rule fires inside
// real metalanguage words, and gloss and POS cells are full of them: `blue`
// would become `blü`. Nothing here fires unless the user asks for it by typing
// a backslash, so the rule has no false positives to trade off against.
//
// OFFSETS ARE UTF-16, not code points, because every consumer is
// `input.selectionStart`. That is the same deliberate exception the tagset
// scanner makes (see domain/tagsets.js, and [[plaid-codepoint-offsets]]). It is
// safe here for a stronger reason than there: every code is ASCII and every
// output is in the BMP, so no arithmetic in this file can split a surrogate
// pair.
//
// This module is pure. The DOM side (which event, how to insert without
// destroying the undo stack) lives in lib/composeInput.js.

import { COMPOSE_TABLE } from './composeTable.js';

/** The character that opens a code. Typed twice, it is a literal backslash. */
export const COMPOSE_PREFIX = '\\';

/** Every table code is exactly this long, which makes the set prefix-free. */
export const CODE_LENGTH = 2;

/** `\u` + this many hex digits is the by-number escape hatch. */
const HEX_LENGTH = 4;
const HEX_INTRO = 'u';
const HEX_DIGIT = /[0-9a-fA-F]/;
// `\u`, then the digits accumulated so far, anchored at the caret.
const HEX_PENDING = /\\u([0-9a-fA-F]{0,3})$/;

// Every entry point takes an optional `table`, so a project can bind codes of
// its own on top of the built-in ones (see domain/composeConfig.js). It stays
// optional because most of this app has no project in hand, and the built-in
// table is the right answer there.
const tableOr = (t) => t || COMPOSE_TABLE;

/** The character a code produces in `table`, or null. */
export const lookupCode = (code, table) =>
  Object.prototype.hasOwnProperty.call(tableOr(table), code) ? tableOr(table)[code] : null;

/** Is `code` a complete code? */
export const isComposeCode = (code, table) => lookupCode(code, table) != null;

/**
 * Decide what typing `ch` at `caret` in `value` should do.
 *
 * Returns null to let the character insert normally, or a replacement
 * `{ start, end, text, escapedAt }`: replace `value.slice(start, end)` with
 * `text`. `escapedAt` is present only on the `\\` case, and is the index the
 * caller must remember as "this backslash is a literal, never open a code with
 * it". Pass it back in as the option of the same name.
 *
 * The caller is responsible for only asking about a collapsed selection: with
 * a range selected, the typed character replaces the range and no code can be
 * pending in front of it.
 */
export function composeInsert(value, caret, ch, { escapedAt = -1, table } = {}) {
  if (typeof value !== 'string' || !(caret >= 0) || typeof ch !== 'string' || ch.length !== 1) {
    return null;
  }
  const opensAt = (i) => i >= 0 && value[i] === COMPOSE_PREFIX && i !== escapedAt;

  // `\\` collapses to one literal backslash, and marks it so the next two
  // characters do not compose against it.
  if (ch === COMPOSE_PREFIX && opensAt(caret - 1)) {
    return { start: caret - 1, end: caret, text: COMPOSE_PREFIX, escapedAt: caret - 1 };
  }

  // A complete two-character code. Checked BEFORE the hex escape so that the
  // table always wins: `\u-` is ʉ, not the start of a code point.
  if (opensAt(caret - CODE_LENGTH)) {
    const hit = lookupCode(value.slice(caret - CODE_LENGTH + 1, caret) + ch, table);
    if (hit != null) return { start: caret - CODE_LENGTH, end: caret, text: hit };
  }

  // `\uXXXX`. No table code is `u` followed by a hex digit, so reaching here
  // with a hex digit after `\u` is unambiguous.
  if (HEX_DIGIT.test(ch)) {
    const m = HEX_PENDING.exec(value.slice(0, caret));
    if (m && opensAt(caret - m[0].length)) {
      const digits = m[1] + ch;
      if (digits.length < HEX_LENGTH) return null; // keep accumulating
      return {
        start: caret - m[0].length,
        end: caret,
        text: String.fromCodePoint(parseInt(digits, 16)),
      };
    }
  }

  return null;
}

/**
 * Is a code open in front of the caret, waiting for more characters? The
 * morpheme grid asks this before treating `-` or `=` as a split: 22 table
 * codes end in one of those (`\i-` ɨ, `\l-` ɬ, `\u-` ʉ) and 18 more begin with
 * one (the `\-5`..`\-1` tone bars), so the split has to stand down while a
 * code is being typed.
 */
export function composePending(value, caret, { escapedAt = -1 } = {}) {
  if (typeof value !== 'string' || !(caret > 0)) return false;
  const opensAt = (i) => i >= 0 && value[i] === COMPOSE_PREFIX && i !== escapedAt;
  if (opensAt(caret - 1)) return true; // just `\`
  if (opensAt(caret - CODE_LENGTH)) return true; // `\` + one character
  const m = HEX_PENDING.exec(value.slice(0, caret));
  return !!(m && m[1].length > 0 && opensAt(caret - m[0].length));
}

/**
 * Append one character to a plain string, composing as it goes. The morpheme
 * grid buffers keystrokes while a split is in flight and remembers the offsets
 * of any boundaries typed among them, so the buffer has to compose character
 * by character: composing it in one pass at the end would move the text out
 * from under those offsets.
 *
 * Returns the new string and the escape state to carry to the next character.
 */
export function composeAppend(value, ch, { escapedAt = -1, table } = {}) {
  const r = composeInsert(value, value.length, ch, { escapedAt, table });
  if (!r) return { value: value + ch, escapedAt };
  return {
    value: value.slice(0, r.start) + r.text + value.slice(r.end),
    escapedAt: r.escapedAt ?? -1,
  };
}

/**
 * Apply every code in a string at once. Used for text that never passed
 * through a keystroke: the morpheme grid buffers raw characters while a split
 * is in flight and replays them into the new cell, so the replay runs this
 * rather than losing the codes typed during the round trip.
 */
export function composeString(s, { table } = {}) {
  if (typeof s !== 'string' || !s.includes(COMPOSE_PREFIX)) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] !== COMPOSE_PREFIX) {
      out += s[i++];
      continue;
    }
    if (s[i + 1] === COMPOSE_PREFIX) {
      out += COMPOSE_PREFIX;
      i += 2;
      continue;
    }
    const hit = lookupCode(s.slice(i + 1, i + 1 + CODE_LENGTH), table);
    if (hit != null) {
      out += hit;
      i += 1 + CODE_LENGTH;
      continue;
    }
    if (s[i + 1] === HEX_INTRO) {
      const digits = s.slice(i + 2, i + 2 + HEX_LENGTH);
      if (digits.length === HEX_LENGTH && [...digits].every((d) => HEX_DIGIT.test(d))) {
        out += String.fromCodePoint(parseInt(digits, 16));
        i += 2 + HEX_LENGTH;
        continue;
      }
    }
    out += s[i++]; // a backslash that opens nothing stays as typed
  }
  return out;
}
