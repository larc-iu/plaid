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

NOTE on key casing: these keys are metadata CONTENT, which both clients treat
as opaque (no recasing) — ``provSource``/``provConfirmed`` are camelCase on the
wire and in every language, by design.
"""

PROV_KEY = 'prov'
PROV_SOURCE_KEY = 'provSource'
PROV_CONFIRMED_KEY = 'provConfirmed'
INFERRED = 'inferred'

# The three provenance states returned by prov_state.
HUMAN = 'human'
MACHINE = 'machine'
VERIFIED = 'verified'


def stamp_inferred(source):
    """The metadata fragment a machine writer merges into everything it
    creates: ``{'prov': 'inferred', 'provSource': source}``."""
    return {PROV_KEY: INFERRED, PROV_SOURCE_KEY: source}


def confirmed_inferred(source):
    """The fragment for machine-made material that is born verified (e.g. an
    import carrying upstream human approval, or a guess written only on
    explicit user confirmation)."""
    frag = stamp_inferred(source)
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
