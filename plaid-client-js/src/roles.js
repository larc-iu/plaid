/**
 * Shared layer-role vocabulary for cross-app interoperability.
 *
 * Apps that share a Plaid project agree on the *substrate* — the text and token
 * layers — by tagging each shared layer with a ROLE under the reserved `plaid`
 * config namespace (`config.plaid.role`, a scalar). Annotations stay private to
 * each app under that app's own namespace. See the Plaid manual, "Layer
 * Interoperability". The role inventory is small and fixed:
 *
 *   baseline        the primary text layer
 *   sentence        sentence token layer
 *   word            orthographic-word token layer (CoNLL-U "token")
 *   syntactic-word  grammatical words below the word (CoNLL-U "word" / MWT splits)
 *   morpheme        morpheme token layer
 *   time-alignment  media-timeline token layer
 *
 * Only these values are understood across apps; an app may store any string but
 * loses interoperability for unknown values.
 */

/** The reserved config namespace for cross-app conventions. */
export const PLAID_NAMESPACE = 'plaid';

/** The config key, under `plaid`, holding a layer's role. */
export const ROLE_KEY = 'role';

/** The fixed role inventory. */
export const ROLES = Object.freeze({
  BASELINE: 'baseline',
  SENTENCE: 'sentence',
  WORD: 'word',
  SYNTACTIC_WORD: 'syntactic-word',
  MORPHEME: 'morpheme',
  TIME_ALIGNMENT: 'time-alignment',
});

/**
 * The role recorded on a layer's `config`, or null if none.
 * @param {object} [config] a layer's `config` object
 * @returns {string|null}
 */
export function readRole(config) {
  const v = config?.[PLAID_NAMESPACE]?.[ROLE_KEY];
  return v == null ? null : v;
}

/**
 * The first layer in `layers` carrying the given role, or null. The single
 * "find a layer by its role" primitive — apps build their named finders
 * (findWordTokenLayer, etc.) on top of this.
 * @param {Array<{config?: object}>} [layers]
 * @param {string} role
 * @returns {object|null}
 */
export function findByRole(layers, role) {
  return (layers || []).find(l => readRole(l?.config) === role) || null;
}
