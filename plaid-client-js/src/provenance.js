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
 *      (see contributeOnEdit). Who is a contributor is the PROJECT's call,
 *      recorded once for every app (see "Review" below); a service running
 *      as a contributor should stamp likewise.
 *
 * REVIEW: which people are contributors. A project records it under the
 * reserved `plaid` config namespace, so every app that writes on a person's
 * behalf reads the same answer:
 *
 *   config.plaid.review = { users: [userId, ...], roles: ['writer', ...] }
 *
 * `users` names people whose work is reviewed whatever their role; `roles`
 * names whole project roles ('reader' | 'writer' | 'maintainer'; an admin
 * without an explicit role counts as a maintainer). Either may be absent.
 * Nothing here grants or denies access: the ACL lists stay the permission
 * model, and this only says whose work needs a verifier's look. Apps expose
 * it as a per-member mark on their access screens (readReview, isReviewed,
 * withReviewedUser) and derive the writer's policy from it (writerPolicy).
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

/**
 * Every provenance key, for a caller that has to name them as a set rather
 * than read one: what a token layer declares under
 * `config.plaid.preserveOnSplit` so a token born of a split inherits the
 * origin of the token it came from, and what a reshape carries by hand.
 *
 * Provenance is the one metadata family Plaid itself owns. The user cannot
 * maintain it, and in a shared project usually cannot even see it, since it
 * may belong to an app they are not using. Everything else on an entity is
 * the user's own content and no structural operation should touch it.
 */
export const PROVENANCE_KEYS = Object.freeze([
  PROV.key,
  PROV.sourceKey,
  PROV.confirmedKey,
  PROV.probKey,
  PROV.detailKey,
]);

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

// ---- review: whose work is reviewed (a project-config norm) ----

/** The config key, under the `plaid` namespace, holding the review lists. */
export const REVIEW_KEY = 'review';

/** The project roles a review list may name. */
export const PROJECT_ROLES = Object.freeze(['reader', 'writer', 'maintainer']);

/**
 * The project's review lists, normalized: { users: string[], roles: string[] }.
 * @param {Object|null|undefined} config - a project's `config`
 */
export const readReview = (config) => {
  const raw = config?.plaid?.[REVIEW_KEY];
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  return { users: list(raw?.users), roles: list(raw?.roles) };
};

/**
 * A person's role in a project from its ACL lists: 'maintainer' | 'writer' |
 * 'reader' | null. An admin with no explicit entry is a maintainer, as the
 * permission model treats them.
 * @param {Object} project - with `maintainers`, `writers`, `readers`
 * @param {string} userId
 * @param {Object} [opts]
 * @param {boolean} [opts.isAdmin]
 */
export const projectRole = (project, userId, { isAdmin = false } = {}) => {
  const inList = (l) => Array.isArray(l) && userId != null && l.includes(userId);
  if (inList(project?.maintainers)) return 'maintainer';
  if (inList(project?.writers)) return 'writer';
  if (inList(project?.readers)) return 'reader';
  return isAdmin ? 'maintainer' : null;
};

/**
 * Whether this person's work is reviewed in this project: named in
 * review.users, or holding a role named in review.roles.
 */
export const isReviewed = (project, userId, { isAdmin = false } = {}) => {
  if (!project || userId == null) return false;
  const { users, roles } = readReview(project.config);
  if (users.includes(userId)) return true;
  const role = projectRole(project, userId, { isAdmin });
  return role != null && roles.includes(role);
};

/**
 * The review lists with one person added to or removed from `users`
 * (`roles` untouched). Pure; write the result with
 * projects.setConfig(id, 'plaid', REVIEW_KEY, next).
 */
export const withReviewedUser = (review, userId, reviewed) => {
  const { users, roles } = readReview({ plaid: { [REVIEW_KEY]: review } });
  const next = users.filter((u) => u !== userId);
  if (reviewed) next.push(userId);
  return { users: next, roles };
};

// ---- the writer's policy: what a person's writes carry ----

/**
 * What one writer's writes carry and what their review gestures act on,
 * given who they are: `contributorId` is their user id when their work is
 * reviewed (isReviewed), else null for a verifier. Apps derive this once per
 * document and route every human write through it, so the convention's
 * rule 3 has one implementation.
 *
 * @param {string|null} contributorId
 * @returns {{
 *   contributorId: string|null,
 *   isContributor: boolean,
 *   createStamp: Object|null,
 *   editStamp: (metadata: Object) => Object|null,
 *   confirmStamp: (metadata: Object) => Object|null,
 *   adoptStamp: (source: string, detail?: Object) => Object,
 *   reviewable: (metadata: Object) => boolean,
 *   reviewableState: (state: string) => boolean,
 * }}
 */
export const writerPolicy = (contributorId = null) => {
  const id = contributorId || null;
  const contributor = id != null;
  // Material this writer's review gestures act on: a verifier reviews
  // machine and contributed material; a contributor reviews machine
  // proposals only, since their own vouching is itself a contribution.
  const reviewable = (metadata) => (contributor ? isMachine(metadata) : needsReview(metadata));
  const reviewableState = (state) =>
    contributor
      ? state === PROV_STATES.MACHINE
      : state === PROV_STATES.MACHINE || state === PROV_STATES.CONTRIBUTED;
  return Object.freeze({
    contributorId: id,
    isContributor: contributor,
    /** The metadata a NEW entity carries: null for a verifier. */
    createStamp: contributor ? stampContributed(id) : null,
    /**
     * The fragment an EDIT merges over the entity's metadata, or null when
     * there is nothing to merge: a verifier confirms what needs review; a
     * contributor's edit marks the entity contributed, dropping any earlier
     * confirmation.
     */
    editStamp: (metadata) => (contributor ? contributeOnEdit(metadata, id) : verifyOnEdit(metadata)),
    /**
     * The fragment an explicit confirm gesture merges, or null when there is
     * nothing for this writer to confirm: PROV_CONFIRMED for a verifier, the
     * contributed stamp for a contributor accepting a machine proposal.
     */
    confirmStamp: (metadata) => {
      if (!reviewable(metadata)) return null;
      return contributor ? contributeOnEdit(metadata, id) : PROV_CONFIRMED;
    },
    /**
     * What an adopted suggestion is written with (a guess or a picked value
     * into an empty cell): born-verified with the suggestion's producer as
     * its source for a verifier; contributed for a contributor, with the
     * producer kept as provDetail.guess. `detail` is the prediction extras.
     */
    adoptStamp: (source, detail) =>
      contributor
        ? { ...stampContributed(id), [PROV.detailKey]: { ...(detail || {}), guess: source } }
        : confirmedInferred(source, { detail }),
    reviewable,
    reviewableState,
  });
};
