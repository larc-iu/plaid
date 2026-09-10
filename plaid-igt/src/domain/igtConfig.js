// IGT layer-config access — the single source of truth for how plaid-igt reads
// the shared substrate and its own private configuration.
//
// Two namespaces:
//  - `plaid`  — RESERVED for cross-app conventions. plaid-igt writes/reads ONLY
//               the shared layer ROLE here (config.plaid.role). Substrate layers
//               (text + token layers) are bound by role, so a project set up by
//               another Plaid app resolves the same way.
//  - `igt`    — plaid-igt's OWN private config (scope, orthographies, ignored
//               tokens, document metadata, the initialized flag, vocab fields).
//
// Role mapping: text → baseline, sentence layer → sentence, primary word layer →
// word, morpheme layer → morpheme, alignment layer → time-alignment. IGT has no
// `syntactic-word` layer (that's UD's; it's a sibling of IGT's morpheme layer
// under the shared word layer).

import { ROLES, findByRole } from '@larc-iu/plaid-client';
import { isZeroMorph } from './zeroMorph.js';

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

/** A word token layer's non-baseline orthographies: [{name}], or null. */
export const readOrthographies = (config) => readIgt(config, 'orthographies') ?? null;

/** A word token layer's ignored-tokens config: {type, ...}, or null. */
export const readIgnoredTokens = (config) => readIgt(config, 'ignoredTokens') ?? null;

// "Punctuation" for the ignore rule: Unicode punctuation and symbols, EXCEPT
// pictographs (emoji) and the zero morph. An emoji token in an object-language
// transcript is a word-like unit a linguist may well want to gloss (an
// interjection, a gesture); treating it as punctuation silently removed its
// annotation cells. ∅ is Sm, so it falls under \p{S} on the letter of the rule
// while being the most meaning-bearing character in the app: without this it
// would lose its annotation cells the same way, and trimIgnoredEdges would eat
// the zero off a form like `ta∅`.
const PUNCT_CHAR_RE = /[\p{P}\p{S}]/u;
const PICTOGRAPH_RE = /\p{Extended_Pictographic}/u;
const isPunctChar = (c) => PUNCT_CHAR_RE.test(c) && !PICTOGRAPH_RE.test(c) && !isZeroMorph(c);

/**
 * Has the project declared this character LETTER-LIKE?
 *
 * The `unicodePunctuation` rule's exception list is a list of single
 * CHARACTERS, and each one is meant to behave as a letter would: an ejective
 * or glottalization mark, an apostrophe inside a word. That is one meaning,
 * and every reader of the list honors it — the tokenizer does not break a word
 * at one (`shouldTokenizeCharacter`), `trimIgnoredEdges` does not shave one off
 * a form, and a token spelled with them is a word to be annotated rather than
 * punctuation to skip.
 *
 * Entries longer than one character cannot be letter-like and match nothing;
 * the settings screen refuses them, and any left in older config are inert.
 */
const isLetterLike = (c, cfg) =>
  cfg?.type === 'unicodePunctuation' && (cfg.whitelist || []).includes(c);

/** Punctuation for the ignore rule, minus what the project calls letter-like. */
const isIgnorableChar = (c, cfg) => isPunctChar(c) && !isLetterLike(c, cfg);

/**
 * Is a token excluded from word-level annotation under an ignored-tokens config
 * (`readIgnoredTokens` shape)? `content` is the token's surface text. Shared by
 * the editor render and reconcile so "ignored" means the same in both: ignored
 * tokens get no annotation cells and no healed morpheme.
 *
 * A token is excluded when EVERY character in it is punctuation the project has
 * not called letter-like. One letter-like character is enough to make it a
 * word: `ʼ` on its own is a word if the project spells words with it.
 */
export const isTokenIgnored = (content, cfg) => {
  if (!cfg) return false;
  if (cfg.type === 'unicodePunctuation') {
    return [...(content || '')].every((c) => isIgnorableChar(c, cfg));
  }
  if (cfg.type === 'blacklist') return (cfg.blacklist || []).includes(content);
  return false;
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
  while (start < end && isIgnorableChar(chars[start], cfg)) start++;
  while (end > start && isIgnorableChar(chars[end - 1], cfg)) end--;
  if (start >= end) return s;
  return chars.slice(start, end).join('');
};

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

const normalizeLanguage = (lang) => ({
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
 * An import writes this on the project it is filling and removes it when it
 * finishes, so a project whose import was cancelled, lost or closed is not
 * mistaken for a complete one: `{kind, source, vocabId, startedAt}`, `kind`
 * being the format ('FLEx', 'CLDF', 'ELAN', 'Plaid IGT archive'), `source` the
 * file it was reading and `vocabId` the lexicon it writes into once known.
 * Every importer resumes, so the way to clear it is to run the same import
 * again.
 */
export const IMPORT_KEY = 'import';
export const readImportState = (config) => readIgt(config, IMPORT_KEY) ?? null;

/**
 * Record that an import into this project has begun. Never fails the import.
 *
 * `vocabId` is the lexicon the run writes into, once it is known. A resume
 * reads it from here rather than looking the vocabulary up by a name it
 * recomputes, which a renamed project or a hand-named lexicon does not match.
 */
export const markImportStarted = async (client, projectId, kind, source, vocabId = null) => {
  try {
    await client.projects.setConfig(projectId, IGT_NAMESPACE, IMPORT_KEY, {
      kind,
      source: source ?? null,
      vocabId,
      startedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Could not record the import as started:', err);
  }
};

/**
 * Where an unfinished import of `kind` is picked up again (the routes are in
 * App.jsx). Null for a kind this app has no wizard for.
 */
export const importRouteFor = (kind) =>
  ({
    FLEx: '/projects/import',
    CLDF: '/projects/import-cldf',
    ELAN: '/projects/import-elan',
    'Plaid IGT archive': '/projects/import-archive',
  })[kind] ?? null;

/**
 * Record that it finished. Says whether the record went, since a project
 * that keeps it goes on opening the import wizard rather than itself.
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
export const AUTO_ANALYSIS_DEFAULTS = Object.freeze({
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
