// IGT layer-config access — the single source of truth for how plaid-igt reads
// the shared substrate and its own private configuration.
//
// Two namespaces:
//  - `plaid`  — RESERVED for cross-app conventions: the shared layer ROLE
//               (config.plaid.role), what a split keeps, and the word layer's
//               splitOnSpace and ignored-tokens rule. Substrate layers (text +
//               token layers) are bound by role, so a project set up by another
//               Plaid app resolves the same way.
//  - `igt`    — plaid-igt's OWN private config (scope, orthographies, document
//               metadata, the initialized flag, vocab fields).
//
// Role mapping: text → baseline, sentence layer → sentence, primary word layer →
// word, morpheme layer → morpheme, alignment layer → time-alignment. IGT has no
// `syntactic-word` layer (that's UD's; it's a sibling of IGT's morpheme layer
// under the shared word layer).

import { ROLES, findByRole, readIgnoredTokens } from '@larc-iu/plaid-client';
import { ZERO_MORPH } from './zeroMorph.js';
// The ignore rule itself is shared (plaid-ui domain/igtWordBreaks.js): another
// app's Tokenize makes a token only of what it ignores. By the real path, as
// plain node (the Python mirrors) loads this file too.
import { isIgnoredCharacter, isTokenIgnored } from '../../../plaid-ui/src/domain/igtWordBreaks.js';

export { isTokenIgnored };

/** A word token layer's ignored-tokens rule (`config.plaid.ignoredTokens`): {type, ...}, or null. */
export { readIgnoredTokens };

/** plaid-igt's private config namespace (distinct from the reserved `plaid`). */
export const IGT_NAMESPACE = 'igt';

// --- Substrate binding (by shared role) ------------------------------------

export const findBaselineTextLayer = (textLayers) => findByRole(textLayers, ROLES.BASELINE);
export const findSentenceTokenLayer = (tokenLayers) => findByRole(tokenLayers, ROLES.SENTENCE);
export const findWordTokenLayer = (tokenLayers) => findByRole(tokenLayers, ROLES.WORD);
export const findMorphemeTokenLayer = (tokenLayers) => findByRole(tokenLayers, ROLES.MORPHEME);
export const findAlignmentTokenLayer = (tokenLayers) =>
  findByRole(tokenLayers, ROLES.TIME_ALIGNMENT);

// --- Private config (the `igt` namespace) ----------------------------------

const readIgt = (config, key) => config?.[IGT_NAMESPACE]?.[key];

/** A span layer's annotation scope: "Word" | "Morpheme" | "Sentence", or null. */
export const readScope = (config) => readIgt(config, 'scope') ?? null;

/**
 * The writing system a span layer's values are in ("pmy"), or null.
 *
 * Plaid's substrate has no notion of what language anything is in, and for a
 * long time an annotation field had nowhere to say. The FLEx importer knew (a
 * project glossed in three languages gets three fields) and dropped it, so
 * both FLEx exporters had to guess from the field's NAME: the suffix in
 * "Gloss (nl)", and for the unsuffixed field, elimination. Written down, there
 * is nothing to guess. Parallel to a vocabulary's `config.igt.fields.<name>.lang`.
 */
export const readFieldLang = (config) => readIgt(config, 'lang') ?? null;

/** Where a span layer keeps its Lexicon field (domain/lexiconField.js). */
export const LEXICON_FIELD_KEY = 'lexiconField';

/**
 * The lexicon entry field a span layer's values pair with ("gloss"), or null
 * for none. See domain/lexiconField.js.
 */
export const readLexiconField = (config) => readIgt(config, LEXICON_FIELD_KEY) ?? null;

/** Where a sentence field keeps its role (domain/sentenceRole.js). */
export const SENTENCE_ROLE_KEY = 'sentenceRole';

/** What a sentence field can hold: its free translation, literal translation or a note. */
export const SENTENCE_ROLES = Object.freeze({
  TRANSLATION: 'translation',
  LITERAL_TRANSLATION: 'literalTranslation',
  NOTE: 'note',
});
const SENTENCE_ROLE_VALUES = new Set(Object.values(SENTENCE_ROLES));

/**
 * A sentence field's role (SENTENCE_ROLES), or null for none. What the
 * exporters, the service defaults and the importers read to know which
 * sentence field is the translation, never the field's name.
 */
export const readSentenceRole = (config) => {
  const role = readIgt(config, SENTENCE_ROLE_KEY);
  return SENTENCE_ROLE_VALUES.has(role) ? role : null;
};

