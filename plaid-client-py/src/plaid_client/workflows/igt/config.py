"""Readers of plaid-igt's private config namespace (``config.igt``), one per
key, the Python twins of plaid-igt's ``domain/igtConfig.js``.

Every Python reader of an ``igt`` key goes through here, so a key's default
is written once. ``tests/test_igt_config_mirror.py`` runs igtConfig.js over
the same configs and compares the answers.
"""

IGT_NAMESPACE = 'igt'

#: Where a span layer keeps its Lexicon field (igtConfig.js LEXICON_FIELD_KEY).
LEXICON_FIELD_KEY = 'lexiconField'

#: The word layer's key for "Tokenize new text" (igtConfig.js TOKENIZE_NEW_TEXT_KEY).
TOKENIZE_NEW_TEXT_KEY = 'tokenizeNewText'


def read_igt(config, key):
    """The value ``config.igt.<key>`` holds, or None."""
    return ((config or {}).get(IGT_NAMESPACE) or {}).get(key)


def read_scope(config):
    """A span layer's annotation scope: "Word" | "Morpheme" | "Sentence", or None."""
    return read_igt(config, 'scope')


def read_field_lang(config):
    """The writing system a span layer's values are in ("pmy"), or None."""
    return read_igt(config, 'lang')


def read_lexicon_field(config):
    """The lexicon entry field a span layer's values pair with ("gloss"), or
    None for none."""
    return read_igt(config, LEXICON_FIELD_KEY)


def read_tokenize_new_text(config) -> bool:
    """The word layer's "Tokenize new text": on unless set to ``false``."""
    igt = config.get(IGT_NAMESPACE) if isinstance(config, dict) else None
    return not (isinstance(igt, dict) and igt.get(TOKENIZE_NEW_TEXT_KEY) is False)


def read_vocab_fields(config):
    """A vocabulary's custom field schema, ``{field: {...}}``, or None."""
    return read_igt(config, 'fields')
