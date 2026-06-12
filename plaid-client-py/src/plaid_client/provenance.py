"""Provenance: the cross-app convention for machine-provided vs human-labeled
information, expressed as flat metadata keys on annotation entities (spans,
relations, vocab links, optionally tokens). Python mirror of the JS client's
``provenance.js``. Flat scalar keys — the query engine matches flat metadata
well, nested objects poorly.

Three states (the PRESENCE of the ``prov`` key, not its value, is the
discriminator; absent keys mean "human"):

- ``human``    — no prov keys; a person made it.
- ``machine``  — ``{'prov': 'inferred', 'provSource': '<producer>'}``;
  an algorithm/service made it and no human has vouched for it.
- ``verified`` — same plus ``{'provConfirmed': True}``; machine-made and a
  human confirmed (or edited) it. ``provSource`` stays so machine origin
  remains traceable.

The write contract every machine writer must follow:

1. Machine writers may freely replace MACHINE (unverified) material.
2. Machine writers must never modify or delete human or verified material
   unless explicitly told to overwrite (an explicit, per-run, user-facing
   opt-in — for services, a declared boolean ``overwrite`` parameter).
3. Any human edit of a machine annotation verifies it: the edit also stamps
   ``{'provConfirmed': True}`` (see :func:`verify_on_edit`).

Producer naming: ``'service:<serviceId>'`` for services (use
:func:`service_source`), ``'rule:<name>'`` for built-in rule algorithms,
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

# The three provenance states returned by prov_state.
HUMAN = 'human'
MACHINE = 'machine'
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


def prov_state(metadata):
    """Classify an entity's metadata: ``'human'``, ``'machine'``, or
    ``'verified'``."""
    if not metadata or metadata.get(PROV_KEY) is None:
        return HUMAN
    return VERIFIED if metadata.get(PROV_CONFIRMED_KEY) else MACHINE


def is_protected(metadata):
    """Whether a machine writer must leave this entity alone (write-contract
    rule 2): True for human-made and human-verified material."""
    return prov_state(metadata) != MACHINE


def verify_on_edit(metadata):
    """The metadata fragment a HUMAN edit of this entity should merge in
    (write-contract rule 3): ``{'provConfirmed': True}`` when the entity is
    machine-made and unverified, else ``None`` (nothing to do)."""
    return {PROV_CONFIRMED_KEY: True} if prov_state(metadata) == MACHINE else None


def service_source(service_id):
    """Canonical provSource for a service: ``'service:<service_id>'``."""
    return f'service:{service_id}'