/**
 * A field's record as the `[key, value]` cells of its span layer's `igt`
 * config, in the order they are written: its scope, its language when
 * `field.lang` says one, its Lexicon field when `field.lexiconField` names
 * one, and its role when a sentence field's `sentenceRole` names one. Every
 * path that makes a field writes these, so a key added to the record is added
 * here once.
 */
export const fieldConfigCells = (field) => {
  const cells = [['scope', field.scope]];
  if (field.lang) cells.push(['lang', field.lang]);
  if (field.lexiconField) cells.push([LEXICON_FIELD_KEY, field.lexiconField]);
  if (field.scope === 'Sentence' && field.sentenceRole) {
    cells.push([SENTENCE_ROLE_KEY, field.sentenceRole]);
  }
  return cells;
};

/**
 * The token layer a field of `scope` is made under: the sentence layer, the
 * morpheme layer or the word layer, of `ids` ({sentence, morpheme, word}).
 */
export const parentLayerFor = (scope, ids) =>
  scope === 'Sentence' ? ids.sentence : scope === 'Morpheme' ? ids.morpheme : ids.word;

/** A word token layer's non-baseline orthographies: [{name}], or null. */
export const readOrthographies = (config) => readIgt(config, 'orthographies') ?? null;

// A word's spelling in an orthography is stored in its token metadata under
// this prefix plus the orthography's name. Every reader and writer of that key
// goes through the three helpers below.
const ORTHOGRAPHY_KEY_PREFIX = 'orthog:';

/** The token-metadata key a word's spelling in orthography `name` is stored under. */
export const orthographyKey = (name) => `${ORTHOGRAPHY_KEY_PREFIX}${name}`;

/** Whether a token-metadata key holds a spelling in some orthography. */
export const isOrthographyKey = (key) =>
  typeof key === 'string' && key.startsWith(ORTHOGRAPHY_KEY_PREFIX);

/** The orthography an orthography key names (the inverse of orthographyKey). */
export const orthographyName = (key) => key.slice(ORTHOGRAPHY_KEY_PREFIX.length);

/**
 * The word token layer's config key (under `igt`) for whether a Baseline save
 * gives the text it adds words from the built-in tokenizer. On unless it holds
 * `false`, so a project that never set it tokenizes.
 */
export const TOKENIZE_NEW_TEXT_KEY = 'tokenizeNewText';
export const readTokenizeNewText = (config) => readIgt(config, TOKENIZE_NEW_TEXT_KEY) !== false;

/**
 * The ignored-tokens rule a new project starts with: a word made only of
 * punctuation is skipped. `DEFAULT_IGNORED_TOKENS` is the stored shape, the
 * word layer's `config.plaid.ignoredTokens`. `defaultIgnoredTokensSetup()` is the
 * setup wizard's form of it, which project setup turns into the stored one; a
 * fresh object each time, since the wizard edits what it is given.
 */
export const DEFAULT_IGNORED_TOKENS = Object.freeze({
  type: 'unicodePunctuation',
  whitelist: Object.freeze([]),
  blacklist: Object.freeze([]),
});

/**
 * The two names the edited shape's `mode` may take. Both the edited shape and
 * the stored one hold BOTH lists, so switching mode and back, saved or not,
 * finds the other list as it was left. Only `type`'s list is in force.
 */
export const IGNORED_TOKEN_MODES = Object.freeze({
  punctuation: 'unicode-punctuation',
  explicit: 'explicit-list',
});

/**
 * The stored rule as the setup wizard and the settings screen edit it. With
 * nothing stored, the default rule.
 *
 * ONE TRANSLATION. These two functions are the only place the two shapes meet:
 * setup, the settings screen and the archive importer each had their own copy,
 * one of them already spelling the explicit mode differently, and a third rule
 * would have had to be taught to all of them. A fresh object every call, since
 * the caller edits what it is given.
 */
export const ignoredTokensSetup = (stored) => ({
  mode:
    stored?.type === 'blacklist' ? IGNORED_TOKEN_MODES.explicit : IGNORED_TOKEN_MODES.punctuation,
  unicodePunctuationExceptions: [...(stored?.whitelist || [])],
  explicitIgnoredTokens: [...(stored?.blacklist || [])],
});

/** The other way: what goes on the word layer, both lists with `type` naming
 * the one in force. Anything but an explicit list is the punctuation rule,
 * which is the default and the safe fall-through. */
