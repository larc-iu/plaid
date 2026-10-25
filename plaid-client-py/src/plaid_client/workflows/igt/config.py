"""Readers of plaid-igt's private config namespace (``config.igt``), one per
key, the Python twins of plaid-igt's ``domain/igtConfig.js``.

Every Python reader of an ``igt`` key goes through here, so a key's default
is written once. ``tests/test_igt_config_mirror.py`` runs igtConfig.js over
the same configs and compares the answers.

A vocabulary's field schema is read here too (:func:`normalize_vocab_fields`,
:func:`role_field`), the twin of plaid-igt's ``domain/vocabFields.js``.
plaid-agent's ``igt/vocab.py`` re-exports it, and its
``tests/test_vocab_mirror.py`` compares it with the app's.
"""

from typing import List, Optional

IGT_NAMESPACE = 'igt'

#: Where a span layer keeps its Lexicon field (igtConfig.js LEXICON_FIELD_KEY).
LEXICON_FIELD_KEY = 'lexiconField'

#: The word layer's key for "Tokenize new text" (igtConfig.js TOKENIZE_NEW_TEXT_KEY).
TOKENIZE_NEW_TEXT_KEY = 'tokenizeNewText'


def read_igt_namespace(config) -> dict:
    """The whole ``config.igt`` namespace, or ``{}`` when it is not a map."""
    v = (config or {}).get(IGT_NAMESPACE)
    return v if isinstance(v, dict) else {}


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


#: A word's spelling in an orthography is token metadata under this prefix
#: plus the orthography's name (igtConfig.js ORTHOGRAPHY_KEY_PREFIX). Every
#: reader and writer of that key goes through the three helpers below.
ORTHOGRAPHY_KEY_PREFIX = 'orthog:'


def orthography_key(name: str) -> str:
    """The token-metadata key a word's spelling in orthography ``name`` is stored under."""
    return f'{ORTHOGRAPHY_KEY_PREFIX}{name}'


def is_orthography_key(key) -> bool:
    """Whether a token-metadata key holds a spelling in some orthography."""
    return isinstance(key, str) and key.startswith(ORTHOGRAPHY_KEY_PREFIX)


def orthography_name(key: str) -> str:
    """The orthography an orthography key names (the inverse of :func:`orthography_key`)."""
    return key[len(ORTHOGRAPHY_KEY_PREFIX):]


def read_vocab_fields(config):
    """A vocabulary's custom field schema, ``{field: {...}}``, or None."""
    return read_igt(config, 'fields')


# ---- a vocabulary's field schema (vocabFields.js) ---------------------------

# The source ids the CLDF and native importers stamp on an entry, to find it
# again on a resumed import. Not plaid-igt resume.js IMPORT_STAMP_KEYS, the
# marks an import leaves on a document.
ENTRY_IMPORT_STAMP_KEYS = frozenset({'cldfEntry', 'nativeImportId'})

# Keys an entry may carry that are never fields. A schema can never shadow one.
RESERVED_ITEM_KEYS = frozenset({'form', 'parent', 'senseOrder', 'examples',
                                'flexEntry', 'flexSense', 'homograph'}) | ENTRY_IMPORT_STAMP_KEYS

FIELD_TEXT = 'text'
FIELD_ITEM = 'item'
SCOPE_ENTRY = 'entry'
SCOPE_SENSE = 'sense'

CORE_VOCAB_FIELDS = (
    {'name': 'morphType', 'inline': False, 'immutable': True},
    {'name': 'gloss', 'inline': True, 'immutable': True, 'role': 'gloss'},
    {'name': 'pos', 'inline': True, 'immutable': False, 'role': 'pos'},
    {'name': 'definition', 'inline': False, 'immutable': False, 'role': 'definition'},
)

# What a field's values ARE (``role`` in its config): a gloss, a definition, a
# part of speech, or the entry's editorial status. Stored, set in the app's
# field settings and by setup and the importers. A field without one has none,
# whatever it is called, and several may share one (a gloss per language).
ROLE_GLOSS = 'gloss'
ROLE_DEFINITION = 'definition'
ROLE_POS = 'pos'
ROLE_STATUS = 'status'
ENTRY_ROLES = (ROLE_GLOSS, ROLE_DEFINITION, ROLE_POS, ROLE_STATUS)
_IMMUTABLE = tuple(f['name'] for f in CORE_VOCAB_FIELDS if f['immutable'])
_CORE_BY_NAME = {f['name']: f for f in CORE_VOCAB_FIELDS}


def _str(v) -> str:
    return v.strip() if isinstance(v, str) else ''


def is_reserved_field_name(name) -> bool:
    n = str(name or '').strip().lower()
    return any(k.lower() == n for k in RESERVED_ITEM_KEYS)


# ---- the field schema -------------------------------------------------------

def normalize_vocab_fields(raw: Optional[dict]) -> List[dict]:
    """A vocab layer's ``igt.fields`` config as an ordered list of field specs,
    guaranteeing the immutable core fields are present. Mirrors normalizeVocabFields in vocabFields.js, so the
    agent sees exactly the fields the app's own editor does."""
    out: List[dict] = []
    seen = set()
    declared = set(raw.keys()) if isinstance(raw, dict) else set()

    def add(name, cfg):
        if not name or is_reserved_field_name(name) or name in seen:
            return
        seen.add(name)
        obj = cfg if isinstance(cfg, dict) else None
        inline = bool(obj.get('inline')) if obj else False
        immutable = name in _IMMUTABLE
        # The core fields hold text whatever the config says.
        ftype = FIELD_TEXT if immutable else (
            FIELD_ITEM if _str((obj or {}).get('type')) == FIELD_ITEM else FIELD_TEXT)
        out.append({
            'name': name,
            'inline': inline,
            'immutable': immutable,
            'tagset': _str((obj or {}).get('tagset')) or None,
            'lang': _str((obj or {}).get('lang')) or None,
            'type': ftype,
            'many': ftype == FIELD_ITEM and bool((obj or {}).get('many')),
            'scope': SCOPE_ENTRY if _str((obj or {}).get('scope')) == SCOPE_ENTRY else SCOPE_SENSE,
            'role': _str((obj or {}).get('role')) if _str((obj or {}).get('role')) in ENTRY_ROLES else None,
            # False for an immutable field the config never named: the app shows
            # it, but it is not what this vocabulary chose to record.
            'declared': name in declared,
        })

    if isinstance(raw, dict):
        for name, cfg in raw.items():
            add(name, cfg)
    for name in _IMMUTABLE:
        if name not in seen:
            add(name, {'inline': _CORE_BY_NAME[name]['inline']})

    def core_idx(name):
        for i, f in enumerate(CORE_VOCAB_FIELDS):
            if f['name'] == name:
                return i
        return len(CORE_VOCAB_FIELDS) + 1
    pinned = sorted([f for f in out if f['immutable']], key=lambda f: core_idx(f['name']))
    return pinned + [f for f in out if not f['immutable']]


def fields_with_role(fields: List[dict], role: str) -> List[dict]:
    """The fields that hold ``role``, in the order given. Mirrors fieldsWithRole."""
    return [f for f in fields or [] if f.get('role') == role]


def role_field(vocab_config, role: str) -> Optional[str]:
    """The entry field of a vocabulary holding ``role`` (its stored ``role``),
    the first in the app's field order (:func:`normalize_vocab_fields`: the
    immutable core fields first, then the rest as stored), or None. Never read
    from a field's name."""
    return next((f['name'] for f in fields_with_role(normalize_vocab_fields(read_vocab_fields(vocab_config)), role)),
                None)
