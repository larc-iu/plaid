"""Metadata ops: the body of every metadata PATCH, and the ``metadata`` of a
bulk update entry. An op is ``{"op": "set", "path": [...], "value": v}`` or
``{"op": "delete", "path": [...]}``, where ``path`` is a non-empty list of keys
into the nested metadata, the first a top-level key. See the manual,
"Metadata".
"""

import copy

_ABSENT = object()


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
    input. Raises ValueError where the server would refuse (a path through a
    non-object)."""
    out = dict(metadata or {})
    for op in ops or []:
        path = op.get("path")
        if not isinstance(path, (list, tuple)) or not path:
            raise ValueError("A metadata op needs a non-empty path")
        if op.get("op") not in ("set", "delete"):
            raise ValueError(f"Unknown metadata op {op.get('op')!r}: expected set or delete")
        if op["op"] == "set" and "value" not in op:
            raise ValueError("A set op needs a value")
        out = _apply_op(out, list(path), 0, op)
    return out
