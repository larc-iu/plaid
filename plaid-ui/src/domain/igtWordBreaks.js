// Where IGT's built-in tokenizer breaks a word, under the ignored-tokens
// config on the shared word layer (`config.plaid.ignoredTokens`, read by
// plaid-client's `readIgnoredTokens`). It is here, in
// the shared package, because another app reads it too: plaid-ud's Tokenize
// on a text that has words adds tokens only where this rule leaves a run out
// of a word, so a token it adds never splits what IGT would make one word and
// never takes a character the project calls letter-like (ruling 29,
// 2026-10-16). plaid-igt's tokenizer (`utils/tokenizationUtils.js`) reads it
// from here, so the two cannot drift.
//
// And which characters IGT ignores, which is a different question: a word
// breaks at `‼` or a soft hyphen, but a token of one is still a word to IGT,
// since neither is punctuation to the ignore rule. plaid-igt's
// `isTokenIgnored` (domain/igtConfig.js) is this file's, and plaid-ud's gap
// fill makes a token only of characters IGT ignores, so a token it adds is
// one IGT reads as text, exactly as the untokenized run (REV7-IGT-2).
//
// No bare imports: plaid-ud's node suite and the Python mirrors' plain node
// load this by its real path.

import { isPictograph, isPunctOrSymbol, isWordBreak } from './punctuationClasses.js';

// The zero morph as plaid-igt spells it (domain/zeroMorph.js): FLEx's ∅.
const ZERO_MORPH = '\u2205';

/**
 * Does this character part words as whitespace? JavaScript's `\s`, and NEL
 * (U+0085), a line break that `\s` leaves out. plaid-core (`space?`), FLEx
 * and the sentence rules read NEL as whitespace, so the tokenizer does too.
 *
 * @param {string} c - Single character
 * @returns {boolean}
 */
export const isWordSpace = (c) => c === '\u0085' || /\s/u.test(c);

/**
 * Is this character a token boundary for the built-in tokenizer?
 *
 * NOT the same as \p{P}, despite the name: the generated class
 * (tools/punctuationClasses.mjs in plaid-igt) is \p{P} PLUS the ASCII and
 * Latin-1 symbols and the soft hyphen, $ + < = > ^ ` | ~ ¢ £ ¤ ¥ ¦ and
 * friends, 24 characters in all. "=" in particular is this app's clitic
 * marker. Nor is it [\p{P}\p{S}] (the ignore rule's class below), which adds
 * every arrow, math operator and box-drawing character. Core's Tokenize new
 * text cuts at the same generated class.
 *
 * @param {string} char - Single character to check
 * @returns {boolean} True if the character should break a token
 */
export function isUnicodePunctuation(char) {
  return !!char && Array.from(char).length === 1 && isWordBreak(char);
}

/**
 * Should this character break a token, under the project's ignored-tokens
 * config?
 *
 * Under `unicodePunctuation`, punctuation breaks EXCEPT the characters the
 * project has declared letter-like (`config.whitelist`, single characters):
 * those join the word around them, so `ab'cd` is one word where a project
 * spells words with an apostrophe. `domain/igtConfig.js` reads the same list
 * for the same reason, and the two must not drift — a character that joins a
 * word must not then be shaved off its lexicon form.
 *
 * The one thing that does differ is WHICH characters are punctuation to begin
 * with: this file's `isUnicodePunctuation` is the curated break class, while
 * igtConfig's is `[\p{P}\p{S}]` minus pictographs. A character in neither list
 * never breaks and is never trimmed, which is the behavior a letter wants
 * anyway.
 *
 * @param {string} char - Single character to check
 * @param {Object} config - Ignored tokens configuration
 * @returns {boolean} True if character should cause token boundary
 */
export function shouldTokenizeCharacter(char, config) {
  if (!config) return isUnicodePunctuation(char);

  if (config.type === 'unicodePunctuation') {
    if (isUnicodePunctuation(char)) {
      // Letter-like: joins the word instead of breaking it.
      return !config.whitelist?.includes(char);
    }
    return false;
  } else if (config.type === 'blacklist') {
    // Explicit blacklist mode - tokenize on characters in the blacklist
    return config.blacklist?.includes(char) || false;
  }

  return isUnicodePunctuation(char);
}

// "Punctuation" for the ignore rule: Unicode punctuation and symbols, EXCEPT
// pictographs (emoji) and the zero morph. An emoji token in an object-language
// transcript is a word-like unit a linguist may well want to gloss (an
// interjection, a gesture); treating it as punctuation silently removed its
// annotation cells. ∅ is Sm, so it falls under \p{S} on the letter of the rule
// while being the most meaning-bearing character in IGT: without this it
// would lose its annotation cells the same way, and trimIgnoredEdges would eat
// the zero off a form like `ta∅`.
//
// Both classes come from one generated table (punctuationClasses.js), never
// the runtime's `\p{}`: those move with the browser's Unicode version (★ is a
// pictograph in Unicode 16 and not in 17), and a word reference counts words
// past the ignored tokens, so it would mean different words in different
// browsers and to the agent. plaid-client-py reads the same table.
const isPunctChar = (c) => isPunctOrSymbol(c) && !isPictograph(c) && c !== ZERO_MORPH;

/**
 * Has the project declared this character LETTER-LIKE?
 *
 * The `unicodePunctuation` rule's exception list is a list of single
 * CHARACTERS, and each one is meant to behave as a letter would: an ejective
 * or glottalization mark, an apostrophe inside a word. That is one meaning,
 * and every reader of the list honors it: the tokenizer does not break a word
 * at one (`shouldTokenizeCharacter`), IGT's `trimIgnoredEdges` does not shave
 * one off a form, and a token spelled with them is a word to be annotated
 * rather than punctuation to skip.
 *
 * Entries longer than one character cannot be letter-like and match nothing;
 * the settings screen refuses them, and any left in older config are inert.
 */
const isLetterLike = (c, cfg) =>
  cfg?.type === 'unicodePunctuation' && (cfg.whitelist || []).includes(c);

/**
 * Does IGT ignore this character under the punctuation rule? Punctuation, minus
 * what the project calls letter-like. Under an explicit list (`blacklist`,
 * whole tokens) or no config, no single character is: ask `isTokenIgnored`.
 *
 * @param {string} c - Single character
 * @param {Object|null} cfg - The word layer's ignored-tokens config
 */
export const isIgnoredCharacter = (c, cfg) =>
  cfg?.type === 'unicodePunctuation' && isPunctChar(c) && !isLetterLike(c, cfg);

/**
 * Is a token excluded from word-level annotation under an ignored-tokens config
 * (`readIgnoredTokens` shape)? `content` is the token's surface text. IGT's
 * editor render and reconcile read it, so "ignored" means the same in both:
 * ignored tokens get no annotation cells and no healed morpheme. Another app
 * makes a token in an IGT project's word layer only where this holds.
 *
 * A token is excluded when EVERY character in it is punctuation the project has
 * not called letter-like. One letter-like character is enough to make it a
 * word: `ʼ` on its own is a word if the project spells words with it.
 */
export const isTokenIgnored = (content, cfg) => {
  if (!cfg) return false;
  if (cfg.type === 'unicodePunctuation') {
    return [...(content || '')].every((c) => isIgnoredCharacter(c, cfg));
  }
  if (cfg.type === 'blacklist') return (cfg.blacklist || []).includes(content);
  return false;
};
