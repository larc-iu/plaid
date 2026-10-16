"""A value kept out of a corpus-wide change (Luke, 2026-10-16).

A corpus-wide change (a replacement over a field, a discard of a
document's predictions) is stored as one operation and resolved to the
values it changes only when the plan is approved. A user who wants one of
those values left as it is says so by naming it with the value it already
holds. That is a KEEP: an operation on the same target as the change it
stands against, which a change the scope finds there loses to
(:func:`core.opkind.named_beats_scope`), and which writes nothing itself.
The value survives and its provenance stays whoever made it. A restating
write would have restamped it as the plan's.

Each app declares the kind with :func:`kind`, giving what the kept value is
for last-wins replacement within the plan (``target``) and, where the two
differ, for beating a scope (``entity``). The op carries both as lists,
since a stored plan comes back from JSON:

``kept``         what :attr:`OpKind.target` reads.
``kept_entity``  what the app's own beat-the-scope key reads, when it has one.

A keep is not a change: it counts as none on the card's total, the plan's
summary and the applied message, and its card row names what stays.
"""

from typing import Any, Dict, Iterable, Optional

#: The kind every app declares a keep under.
KEEP = 'keep'

#: Its nouns, which nothing counts (``summary`` gives no count).
NOUN = ('kept value', 'kept values')


def is_keep(op: Any) -> bool:
    return isinstance(op, dict) and op.get('kind') == KEEP


def target(op: Dict[str, Any]) -> Optional[tuple]:
    kept = op.get('kept')
    return tuple(kept) if kept else None


def entity(op: Dict[str, Any]) -> Optional[tuple]:
    kept = op.get('kept_entity') or op.get('kept')
    return tuple(kept) if kept else None


def _apply(ctx, op) -> int:
    # Nothing is written: the change a scope found on the same value was
    # left out when the scope was resolved.
    return 0


def kind(OpKind, **declared):
    """The keep kind for an app's registry. ``declared`` is what the app
    adds (where its card places the row, its ``entity`` hook)."""
    return OpKind(KEEP, NOUN, required=('kept',), apply=_apply, target=target,
                  summary=lambda op, n: [], **declared)


def op(kept: Iterable[Any], label: str, entity_key: Optional[Iterable[Any]] = None,
       **keys: Any) -> Dict[str, Any]:
    """A keep op. ``label`` names what stays, never as a write."""
    out = {'kind': KEEP, 'kept': list(kept), 'label': label, **keys}
    if entity_key is not None:
        out['kept_entity'] = list(entity_key)
    return out
