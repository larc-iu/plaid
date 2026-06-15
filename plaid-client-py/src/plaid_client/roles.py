"""Shared layer-role vocabulary for cross-app interoperability.

The Python peer of plaid-client-js's ``roles.js`` — keep the two in lockstep.

Apps that share a Plaid project agree on the *substrate* — the text and token
layers — by tagging each shared layer with a ROLE under the reserved ``plaid``
config namespace (``config.plaid.role``, a scalar). Annotations stay private to
each app under that app's own namespace. See the Plaid manual, "Layer
Interoperability". The role inventory is small and fixed:

    baseline        the primary text layer
    sentence        sentence token layer
    word            orthographic-word token layer (CoNLL-U "token")
    syntactic-word  grammatical words below the word (CoNLL-U "word" / MWT splits)
    morpheme        morpheme token layer
    time-alignment  media-timeline token layer

Only these values are understood across apps; an app may store any string but
loses interoperability for unknown values.
"""

#: The reserved config namespace for cross-app conventions.
PLAID_NAMESPACE = 'plaid'

#: The config key, under ``plaid``, holding a layer's role.
ROLE_KEY = 'role'


class ROLES:
    """The fixed role inventory (attribute access mirrors JS ``ROLES.BASELINE``)."""
    BASELINE = 'baseline'
    SENTENCE = 'sentence'
    WORD = 'word'
    SYNTACTIC_WORD = 'syntactic-word'
    MORPHEME = 'morpheme'
    TIME_ALIGNMENT = 'time-alignment'


def read_role(config):
    """The role recorded on a layer's ``config``, or ``None``.

    Args:
        config: a layer's ``config`` dict (or None).
    """
    if not config:
        return None
    return (config.get(PLAID_NAMESPACE) or {}).get(ROLE_KEY)


def find_by_role(layers, role):
    """The first layer in ``layers`` carrying ``role``, or ``None``.

    The single "find a layer by its role" primitive — build named finders
    (find the word token layer, etc.) on top of it. Returns ``None`` rather than
    guessing a fallback, so callers fail loudly on a missing/mistagged substrate
    instead of silently operating on the wrong layer.

    Args:
        layers: an iterable of layer dicts (each with an optional ``config``).
        role: the role to match (use a :class:`ROLES` constant).
    """
    for layer in layers or []:
        if read_role(layer.get('config')) == role:
            return layer
    return None
