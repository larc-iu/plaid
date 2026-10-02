"""Metadata ops: the body of every metadata PATCH, and the ``metadata`` of a
bulk update entry. An op is ``{"op": "set", "path": [...], "value": v}`` or
``{"op": "delete", "path": [...]}``, where ``path`` is a non-empty list of keys
into the nested metadata, the first a top-level key. See the manual,
"Metadata".
"""

import copy
import unicodedata

from .provenance import PROVENANCE_KEYS
from .roles import PLAID_NAMESPACE

_RESERVED_KEYS = frozenset((PLAID_NAMESPACE, *PROVENANCE_KEYS))


def is_reserved_metadata_key(key):
    """True for a top-level metadata key Plaid keeps for itself: the shared
    ``plaid`` namespace (settings every app reads, such as the text direction)
    and the provenance keys. Neither is ever a user's metadata field, so an
    app neither lists it as one nor writes a field's value to it."""
    return key in _RESERVED_KEYS

_ABSENT = object()

# The longest top-level key the server takes, in UTF-16 code units (Java's
# String length, which is what it counts).
_MAX_KEY_LENGTH = 200

# Java's Character.isWhitespace, which the server's blank check uses: the
# Unicode space separators except the three no-break spaces, and the ASCII
# whitespace controls.
_NO_BREAK_SPACES = {"\u00a0", "\u2007", "\u202f"}


def _java_whitespace(c):
    return (
        unicodedata.category(c) in ("Zs", "Zl", "Zp") and c not in _NO_BREAK_SPACES
    ) or c in "\t\n\u000b\f\r\u001c\u001d\u001e\u001f"


def _valid_metadata_key(k):
    """True when the server accepts ``k`` as a top-level metadata key: not
    blank, at most 200 UTF-16 code units, and no ASCII control character."""
    return (
        isinstance(k, str)
        and len(k.encode("utf-16-le")) // 2 <= _MAX_KEY_LENGTH
        and not any(ord(c) <= 0x1F or ord(c) == 0x7F for c in k)
        and not all(_java_whitespace(c) for c in k)
    )


def metadata_ops(fragment):
    """The ops that set each top-level key of ``fragment``, deleting a key
    whose value is None. This is how a provenance fragment (verify_on_edit,
    contribute_on_edit, ...) is sent as a patch."""
    return [
        {"op": "delete", "path": [k]} if v is None else {"op": "set", "path": [k], "value": v}
        for k, v in (fragment or {}).items()
    ]


def _apply_op(node, path, depth, op):
    k = path[depth]
    if depth == len(path) - 1:
        out = dict(node)
        if op["op"] == "set":
            out[k] = copy.deepcopy(op["value"])
        else:
            out.pop(k, None)
        return out
    child = node.get(k, _ABSENT)
    if child is _ABSENT:
        if op["op"] == "set":
            return {**node, k: _apply_op({}, path, depth + 1, op)}
        return node
    if not isinstance(child, dict):
        raise ValueError(f"Metadata path {path[:depth + 1]!r} holds a value that is not an object")
    return {**node, k: _apply_op(child, path, depth + 1, op)}


def apply_metadata_ops(metadata, ops):
    """Apply ops to a local copy of an entity's metadata the way the server
    does, for an optimistic update. Returns a new dict and never mutates its
    input. Raises ValueError on part of what the server refuses: an empty path,
    an op other than set or delete, a path through a non-object, or a first
    key that is blank, over 200 characters or holds a control character. The
    server's caps on depth, key count, string length and size are not checked
    here."""
    out = dict(metadata or {})
    for op in ops or []:
        path = op.get("path")
        if not isinstance(path, (list, tuple)) or not path:
            raise ValueError("A metadata op needs a non-empty path")
        if not _valid_metadata_key(path[0]):
            raise ValueError("Invalid metadata key")
        if op.get("op") not in ("set", "delete"):
            raise ValueError(f"Unknown metadata op {op.get('op')!r}: expected set or delete")
        if op["op"] == "set" and "value" not in op:
            raise ValueError("A set op needs a value")
        out = _apply_op(out, list(path), 0, op)
    return out


def merge_metadata(metadata, fragment):
    """Merge a top-level fragment into a local copy, a ``None`` value deleting
    the key: :func:`apply_metadata_ops` over :func:`metadata_ops`, so the same
    result as sending those ops, refused where the server would refuse them.
    How a provenance stamp (``verify_on_edit``, ``contribute_on_edit``, ...) is
    mirrored on a local copy. Returns a new dict."""
    return apply_metadata_ops(metadata, metadata_ops(fragment))
