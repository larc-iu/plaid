"""Provenance: the cross-app convention for who made an annotation,
expressed as flat metadata keys on annotation entities (spans, relations,
vocab links, optionally tokens). Python mirror of the JS client's
``provenance.js``. Flat scalar keys — the query engine matches flat metadata
well, nested objects poorly.

Two axes. ORIGIN is the ``prov`` key: absent means a trusted person (a
verifier) made it; ``'inferred'`` means an algorithm or service did;
``'contributed'`` means a person whose work the project reviews (a
contributor) did. TRUST is ``provConfirmed``: True once a verifier vouched
for the value. Together they give four states:

- ``human``       — no prov keys; a verifier made it.
- ``machine``     — ``{'prov': 'inferred', 'provSource': '<producer>'}``;
  an algorithm/service made it and nobody has vouched for it.
- ``contributed`` — ``{'prov': 'contributed', 'provSource': 'user:<id>'}``;
  a contributor made it and no verifier has vouched for it.
- ``verified``    — either origin plus ``{'provConfirmed': True}``; a
  verifier confirmed (or edited) it. ``prov``/``provSource`` stay so the
  origin remains traceable.

The write contract every machine writer must follow:

1. Machine writers may freely replace MACHINE (unverified) material.
2. Machine writers must never modify or delete human, contributed or verified
   material unless explicitly told to overwrite (an explicit, per-run,
   user-facing opt-in — for services, a declared boolean ``overwrite``
   parameter). A contributor's work is a person's work.
3. A verifier's edit of machine or contributed material verifies it: the edit
   also stamps ``{'provConfirmed': True}`` (see :func:`verify_on_edit`). A
   contributor's edit of anything marks it contributed: the edit merges
   :func:`stamp_contributed` and drops any earlier confirmation (see
   :func:`contribute_on_edit`). Who is a contributor is the app's call (Plaid
   IGT: a project writer, when the project reviews writers' work); a service
   running as a contributor should stamp likewise.

Producer naming: ``'service:<serviceId>'`` for services (use
:func:`service_source`), ``'rule:<name>'`` for built-in rule algorithms,
``'user:<userId>'`` for a contributor (use :func:`user_source`),
app-specific ids like ``'gloss:doc-frequency'`` or ``'flex-import'`` otherwise.

PREDICTION EXTRAS. A producer may also record how confident it was and what
else it considered, in two reserved slots split along the queryability line:

- ``provProb``: ONE flat number in [0, 1] — the producer's probability for
  the value it chose. Flat scalars are what the query engine filters and
  orders on, so "review the least-confident machine output first" is an
  ordinary query. Omit it unless you can honestly produce a probability
  (a raw logprob is NOT one — put it in ``provDetail``).
- ``provDetail``: ONE open map for everything else — top-k alternatives or
  distributions, model name/version, raw scores. Deliberately nested (not
  queryable); keep it small (top-k, not whole-vocabulary dumps).

Both describe the machine's ORIGINAL prediction. They are kept after human
edits (history is valuable), so a consumer must not present ``provProb`` as
confidence in the CURRENT value once the entity is verified
(``provConfirmed`` is exactly the flag to check).

Recommended ``provDetail`` keys, so consumers (review dashboards, ranked
alternatives) can read any producer's output:

- ``value`` (spans) / ``form`` (morpheme tokens): the value the producer
  wrote, mirroring the entity's own field. The entity may be edited later;
  this copy is what makes "accepted as-is" vs "corrected" answerable once
  the entity is verified.
- ``valueProbs`` / ``formProbs``: a top-k ``{label: probability}`` map over
  the alternatives the producer considered, the chosen label included
  (``provProb``, when given, is that label's entry duplicated flat).
- ``model``, and anything else (language, adapter, raw scores).

NOTE on key casing: these keys are metadata CONTENT, which both clients treat
as opaque (no recasing) — ``provSource``/``provConfirmed`` are camelCase on the
wire and in every language, by design.
"""

PROV_KEY = 'prov'
PROV_SOURCE_KEY = 'provSource'
PROV_CONFIRMED_KEY = 'provConfirmed'
PROV_PROB_KEY = 'provProb'
PROV_DETAIL_KEY = 'provDetail'
INFERRED = 'inferred'
CONTRIBUTED = 'contributed'

