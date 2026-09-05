/**
 * Provenance: the cross-app convention for distinguishing machine-provided
 * from human-labeled information, expressed as flat metadata keys on
 * annotation entities (spans, relations, vocab links, optionally tokens).
 * Flat scalar keys — the query engine matches flat metadata well, nested
 * objects poorly.
 *
 * Two axes. ORIGIN is the `prov` key: absent means a trusted person (a
 * verifier) made it; 'inferred' means an algorithm or service did;
 * 'contributed' means a person whose work the project reviews (a
 * contributor) did. TRUST is `provConfirmed`: true once a verifier vouched
 * for the value. Together they give four states:
 *
 *   human              — no prov keys; a verifier made it.
 *   machine            — { prov: 'inferred', provSource: '<producer>' };
 *                        an algorithm/service made it, nobody has vouched.
 *   contributed        — { prov: 'contributed', provSource: 'user:<id>' };
 *                        a contributor made it, no verifier has vouched.
 *   verified           — either origin + { provConfirmed: true }; a verifier
 *                        confirmed (or edited) it. prov/provSource stay so
 *                        the origin remains traceable.
 *
 * The write contract every machine writer must follow:
 *   1. Machine writers may freely replace MACHINE (unverified) material.
 *   2. Machine writers must never modify or delete human, contributed or
 *      verified material unless explicitly told to overwrite (an explicit,
 *      per-run, user-facing opt-in — for services, a declared boolean
 *      `overwrite` parameter). A contributor's work is a person's work.
 *   3. A verifier's edit of machine or contributed material verifies it:
 *      the edit also stamps { provConfirmed: true } (see verifyOnEdit).
 *      A contributor's edit of anything marks it contributed: the edit
 *      merges stampContributed(userId) and drops any earlier confirmation
 *      (see contributeOnEdit). Who is a contributor is the app's call
 *      (Plaid IGT: a project writer, when the project reviews writers'
 *      work); a service running as a contributor should stamp likewise.
 *
 * Producer naming: 'service:<serviceId>' for services (use serviceSource),
 * 'rule:<name>' for built-in rule algorithms, 'user:<userId>' for a
 * contributor (use userSource), app-specific ids like 'gloss:doc-frequency'
 * or 'flex-import' otherwise.
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
 *
 * Recommended provDetail keys, so consumers (review dashboards, ranked
 * alternatives) can read any producer's output:
 *   - value (spans) / form (morpheme tokens): the value the producer
 *     wrote, mirroring the entity's own field. The entity may be edited
 *     later; this copy is what makes "accepted as-is" vs "corrected"
 *     answerable once the entity is verified.
 *   - valueProbs / formProbs: a top-k {label: probability} map over the
 *     alternatives the producer considered, the chosen label included
 *     (provProb, when given, is that label's entry duplicated flat).
 *   - model, and anything else (language, adapter, raw scores).
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
  /** `prov` for machine-made material. Any value but CONTRIBUTED reads as machine. */
  INFERRED: 'inferred',
  /** `prov` for a contributor's material. */
  CONTRIBUTED: 'contributed',
});

/** The four provenance states returned by provState. */
export const PROV_STATES = Object.freeze({
  HUMAN: 'human',
  MACHINE: 'machine',
  CONTRIBUTED: 'contributed',
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
 * The metadata fragment that verifies machine-made material:
 * { provConfirmed: true }. Merge (PATCH) it over existing metadata so
 * prov/provSource/provProb/provDetail survive. This is what verifyOnEdit
 * returns for machine-unverified material; use it directly for explicit
 * confirmation gestures (a "confirm" button, confirm-on-touch) where the
 * caller has already checked isMachine.
 */
export const PROV_CONFIRMED = Object.freeze({ [PROV.confirmedKey]: true });

/**
 * The metadata fragment a contributor's work carries:
 * { prov: 'contributed', provSource: 'user:<userId>' }.
 * @param {string} userId
 */
export const stampContributed = (userId) => ({
  [PROV.key]: PROV.CONTRIBUTED,
  [PROV.sourceKey]: userSource(userId),
});

/**
 * Classify an entity's metadata into one of PROV_STATES.
 * @param {Object|null|undefined} metadata
 * @returns {'human'|'machine'|'contributed'|'verified'}
 */
export const provState = (metadata) => {
  if (!metadata || metadata[PROV.key] == null) return PROV_STATES.HUMAN;
  if (metadata[PROV.confirmedKey]) return PROV_STATES.VERIFIED;
  return metadata[PROV.key] === PROV.CONTRIBUTED ? PROV_STATES.CONTRIBUTED : PROV_STATES.MACHINE;
};

/**
 * Where an entity came from, confirmed or not: null for a verifier's own
 * work, PROV.INFERRED for a machine's, PROV.CONTRIBUTED for a contributor's.
 * What a verified entity's tooltip needs, since provState folds both
 * origins into 'verified'.
 * @returns {null|'inferred'|'contributed'}
 */
export const provOrigin = (metadata) => {
  if (!metadata || metadata[PROV.key] == null) return null;
  return metadata[PROV.key] === PROV.CONTRIBUTED ? PROV.CONTRIBUTED : PROV.INFERRED;
};

/**
 * Whether this entity is machine-made and not yet verified — the material
 * machine writers may replace. Complement of isProtected.
 */
export const isMachine = (metadata) => provState(metadata) === PROV_STATES.MACHINE;

/**
 * Whether a machine writer must leave this entity alone (write-contract
 * rule 2): true for human-made, contributed and verified material.
 */
export const isProtected = (metadata) => !isMachine(metadata);

/**
 * Whether a verifier still has to look at this entity: machine-made or
 * contributed, and not yet confirmed. What review UIs mark and sweep, and
 * what a verifier's confirmation gesture acts on.
 */
export const needsReview = (metadata) => {
  const s = provState(metadata);
  return s === PROV_STATES.MACHINE || s === PROV_STATES.CONTRIBUTED;
};

/**
 * The metadata fragment a VERIFIER's edit of this entity should merge in
 * (write-contract rule 3): PROV_CONFIRMED when the entity needs review,
 * else null (nothing to do).
 */
export const verifyOnEdit = (metadata) => (needsReview(metadata) ? PROV_CONFIRMED : null);

/**
 * The metadata fragment a CONTRIBUTOR's edit of this entity should merge in
 * (write-contract rule 3): the contributed stamp, plus provConfirmed: null
 * so an earlier confirmation is dropped (a patch deletes null-valued keys;
 * see mergeMetadata for a full replace). Prediction extras a machine
 * recorded stay, as history.
 * @param {Object|null|undefined} metadata - unused today; the fragment is
 *   the same whatever the entity was, and the parameter keeps the shape of
 *   verifyOnEdit so callers can swap one for the other
 * @param {string} userId
 */
// eslint-disable-next-line no-unused-vars
export const contributeOnEdit = (metadata, userId) => ({
  ...stampContributed(userId),
  [PROV.confirmedKey]: null,
});

/**
 * Merge a metadata fragment the way the server's PATCH does — a null value
 * deletes the key — for callers that keep a local copy or send a full
 * replacement (setMetadata). Returns a new object.
 */
export const mergeMetadata = (metadata, fragment) => {
  const out = { ...(metadata || {}) };
  for (const [k, v] of Object.entries(fragment || {})) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
};

/** Canonical provSource for a service: 'service:<serviceId>'. */
export const serviceSource = (serviceId) => `service:${serviceId}`;

/** Canonical provSource for a contributor: 'user:<userId>'. */
export const userSource = (userId) => `user:${userId}`;
