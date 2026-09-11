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
/**
 * Layer config key naming the metadata keys a token born of a SPLIT inherits
 * from the token it came from. Plaid honors it without knowing what the keys
 * mean; see the manual's `Metadata Preserved Across a Split`. An app declares
 * it so that a split in ANY app, including one that has never heard of these
 * keys, does not silently drop them.
 */
export const PRESERVE_ON_SPLIT_KEY = 'preserveOnSplit';

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

/**
 * Whether a project is set up for plaid-ud, from its layer structure alone.
 *
 * Two apps share this substrate and both use it for words below the
 * orthographic word, so the `syntactic-word` ROLE does not tell them apart:
 * plaid-igt tags a morpheme layer too. What is distinctive is that plaid-ud
 * hangs its annotation span layers off that token layer under its OWN `ud`
 * namespace, which no other app writes.
 *
 * Lives here rather than in either app because both need it: plaid-ud asks it
 * of its own projects and plaid-igt's admin area asks it of everyone's, and a
 * second copy of the answer in the other app is how two apps start disagreeing
 * about what a project is.
 *
 * Takes a project WITH its layers (`client.projects.get`), which is what an
 * admin project listing already returns.
 *
 * @param {object} [project] a project with `textLayers`
 * @returns {boolean}
 */
export function isUdProject(project) {
  for (const text of project?.textLayers || []) {
    for (const token of text?.tokenLayers || []) {
      if (readRole(token?.config) !== ROLES.SYNTACTIC_WORD) continue;
      for (const span of token?.spanLayers || []) {
        if (span?.config?.ud && typeof span.config.ud === 'object') return true;
      }
    }
  }
  return false;
}
