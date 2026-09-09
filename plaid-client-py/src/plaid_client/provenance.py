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
   :func:`contribute_on_edit`). Who is a contributor is the PROJECT's call,
   recorded once for every app (see "Review" below); a service running as a
   contributor should stamp likewise.

REVIEW: which people are contributors. A project records it under the
reserved ``plaid`` config namespace, so every app that writes on a person's
behalf reads the same answer::

    config['plaid']['review'] = {'users': [user_id, ...], 'roles': ['writer', ...]}

``users`` names people whose work is reviewed whatever their role; ``roles``
names whole project roles (``'reader'`` | ``'writer'`` | ``'maintainer'``; an
admin without an explicit role counts as a maintainer). Either may be absent.
Nothing here grants or denies access: the ACL lists stay the permission
model, and this only says whose work needs a verifier's look. Apps expose it
as a per-member mark on their access screens (:func:`read_review`,
:func:`is_reviewed`, :func:`with_reviewed_user`) and derive the writer's
policy from it (:class:`WriterPolicy`).

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

#: Every provenance key, for a caller that has to name them as a set rather
#: than read one: what a token layer declares under
#: ``config.plaid.preserveOnSplit`` so a token born of a split inherits the
#: origin of the token it came from.
#:
#: Provenance is the one metadata family Plaid itself owns. The user cannot
#: maintain it, and in a shared project usually cannot even see it, since it
#: may belong to an app they are not using. Everything else on an entity is the
#: user's own content and no structural operation should touch it.
PROVENANCE_KEYS = (
    PROV_KEY,
    PROV_SOURCE_KEY,
    PROV_CONFIRMED_KEY,
    PROV_PROB_KEY,
    PROV_DETAIL_KEY,
)
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


# --- review: whose work is reviewed (a project-config norm) ---------------------

#: The config key, under the ``plaid`` namespace, holding the review lists.
REVIEW_KEY = 'review'

#: The project roles a review list may name.
PROJECT_ROLES = ('reader', 'writer', 'maintainer')


def read_review(config):
    """The project's review lists, normalized:
    ``{'users': [...], 'roles': [...]}``."""
    raw = ((config or {}).get('plaid') or {}).get(REVIEW_KEY) or {}

    def strings(v):
        return [x for x in v if isinstance(x, str)] if isinstance(v, list) else []

    return {'users': strings(raw.get('users')), 'roles': strings(raw.get('roles'))}


def project_role(project, user_id, is_admin=False):
    """A person's role in a project from its ACL lists: ``'maintainer'`` |
    ``'writer'`` | ``'reader'`` | ``None``. An admin with no explicit entry
    is a maintainer, as the permission model treats them."""
    project = project or {}

    def in_list(key):
        lst = project.get(key)
        return isinstance(lst, list) and user_id is not None and user_id in lst

    if in_list('maintainers'):
        return 'maintainer'
    if in_list('writers'):
        return 'writer'
    if in_list('readers'):
        return 'reader'
    return 'maintainer' if is_admin else None


def is_reviewed(project, user_id, is_admin=False):
    """Whether this person's work is reviewed in this project: named in
    ``review.users``, or holding a role named in ``review.roles``."""
    if not project or user_id is None:
        return False
    review = read_review(project.get('config'))
    if user_id in review['users']:
        return True
    role = project_role(project, user_id, is_admin=is_admin)
    return role is not None and role in review['roles']


def with_reviewed_user(review, user_id, reviewed):
    """The review lists with one person added to or removed from ``users``
    (``roles`` untouched). Pure; write the result with
    ``projects.set_config(id, 'plaid', REVIEW_KEY, next)``."""
    current = read_review({'plaid': {REVIEW_KEY: review}})
    users = [u for u in current['users'] if u != user_id]
    if reviewed:
        users.append(user_id)
    return {'users': users, 'roles': current['roles']}


# --- the writer's policy: what a person's writes carry --------------------------

class WriterPolicy:
    """What one writer's writes carry and what their review gestures act on,
    given who they are: ``contributor_id`` is their user id when their work is
    reviewed (:func:`is_reviewed`), else ``None`` for a verifier. The Python
    peer of the JS client's ``writerPolicy``."""

    def __init__(self, contributor_id=None):
        self.contributor_id = contributor_id or None

    @property
    def is_contributor(self):
        return self.contributor_id is not None

    @property
    def create_stamp(self):
        """The metadata a NEW entity carries: ``None`` for a verifier."""
        return stamp_contributed(self.contributor_id) if self.is_contributor else None

    def edit_stamp(self, metadata):
        """The fragment an EDIT merges over the entity's metadata, or ``None``
        when there is nothing to merge: a verifier confirms what needs review;
        a contributor's edit marks the entity contributed, dropping any
        earlier confirmation."""
        if self.is_contributor:
            return contribute_on_edit(metadata, self.contributor_id)
        return verify_on_edit(metadata)

    def reviewable(self, metadata):
        """Material this writer's review gestures act on: a verifier reviews
        machine and contributed material; a contributor reviews machine
        proposals only, since their own vouching is itself a contribution."""
        return prov_state(metadata) == MACHINE if self.is_contributor else needs_review(metadata)

    def reviewable_state(self, state):
        if self.is_contributor:
            return state == MACHINE
        return state in (MACHINE, CONTRIBUTED_STATE)

    def confirm_stamp(self, metadata):
        """The fragment an explicit confirm gesture merges, or ``None`` when
        there is nothing for this writer to confirm."""
        if not self.reviewable(metadata):
            return None
        if self.is_contributor:
            return contribute_on_edit(metadata, self.contributor_id)
        return {PROV_CONFIRMED_KEY: True}

    def adopt_stamp(self, source, detail=None):
        """What an adopted suggestion is written with: born-verified with the
        suggestion's producer as its source for a verifier; contributed for a
        contributor, with the producer kept as ``provDetail.guess``."""
        if self.is_contributor:
            return {**stamp_contributed(self.contributor_id),
                    PROV_DETAIL_KEY: {**(detail or {}), 'guess': source}}
        return confirmed_inferred(source, detail=detail)
