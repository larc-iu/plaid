// Where IGT's built-in tokenizer breaks a word, under the ignored-tokens
// config on the shared word layer (`config.igt.ignoredTokens`). It is here, in
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

import { isPictograph, isPunctOrSymbol } from './punctuationClasses.js';

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
 * NOT the same as \p{P}, despite the name, and the difference is deliberate:
 * the class below is \p{P} PLUS the ASCII and Latin-1 symbols and the soft
 * hyphen — $ + < = > ^ ` | ~ ¢ £ ¤ ¥ ¦ and friends, 24 characters in all. Those
 * are the symbols that turn up in transcription and want to break a token, and
 * "=" in particular is this app's clitic marker.
 *
 * So do not "simplify" this to /\p{P}/u. That drops all 24, silently changing
 * how every document tokenizes from then on. The other tempting swap,
 * /[\p{P}\p{S}]/u (what domain/igtConfig.js uses to decide which whole tokens
 * get annotation cells — a related but different question), goes the other way
 * and adds ~6,500 characters: every arrow, math operator, box-drawing and CJK
 * symbol block.
 *
 * The ranges are a hand-maintained snapshot and have drifted before: U+111C9
 * (Sharada Sandhi Mark, a combining mark) and U+111DA (Sharada Ekam, a letter)
 * were both in here, neither can stand alone as punctuation, and the combining
 * mark is what no-misleading-character-class was flagging.
 *
 * @param {string} char - Single character to check
 * @returns {boolean} True if the character should break a token
 */
export function isUnicodePunctuation(char) {
  if (!char || Array.from(char).length !== 1) return false;

  const punctuationRegex =
    /[\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E\u00A1-\u00A9\u00AB-\u00B1\u00B4\u00B6-\u00B8\u00BB\u00BF\u037E\u0387\u055A-\u055F\u0589-\u058A\u05BE\u05C0\u05C3\u05C6\u05F3-\u05F4\u0609-\u060A\u060C-\u060D\u061B\u061E-\u061F\u066A-\u066D\u06D4\u0700-\u070D\u07F7-\u07F9\u0830-\u083E\u085E\u0964-\u0965\u0970\u09FD\u0A76\u0AF0\u0C77\u0C84\u0DF4\u0E4F\u0E5A-\u0E5B\u0F04-\u0F12\u0F14\u0F3A-\u0F3D\u0F85\u0FD0-\u0FD4\u0FD9-\u0FDA\u104A-\u104F\u10FB\u1360-\u1368\u1400\u166E\u169B-\u169C\u16EB-\u16ED\u1735-\u1736\u17D4-\u17D6\u17D8-\u17DA\u1800-\u180A\u1944-\u1945\u1A1E-\u1A1F\u1AA0-\u1AA6\u1AA8-\u1AAD\u1B5A-\u1B60\u1BFC-\u1BFF\u1C3B-\u1C3F\u1C7E-\u1C7F\u1CC0-\u1CC7\u1CD3\u2010-\u2027\u2030-\u2043\u2045-\u2051\u2053-\u205E\u207D-\u207E\u208D-\u208E\u2308-\u230B\u2329-\u232A\u2768-\u2775\u27C5-\u27C6\u27E6-\u27EF\u2983-\u2998\u29D8-\u29DB\u29FC-\u29FD\u2CF9-\u2CFC\u2CFE-\u2CFF\u2D70\u2E00-\u2E2E\u2E30-\u2E4F\u2E52-\u2E5D\u3001-\u3003\u3008-\u3011\u3014-\u301F\u3030\u303D\u30A0\u30FB\uA4FE-\uA4FF\uA60D-\uA60F\uA673\uA67E\uA6F2-\uA6F7\uA874-\uA877\uA8CE-\uA8CF\uA8F8-\uA8FA\uA8FC\uA92E-\uA92F\uA95F\uA9C1-\uA9CD\uA9DE-\uA9DF\uAA5C-\uAA5F\uAADE-\uAADF\uAAF0-\uAAF1\uABEB\uFD3E-\uFD3F\uFE10-\uFE19\uFE30-\uFE52\uFE54-\uFE61\uFE63\uFE68\uFE6A-\uFE6B\uFF01-\uFF03\uFF05-\uFF0A\uFF0C-\uFF0F\uFF1A-\uFF1B\uFF1F-\uFF20\uFF3B-\uFF3D\uFF3F\uFF5B\uFF5D\uFF5F-\uFF65\u{10100}-\u{10102}\u{1039F}\u{103D0}\u{1056F}\u{10857}\u{1091F}\u{1093F}\u{10A50}-\u{10A58}\u{10A7F}\u{10AF0}-\u{10AF6}\u{10B39}-\u{10B3F}\u{10B99}-\u{10B9C}\u{10F55}-\u{10F59}\u{11047}-\u{1104D}\u{110BB}-\u{110BC}\u{110BE}-\u{110C1}\u{11140}-\u{11143}\u{11174}-\u{11175}\u{111C5}-\u{111C8}\u{111DD}\u{111DB}\u{11238}-\u{1123D}\u{112A9}\u{1144B}-\u{1144F}\u{1145A}-\u{1145B}\u{1145D}\u{114C6}\u{115C1}-\u{115D7}\u{11641}-\u{11643}\u{11660}-\u{1166C}\u{1173C}-\u{1173E}\u{1183B}\u{11944}-\u{11946}\u{119E2}\u{11A3F}-\u{11A46}\u{11A9A}-\u{11A9C}\u{11A9E}-\u{11AA2}\u{11C41}-\u{11C45}\u{11C70}-\u{11C71}\u{11EF7}-\u{11EF8}\u{12470}-\u{12474}\u{16A6E}-\u{16A6F}\u{16AF5}\u{16B37}-\u{16B3B}\u{16B44}\u{16E97}-\u{16E9A}\u{1BC9F}\u{1DA87}-\u{1DA8B}\u{1E95E}-\u{1E95F}]/u;

  return punctuationRegex.test(char);
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

/** The word layer's ignored-tokens config, or null when it has none. */
export const readIgnoredTokensOf = (layerConfig) => layerConfig?.igt?.ignoredTokens ?? null;

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
 * Is this character punctuation to plaid-core's text rules (its `punct?`,
 * which reads the project's rule as `ignored-letter-like` does)? A word token
 * made only of it takes no text typed against it, and text typed right after
 * it with no whitespace goes to the sentence after. Punctuation, minus what
 * the project's rule calls letters: under the punctuation rule its
 * letter-like characters, under an explicit list every character but the
 * entries of one character, since the tokenizer breaks a word only at those.
 * Under no rule, all punctuation. "Tokenize new text" reads it to foresee
 * where core puts the text a save types.
 *
 * @param {string} c - Single character
 * @param {Object|null} cfg - The word layer's ignored-tokens config
 */
export const isTextPunctuation = (c, cfg) => {
  if (!isPunctChar(c)) return false;
  if (cfg?.type === 'blacklist') return (cfg.blacklist || []).includes(c);
  return !isLetterLike(c, cfg);
};

/**
 * Is a token excluded from word-level annotation under an ignored-tokens config
 * (`readIgnoredTokensOf` shape)? `content` is the token's surface text. IGT's
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