export const storedIgnoredTokens = (setup) => ({
  type: setup?.mode === IGNORED_TOKEN_MODES.explicit ? 'blacklist' : 'unicodePunctuation',
  whitelist: setup?.unicodePunctuationExceptions || [],
  blacklist: setup?.explicitIgnoredTokens || [],
});

export const defaultIgnoredTokensSetup = () => ignoredTokensSetup(DEFAULT_IGNORED_TOKENS);

/**
 * A query value spec (`{regex}`) that a word token's surface matches and an
 * ignored token's does not (`isTokenIgnored`), for core's queries, or null when
 * the rule ignores nothing. Core compiles it with Java's Unicode tables, which
 * can trail the generated one here by a version for characters new in it.
 */
export const wordValueSpec = (cfg) => {
  const cp = (c) => `\\x{${c.codePointAt(0).toString(16)}}`;
  if (cfg?.type === 'unicodePunctuation') {
    const letters = [ZERO_MORPH, ...(cfg.whitelist || [])].filter((c) => [...c].length === 1);
    return {
      regex: `[^\\p{P}\\p{S}]|[\\p{IsExtended_Pictographic}${letters.map(cp).join('')}]`,
    };
  }
  if (cfg?.type === 'blacklist' && (cfg.blacklist || []).length) {
    const listed = cfg.blacklist.map((w) => [...w].map(cp).join(''));
    return { regex: `^(?!(?:${listed.join('|')})\\z)` };
  }
  return null;
};

/**
 * Strip leading/trailing punctuation from a surface form using the SAME rule
 * the ignored-tokens config applies to whole tokens — for deriving a lexicon
 * entry's form from a word like `derechos.` or `¿Qué`. A letter-like character
 * is never trimmed, at either edge: a word that begins with a glottal mark
 * begins with it in the lexicon too. Under `blacklist` (a whole-token list) or
 * no config nothing is trimmed. Never trims a form down to empty: an
 * all-punctuation form is returned as-is.
 */
export const trimIgnoredEdges = (content, cfg) => {
  const s = content ?? '';
  if (!cfg || cfg.type !== 'unicodePunctuation') return s;
  const chars = [...s];
  let start = 0;
  let end = chars.length;
  while (start < end && isIgnoredCharacter(chars[start], cfg)) start++;
  while (end > start && isIgnoredCharacter(chars[end - 1], cfg)) end--;
  if (start >= end) return s;
  return chars.slice(start, end).join('');
};

/**
 * The document metadata field an ELAN import records a recording's original
 * file name in, and the ELAN export names the recording by.
 */
export const MEDIA_FILE_FIELD = 'Media file';

/** A project's enabled document-metadata fields: [{name}], or null. */
// Predefined metadata fields common in linguistic annotation: name -> enabled
// by default. The settings screen shows the switched-off ones.
export const PREDEFINED_FIELDS = {
  Date: true,
  Speakers: true,
  Location: true,
  Genre: false,
  'Recording Quality': false,
  Transcriber: false,
};

export const readDocumentMetadata = (config) => readIgt(config, 'documentMetadata') ?? null;

/**
 * A project's own compose codes: `{codes: [{code, char, description?}]}`, or
 * null. These LAYER OVER the built-in Praat codes rather than replacing them,
 * so a project that binds one code still has the other four hundred. See
 * domain/composeConfig.js for the merge.
 */
export const readCompose = (config) => readIgt(config, 'compose') ?? null;

// --- Language identity -----------------------------------------------------

/**
 * A project's two languages, stored at `config.igt.languages`:
 *   object — the language being documented (the baseline text)
 *   meta   — the language glosses and translations are written in
 *
 * Plaid's substrate has no notion of what language a text is in, because a
 * layer is just an offset space. That is fine internally and fatal on the way
 * out: CLDF's LanguageTable, keyed by Glottocode, is what lets an exported
 * dataset be aligned with anything else in the world. The .flextext exporter
 * asks for the same fact per preset and defaults it to `und`, which is the
 * weaker version of this. Seeded from here for new presets (see presets.js).
 *
 * Every field is optional. An unset language still exports, under a derived
 * identifier, with a warning.
 *
 * `tag` is the language's WRITING-SYSTEM TAG, the string FLEx and ELAN files
 * label their text with (`oni`, `pmy`, `en`, or a private one like
 * `qaa-x-abc`). It is a different fact from the ISO code: the code identifies
 * the language, the tag names the writing system a file is in, and a FLEx
 * project can use a tag no ISO code matches. The FLEx exporter's defaults
 * come from the tag; a field's own `config.igt.lang` is the same kind of
 * value, per field.
 */
