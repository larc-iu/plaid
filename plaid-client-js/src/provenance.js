/**
 * Provenance: the cross-app convention for distinguishing machine-provided
 * from human-labeled information, expressed as flat metadata keys on
 * annotation entities (spans, relations, vocab links, optionally tokens).
 * Flat scalar keys — the query engine matches flat metadata well, nested
 * objects poorly.
 *
 * Three states (the PRESENCE of the `prov` key, not its value, is the
 * discriminator; absent keys mean "human"):
 *
 *   human              — no prov keys; a person made it.
 *   machine            — { prov: 'inferred', provSource: '<producer>' };
 *                        an algorithm/service made it, no human has vouched.
 *   verified           — same + { provConfirmed: true }; machine-made and a
 *                        human confirmed (or edited) it. provSource stays so
 *                        machine origin remains traceable.
 *
 * The write contract every machine writer must follow:
 *   1. Machine writers may freely replace MACHINE (unverified) material.
 *   2. Machine writers must never modify or delete human or verified
 *      material unless explicitly told to overwrite (an explicit, per-run,
 *      user-facing opt-in — for services, a declared boolean `overwrite`
 *      parameter).
 *   3. Any human edit of a machine annotation verifies it: the edit also
 *      stamps { provConfirmed: true } (see verifyOnEdit).
 *
 * Producer naming: 'service:<serviceId>' for services (use serviceSource),
 * 'rule:<name>' for built-in rule algorithms, app-specific ids like
 * 'gloss:doc-frequency' or 'flex-import' otherwise.
 *
 * PREDICTION EXTRAS. A producer may also record how confident it was and
 * what else it considered, in two reserved slots split along the
 * queryability line:
 *   - provProb: ONE flat number in [0, 1] — the producer's probability for
 *     the value it chose. Flat scalars are what the query engine filters
 *     and orders on, so "review the least-confident machine output first"
 *     is an ordinary query. Omit it unless you can honestly produce a
 *     probability (a raw logprob is NOT one — put it in provDetail).
 *   - provDetail: ONE open map for everything else — top-k alternatives or
 *     distributions, model name/version, raw scores. Deliberately nested
 *     (not queryable); keep it small (top-k, not whole-vocabulary dumps).
 * Both describe the machine's ORIGINAL prediction. They are kept after
 * human edits (history is valuable), so a consumer must not present
 * provProb as confidence in the CURRENT value once the entity is verified
 * (provConfirmed is exactly the flag to check).
 */

/** The flat metadata keys of the provenance convention. */
export const PROV = Object.freeze({
  /** 'inferred' when produced by an algorithm/service; absent = human. */
  key: 'prov',
  /** Which producer, e.g. 'service:<id>', 'rule:precedent-or-unique'. */
  sourceKey: 'provSource',
  /** true once a human confirmed (or edited) the inferred value. */
  confirmedKey: 'provConfirmed',
  /** Producer's probability ([0,1]) for the chosen value. Flat = queryable. */
  probKey: 'provProb',
  /** Open map of producer extras (alternatives, model version, raw scores). */
  detailKey: 'provDetail',
  /** The (currently only) value of `prov`. Presence, not value, decides. */
  INFERRED: 'inferred',
});

/** The three provenance states returned by provState. */
export const PROV_STATES = Object.freeze({
  HUMAN: 'human',
  MACHINE: 'machine',
  VERIFIED: 'verified',
});

/**
 * The metadata fragment a machine writer merges into everything it creates.
 * @param {string} source - producer id, e.g. serviceSource(serviceId)
 * @param {Object} [extras] - optional prediction extras:
 * @param {number} [extras.prob] - probability in [0,1] for the chosen value
 *   (omit unless it honestly is one — raw scores go in detail)
 * @param {Object} [extras.detail] - open map of producer extras (top-k
 *   alternatives, model version, raw scores; keep it small)
 */
export const stampInferred = (source, { prob, detail } = {}) => ({
  [PROV.key]: PROV.INFERRED,
  [PROV.sourceKey]: source,
  ...(prob !== undefined && prob !== null ? { [PROV.probKey]: prob } : {}),
  ...(detail ? { [PROV.detailKey]: detail } : {}),
});

/**
 * The fragment for machine-made material that is born verified (e.g. an
 * import carrying upstream human approval, or a guess written only on
 * explicit user confirmation). Takes the same optional prediction extras
 * as stampInferred.
 */
export const confirmedInferred = (source, extras = {}) => ({
  ...stampInferred(source, extras),
  [PROV.confirmedKey]: true,
});

/**
 * Classify an entity's metadata into one of PROV_STATES.
 * @param {Object|null|undefined} metadata
 * @returns {'human'|'machine'|'verified'}
 */
export const provState = (metadata) => {
  if (!metadata || metadata[PROV.key] == null) return PROV_STATES.HUMAN;
  return metadata[PROV.confirmedKey] ? PROV_STATES.VERIFIED : PROV_STATES.MACHINE;
};

/**
 * Whether a machine writer must leave this entity alone (write-contract
 * rule 2): true for human-made and human-verified material.
 */
export const isProtected = (metadata) => provState(metadata) !== PROV_STATES.MACHINE;

/**
 * The metadata fragment a HUMAN edit of this entity should merge in
 * (write-contract rule 3): { provConfirmed: true } when the entity is
 * machine-made and unverified, else null (nothing to do).
 */
export const verifyOnEdit = (metadata) =>
  (provState(metadata) === PROV_STATES.MACHINE ? { [PROV.confirmedKey]: true } : null);

/** Canonical provSource for a service: 'service:<serviceId>'. */
export const serviceSource = (serviceId) => `service:${serviceId}`;
