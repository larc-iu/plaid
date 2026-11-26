// Respelling a word in place: the text write Bulk Edit's Respell words sends
// (components/projects/bulk), and the rules the Analyze grid's Respell box
// holds a new spelling to (R51, Luke 2026-10-26). Offsets are code points.

import { isTokenIgnored, readIgnoredTokens } from './igtConfig.js';
import { t, msg } from '@ui/lib/i18n.js';

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

// What `respellRefusal` answers for a spelling that is the word's own.
export const RESPELL_UNCHANGED = 'unchanged';

// The refusals, as the box shows them: messages, which `respellRefusal`
// answers translated.
export const RESPELL_EMPTY = msg('Type at least one character.');
export const RESPELL_SPACE = msg('No spaces or line breaks. Use Tokenize to split a word.');
export const RESPELL_MARK = msg('Start with a letter, not a combining mark.');
export const RESPELL_IGNORED = msg('Ignored token, not a word.');

// Whitespace and line breaks, NEL and the Unicode separators included (JS \s
// leaves out U+0085).
const SPACE = /[\s\u0085]/u;

/** The ignored-tokens rule of a document's word layer, for `respellRefusal`. */
export const respellIgnoredRule = (layerInfo) =>
  readIgnoredTokens(layerInfo?.primaryTokenLayer?.config);

/** The spelling a respell sends for `typed`: composed (NFC), as text is stored. */
export const respelling = (typed) => String(typed ?? '').normalize('NFC');

/**
 * Why `typed` cannot respell the word `old`: one of the messages above, translated,
 * `RESPELL_UNCHANGED` when it spells the word as it is (canonically
 * equivalent text is the same spelling, and nothing is sent), or null when it
 * may be sent. A spelling starting with a combining mark is refused: the
 * server gives those marks to the letter before the word, outside it. So is
 * one the word layer's ignored-tokens rule (`ignored`, readIgnoredTokens'
 * shape) reads as no word: the word would leave the grid with its analysis.
 */
export function respellRefusal(old, typed, ignored = null) {
  const value = respelling(typed);
  if (value === '') return t(RESPELL_EMPTY);
  if (SPACE.test(value)) return t(RESPELL_SPACE);
  if (/^\p{M}/u.test(value)) return t(RESPELL_MARK);
  if (isTokenIgnored(value, ignored)) return t(RESPELL_IGNORED);
  if (value === respelling(old)) return RESPELL_UNCHANGED;
  return null;
}