# The four provenance states returned by prov_state.
HUMAN = 'human'
MACHINE = 'machine'
CONTRIBUTED_STATE = 'contributed'
VERIFIED = 'verified'


def stamp_inferred(source, prob=None, detail=None):
    """The metadata fragment a machine writer merges into everything it
    creates: ``{'prov': 'inferred', 'provSource': source}``.

    Optional prediction extras: ``prob`` is a probability in [0, 1] for the
    chosen value (omit unless it honestly is one — raw scores go in
    ``detail``); ``detail`` is an open map of producer extras (top-k
    alternatives, model version, raw scores; keep it small)."""
    frag = {PROV_KEY: INFERRED, PROV_SOURCE_KEY: source}
    if prob is not None:
        frag[PROV_PROB_KEY] = prob
    if detail:
        frag[PROV_DETAIL_KEY] = detail
    return frag


def confirmed_inferred(source, prob=None, detail=None):
    """The fragment for machine-made material that is born verified (e.g. an
    import carrying upstream human approval, or a guess written only on
    explicit user confirmation). Takes the same optional prediction extras
    as :func:`stamp_inferred`."""
    frag = stamp_inferred(source, prob=prob, detail=detail)
    frag[PROV_CONFIRMED_KEY] = True
    return frag


def stamp_contributed(user_id):
    """The metadata fragment a contributor's work carries:
    ``{'prov': 'contributed', 'provSource': 'user:<user_id>'}``."""
    return {PROV_KEY: CONTRIBUTED, PROV_SOURCE_KEY: user_source(user_id)}


def prov_state(metadata):
    """Classify an entity's metadata: ``'human'``, ``'machine'``,
    ``'contributed'`` or ``'verified'``."""
    if not metadata or metadata.get(PROV_KEY) is None:
        return HUMAN
    if metadata.get(PROV_CONFIRMED_KEY):
        return VERIFIED
    return CONTRIBUTED_STATE if metadata.get(PROV_KEY) == CONTRIBUTED else MACHINE


def prov_origin(metadata):
    """Where an entity came from, confirmed or not: ``None`` for a verifier's
    own work, ``'inferred'`` for a machine's, ``'contributed'`` for a
    contributor's. What a verified entity's description needs, since
    :func:`prov_state` folds both origins into ``'verified'``."""
    if not metadata or metadata.get(PROV_KEY) is None:
        return None
    return CONTRIBUTED if metadata.get(PROV_KEY) == CONTRIBUTED else INFERRED


def is_protected(metadata):
    """Whether a machine writer must leave this entity alone (write-contract
    rule 2): True for human-made, contributed and verified material."""
    return prov_state(metadata) != MACHINE


def needs_review(metadata):
    """Whether a verifier still has to look at this entity: machine-made or
    contributed, and not yet confirmed."""
    return prov_state(metadata) in (MACHINE, CONTRIBUTED_STATE)


def verify_on_edit(metadata):
    """The metadata fragment a VERIFIER's edit of this entity should merge in
    (write-contract rule 3): ``{'provConfirmed': True}`` when the entity
    needs review, else ``None`` (nothing to do)."""
    return {PROV_CONFIRMED_KEY: True} if needs_review(metadata) else None


def contribute_on_edit(metadata, user_id):
    """The metadata fragment a CONTRIBUTOR's edit of this entity should merge
    in (write-contract rule 3): the contributed stamp plus
    ``provConfirmed: None`` so an earlier confirmation is dropped (a patch
    deletes null-valued keys; see :func:`merge_metadata` for a full
    replace). ``metadata`` is unused today: the fragment is the same whatever
    the entity was, and the parameter keeps the shape of
    :func:`verify_on_edit`."""
    return {**stamp_contributed(user_id), PROV_CONFIRMED_KEY: None}


def merge_metadata(metadata, fragment):
    """Merge a metadata fragment the way the server's PATCH does — a ``None``
    value deletes the key — for callers that keep a local copy or send a full
    replacement (``set_metadata``). Returns a new dict."""
    out = dict(metadata or {})
    for k, v in (fragment or {}).items():
        if v is None:
            out.pop(k, None)
        else:
            out[k] = v
    return out


def service_source(service_id):
    """Canonical provSource for a service: ``'service:<service_id>'``."""
    return f'service:{service_id}'


def user_source(user_id):
    """Canonical provSource for a contributor: ``'user:<user_id>'``."""
    return f'user:{user_id}'
