"""Which planned changes replace work a person made or accepted.

An approval is the person's own act, so a plan may change anything, a
person's work included. What the card owes them is to say so: a line above the
list ("3 changes replace accepted work"), and those rows are never folded into
a group of like changes (ruled 2026-09-28, beside the Rewrite line for prose).

"A person's work" is the provenance convention's protected material: made by a
person (no provenance), by a contributor, or verified by anyone. Only
unconfirmed machine output is free to replace. Each app answers which existing
things a change of each kind rewrites or removes (its ``REPLACES`` table,
kind -> ``fn(ws, op) -> ids``), and this module reads their provenance off the
documents the turn loaded.
"""

import dataclasses
from typing import Any, Dict, Iterable, Tuple

from plaid_client.provenance import is_protected

#: The key a plan op carries once it is known to replace a person's work,
#: holding how many changes of a person's it replaces (1 for a change of one
#: thing). Set on the copy the card is built from, never on the turn's own plan.
FLAG = 'replaces_work'

#: The key a corpus-wide change stored as one op carries from the moment it
#: is staged: how many of the changes it stands for replace a person's work,
#: counted from the provenance its query returned. What it replaces is found
#: again only when it is approved, so this is the only time it can be counted.
COUNTED = 'replaces_accepted'


def counted_phrase(n: int) -> str:
    """The end of a corpus-wide change's row that says how many of its
    changes replace a person's work, or ''."""
    if not n:
        return ''
    return f', {n} of them {"replaces" if n == 1 else "replace"} accepted work'


def entities(obj: Any, path: tuple = ()) -> Iterable[Tuple[str, Any]]:
    """(id, metadata) for every parsed thing in ``obj`` that has both, which
    is every thing that can carry provenance: a span, a relation, a link, a
    token. A field declared ``compare=False`` is a cache and is not walked.

    A thing whose ``value`` is empty is a placeholder (a field nobody has
    filled), so filling it replaces nobody's work, whoever made the empty
    slot: it is left out."""
    if obj is None or isinstance(obj, (str, int, float, bool)) or id(obj) in path:
        return
    path = path + (id(obj),)
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        names = {f.name for f in dataclasses.fields(obj)}
        empty = 'value' in names and obj.value in ('', None)
        if 'id' in names and 'metadata' in names and isinstance(obj.id, str) and not empty:
            yield obj.id, obj.metadata
        for f in dataclasses.fields(obj):
            if f.compare:
                yield from entities(getattr(obj, f.name), path)
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from entities(v, path)
    elif isinstance(obj, (list, tuple, set, frozenset)):
        for v in obj:
            yield from entities(v, path)


def entity_index(doc: Any) -> Dict[str, Any]:
    """id -> metadata for every thing in a parsed document that carries it."""
    return dict(entities(doc))


def protected(metadata: Any) -> bool:
    """Whether this is a person's work: made or accepted by one."""
    return is_protected(metadata if isinstance(metadata, dict) else None)
