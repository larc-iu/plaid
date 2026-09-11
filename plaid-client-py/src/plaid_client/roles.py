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

#: Layer config key naming the metadata keys a token born of a SPLIT inherits
#: from the token it came from. Plaid honors it without knowing what the keys
#: mean; see the manual's "Metadata Preserved Across a Split". An app declares
#: it so that a split in ANY app, including one that has never heard of these
#: keys, does not silently drop them.
PRESERVE_ON_SPLIT_KEY = 'preserveOnSplit'


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


def is_ud_project(project):
    """Whether a project is set up for plaid-ud, from its layer structure alone.

    Two apps share this substrate and both use it for words below the
    orthographic word, so the ``syntactic-word`` ROLE does not tell them apart:
    plaid-igt tags a morpheme layer too. What is distinctive is that plaid-ud
    hangs its annotation span layers off that token layer under its OWN ``ud``
    namespace, which no other app writes.

    Lives here rather than in either app because both need it: plaid-ud asks it
    of its own projects and plaid-igt's admin area asks it of everyone's, and a
    second copy of the answer in the other app is how two apps start disagreeing
    about what a project is.

    This client hands back ``text_layers`` where the wire says ``textLayers``,
    so both spellings are read: the one a caller gets from
    ``client.projects.get``, and the one in a response body it decoded itself.

    Args:
        project: a project dict WITH its layers (``client.projects.get``).
    """
    for text in _either(project, 'text_layers', 'textLayers'):
        for token in _either(text, 'token_layers', 'tokenLayers'):
            if read_role(token.get('config')) != ROLES.SYNTACTIC_WORD:
                continue
            for span in _either(token, 'span_layers', 'spanLayers'):
                if isinstance((span.get('config') or {}).get('ud'), dict):
                    return True
    return False


def _either(d, *keys):
    for k in keys:
        v = (d or {}).get(k)
        if v:
            return v
    return []
