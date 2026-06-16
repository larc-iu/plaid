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

/** plaid-igt's private config namespace (distinct from the reserved `plaid`). */
export const IGT_NAMESPACE = 'igt';

// --- Substrate binding (by shared role) ------------------------------------

export const findBaselineTextLayer = (textLayers) => findByRole(textLayers, ROLES.BASELINE);
export const findSentenceTokenLayer = (tokenLayers) => findByRole(tokenLayers, ROLES.SENTENCE);
export const findWordTokenLayer = (tokenLayers) => findByRole(tokenLayers, ROLES.WORD);
export const findMorphemeTokenLayer = (tokenLayers) => findByRole(tokenLayers, ROLES.MORPHEME);
export const findAlignmentTokenLayer = (tokenLayers) => findByRole(tokenLayers, ROLES.TIME_ALIGNMENT);

// --- Private config (the `igt` namespace) ----------------------------------

const readIgt = (config, key) => config?.[IGT_NAMESPACE]?.[key];

/** A span layer's annotation scope: "Word" | "Morpheme" | "Sentence", or null. */
export const readScope = (config) => readIgt(config, 'scope') ?? null;

/** A word token layer's non-baseline orthographies: [{name}], or null. */
export const readOrthographies = (config) => readIgt(config, 'orthographies') ?? null;

/** A word token layer's ignored-tokens config: {type, ...}, or null. */
export const readIgnoredTokens = (config) => readIgt(config, 'ignoredTokens') ?? null;

const PUNCT_RE = /[\p{P}\p{S}]/u;
/**
 * Is a token excluded from word-level annotation under an ignored-tokens config
 * (`readIgnoredTokens` shape)? `content` is the token's surface text. Shared by
 * the editor render and reconcile so "ignored" means the same in both: ignored
 * tokens get no annotation cells and no healed morpheme.
 */
export const isTokenIgnored = (content, cfg) => {
  if (!cfg) return false;
  if (cfg.type === 'unicodePunctuation') {
    if ([...(content || '')].every((c) => PUNCT_RE.test(c))) {
      return !(cfg.whitelist || []).includes(content);
    }
    return false;
  }
  if (cfg.type === 'blacklist') return (cfg.blacklist || []).includes(content);
  return false;
};

/** A project's enabled document-metadata fields: [{name}], or null. */
export const readDocumentMetadata = (config) => readIgt(config, 'documentMetadata') ?? null;

/** Whether a project has been set up by plaid-igt. */
export const readInitialized = (config) => readIgt(config, 'initialized') === true;

/** A vocab layer's custom field schema: {field: {inline}}, or null. */
export const readVocabFields = (config) => readIgt(config, 'fields') ?? null;

// --- Built-in analysis defaults (run on demand: see domain/autoPass.js) -----

/**
 * Project defaults for the on-demand built-in analysis helpers, run from the
 * Auto-link dialog (they no longer run automatically). Machine output is
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