export const EMPTY_LANGUAGE = Object.freeze({
  name: '',
  glottocode: '',
  iso639P3: '',
  tag: '',
  latitude: null,
  longitude: null,
});

const str = (v) => (typeof v === 'string' ? v.trim() : '');
// Coordinates round-trip through JSON as numbers but reach us as strings from
// the settings inputs. Anything non-finite (including '') becomes null so the
// CSV cell is empty rather than "NaN".
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** One language record, fully shaped, from whatever a caller has. */
export const normalizeLanguage = (lang) => ({
  name: str(lang?.name),
  glottocode: str(lang?.glottocode),
  iso639P3: str(lang?.iso639P3),
  tag: str(lang?.tag),
  latitude: num(lang?.latitude),
  longitude: num(lang?.longitude),
});

/** A project's {object, meta} languages, always fully shaped. */
export const readLanguages = (config) => {
  const raw = readIgt(config, 'languages') || {};
  return { object: normalizeLanguage(raw.object), meta: normalizeLanguage(raw.meta) };
};

/** Has this language been filled in at all? */
export const hasLanguageIdentity = (lang) =>
  !!(lang?.name || lang?.glottocode || lang?.iso639P3 || lang?.tag);

/**
 * A project's known speaker labels (diarization) — a de-duped suggestion cache
 * appended to whenever a new speaker is set on an alignment token, so the
 * speaker autocomplete can surface names used in OTHER documents. It is a plain
 * `[string]` (speakers are opaque strings, no relationality); the live source of
 * truth is always the `speaker` metadata on alignment tokens. Returns [].
 */
export const readSpeakers = (config) => readIgt(config, 'speakers') ?? [];

/** Whether a project has been set up by plaid-igt. */
export const readInitialized = (config) => readIgt(config, 'initialized') === true;

// --- An import in flight ---------------------------------------------------

/**
 * An import writes this on the project it is filling when the project is made
 * and removes it once the whole import has run, so a project whose import was
 * stopped, failed or was closed does not open as if it were complete:
 * `{kind, source, startedAt}`, `kind` being the format ('FLEx', 'FLEx
 * .flextext', 'CLDF', 'ELAN', 'Plaid IGT archive') and `source` the file it
 * was reading. Such a project is only deleted, never finished.
 */
const IMPORT_KEY = 'import';
export const readImportState = (config) => readIgt(config, IMPORT_KEY) ?? null;

/** Record that an import into this project has begun. Never fails the import. */
export const markImportStarted = async (client, projectId, kind, source) => {
  try {
    await client.projects.setConfig(projectId, IGT_NAMESPACE, IMPORT_KEY, {
      kind,
      source: source ?? null,
      startedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Could not record the import as started:', err);
  }
};

/**
 * Record that it finished. Says whether the record went, since a project
 * that keeps it does not open.
 */
export const markImportFinished = async (client, projectId) => {
  try {
    await client.projects.deleteConfig(projectId, IGT_NAMESPACE, IMPORT_KEY);
    return true;
  } catch (err) {
    console.error('Could not record the import as finished:', err);
    return false;
  }
};

/** A vocab layer's custom field schema: {field: {inline}}, or null. */
export const readVocabFields = (config) => readIgt(config, 'fields') ?? null;

// --- Built-in analysis defaults (run on demand: see domain/autoPass.js) -----

/**
 * Project defaults for the on-demand built-in analysis helpers, run from the
 * Auto-analyze dialog (they no longer run automatically). Machine output is
 * stamped with provenance and rendered as unverified, so the safety story is
 * the visual distinction + verify-on-edit.
 *   copyAnalyses     — pre-check the dialog's "copy previous analyses" opt-in
 *   copySegmentation — include the morpheme breakdown (forms + types) in copies
 *   copyLinks        — include vocab links in copies
 *   copyFields       — include annotation values (glosses etc.) in copies
 * (The auto-linker itself always runs when the built-in method is chosen; its
 * method/default lives in the Auto-link-vocabulary spot, not here.)
 */
const AUTO_ANALYSIS_DEFAULTS = Object.freeze({
  copyAnalyses: true,
  copySegmentation: true,
  copyLinks: true,
  copyFields: true,
});

/** The project's autoAnalysis config merged over the defaults. */
export const resolveAutoAnalysis = (config) => ({
  ...AUTO_ANALYSIS_DEFAULTS,
  ...(readIgt(config, 'autoAnalysis') || {}),
});
