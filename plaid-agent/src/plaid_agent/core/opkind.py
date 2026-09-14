"""One description per kind of planned operation, and the tables read off it.

A plan is a list of operations, each with a ``kind``. Everything an app does
with one is keyed by that kind: which keys it must carry, what to call it in
the line the user approves, what it writes to, what it deletes, whether it
reshapes what other operations address, how like operations fold into one
stored operation, and the code that applies it.

Each of those used to be its own table, written beside the others and kept in
step by hand. Adding a kind meant editing ten or thirteen places, and a test
that read the source with ``ast`` stood in for the fact that nothing held them
together. Here a kind is ONE frozen :class:`OpKind`, declared once, and every
table is a function of the registry.

An app declares its kinds with :func:`registry` and derives what it needs:
:func:`names`, :func:`required`, :func:`nouns`, :func:`shaped`,
:func:`token_keys`, :func:`compact_spec`, :func:`removed_ids`,
:func:`removed_tokens`. The executor asks :func:`kind_of` for the operation in
front of it, which raises on a kind nobody declared rather than letting it
through as a write of nothing.

The vocabulary of ``shape`` and ``stage`` past the two constants here is the
app's own: what counts as reshaping is a fact about what the app annotates.
"""

from collections import Counter
from dataclasses import dataclass, field as _field
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

# An operation that changes nothing about the shape of what it touches: the
# ordinary case, and the default.
ORDINARY = 'ordinary'
# An operation standing for everything a predicate matches, resolved to the
# operations it covers at approval. It never reaches the executor.
SCOPE = 'scope'
# An operation that rewrites its whole subject, so it is the only one in its
# plan.
EXCLUSIVE = 'exclusive'

# The stage of the executor that applies a kind. ``BATCH`` is the first pass
# and the default; ``RESOLVED`` is a kind the executor never sees because it
# was resolved beforehand. An app names any further stages itself.
BATCH = 'batch'
RESOLVED = 'resolved'


@dataclass(frozen=True)
class OpKind:
    """What an app knows about one kind of planned operation.

    ``name``      the ``kind`` value operations carry.
    ``noun``      (singular, plural) for the user: the approval line, the
                  applied message, and the per-kind counts are all this word.
    ``required``  keys an operation of this kind must carry, checked before
                  anything is written.
    ``apply``     ``(ctx, op) -> int | None``: what the executor does with one
                  operation. The number is how many changes it stands for
                  (``None`` means one). Every kind whose ``stage`` the
                  executor runs needs one.
    ``stage``     which pass of the executor applies it.
    ``target``    ``op -> hashable``: what the operation writes to, so a
                  second operation on the same target within one turn replaces
                  the first. ``None`` where nothing can supersede it.
    ``at``        keys naming the entity the operation lands on, in the order
                  to try them, for the row on the approval card. A key holding
                  a list is read at its first entry.
    ``at_kind``   the app's word for what ``at`` names, so the card knows how
                  to resolve it. Empty where an operation is placed some other
                  way, or at its document alone.
    ``token_keys``keys naming an entity the operation WRITES TO, so an
                  operation whose subject another operation in the same plan
                  deletes can be dropped instead of failing the batch. Never
                  the entity the operation itself removes.
    ``deletes``   ``op -> ids``: entities this operation deletes.
    ``deletes_tokens`` ``op -> ids``: the subset of those that are tokens,
                  which other operations address positionally.
    ``shape``     how it changes the shape of what it touches, so a table of
                  like kinds is read off the registry rather than listed
                  beside it.
    ``compact_each`` the keys that vary between like operations, so a large
                  group of them is stored as one (see ``core.plan``). Empty
                  where a kind is never folded.
    ``compact_label`` the group's line, where the kind writes its own rather
                  than taking the registry's.
    ``summary``   ``(op, n) -> [(noun, count)]`` where one operation counts as
                  something other than ``n`` of its own noun.
    """

    name: str
    noun: Tuple[str, str]
    required: Tuple[str, ...] = ()
    apply: Optional[Callable[[Any, Dict[str, Any]], Optional[int]]] = None
    stage: str = BATCH
    target: Optional[Callable[[Dict[str, Any]], Any]] = None
    at: Tuple[str, ...] = ()
    at_kind: str = ''
    token_keys: Tuple[str, ...] = ()
    deletes: Optional[Callable[[Dict[str, Any]], Iterable[str]]] = None
    deletes_tokens: Optional[Callable[[Dict[str, Any]], Iterable[str]]] = None
    shape: str = ORDINARY
    compact_each: Tuple[str, ...] = ()
    compact_label: Optional[Callable[[Dict[str, Any], List[Dict[str, Any]]], str]] = None
    summary: Optional[Callable[[Dict[str, Any], int], Sequence[Tuple[Tuple[str, str], int]]]] = None
    extra: Mapping[str, Any] = _field(default_factory=dict)


class UnknownKind(ValueError):
    """A plan carries an operation of a kind nobody declared."""


def registry(kinds: Iterable[OpKind]) -> Dict[str, OpKind]:
    """The kinds by name, in declaration order. A name declared twice is a
    mistake worth catching at import rather than at apply time."""
    out: Dict[str, OpKind] = {}
    for k in kinds:
        if k.name in out:
            raise ValueError(f'op kind {k.name!r} is declared twice')
        out[k.name] = k
    return out


def check_applicable(reg: Mapping[str, OpKind], ops: Iterable[Dict[str, Any]], first: int = 1) -> None:
    """Refuse, BEFORE any pass of the executor runs, a plan carrying a kind
    nobody declared or one that should have been resolved away.

    Either would otherwise be applied as nothing at all, under an operation
    label saying it was applied, which is the worst outcome a plan has."""
    for i, op in enumerate(ops, start=first):
        spec = kind_of(reg, op, index=i)
        if spec.apply is None:
            raise UnknownKind(f'op {i} ({spec.name}): this kind is resolved before the plan is applied')


def kind_of(reg: Mapping[str, OpKind], op: Any, index: Optional[int] = None) -> OpKind:
    """The declaration for one operation. Raises :class:`UnknownKind` when
    there is none: a kind nobody wired up must refuse, never be applied as
    nothing under a label saying it was applied."""
    name = op.get('kind') if isinstance(op, dict) else None
    spec = reg.get(name)
    if spec is None:
        where = f'op {index}: ' if index is not None else ''
        raise UnknownKind(f'{where}unknown kind {name!r}')
    return spec


# --- the tables ------------------------------------------------------------------

def names(reg: Mapping[str, OpKind]) -> Tuple[str, ...]:
    return tuple(reg)


def required(reg: Mapping[str, OpKind]) -> Dict[str, Tuple[str, ...]]:
    return {name: k.required for name, k in reg.items()}


def nouns(reg: Mapping[str, OpKind]) -> Dict[str, Tuple[str, str]]:
    return {name: k.noun for name, k in reg.items()}


def shaped(reg: Mapping[str, OpKind], *shapes: str) -> Tuple[str, ...]:
    """Every kind tagged with one of ``shapes``."""
    return tuple(name for name, k in reg.items() if k.shape in shapes)


def staged(reg: Mapping[str, OpKind], *stages: str) -> Tuple[str, ...]:
    return tuple(name for name, k in reg.items() if k.stage in stages)


def token_keys(reg: Mapping[str, OpKind]) -> Dict[str, Tuple[str, ...]]:
    return {name: k.token_keys for name, k in reg.items() if k.token_keys}


def located_at(reg: Mapping[str, OpKind], at_kind: str) -> Dict[str, Tuple[str, ...]]:
    """The keys that place each kind of operation whose subject is
    ``at_kind``, for the row on the approval card."""
    return {name: k.at for name, k in reg.items() if k.at and k.at_kind == at_kind}


def compact_spec(reg: Mapping[str, OpKind], label: Optional[Callable] = None) -> Dict[str, Dict[str, Any]]:
    """The folding rules ``core.plan.compact_ops`` takes, for every kind that
    declares per-member keys. ``label`` writes the group's line for the kinds
    that do not write their own."""
    out: Dict[str, Dict[str, Any]] = {}
    for name, k in reg.items():
        if not k.compact_each:
            continue
        fn = k.compact_label or label
        if fn is None:
            raise ValueError(f'op kind {name!r} folds into groups but has no line to show for one')
        out[name] = {'each': k.compact_each, 'label': fn}
    return out


def _ids(fn, op) -> Iterable[str]:
    return [i for i in (fn(op) or ()) if i]


def removed_tokens(reg: Mapping[str, OpKind], ops: Iterable[Dict[str, Any]]) -> set:
    """Tokens the plan deletes. Everything else it plans against one of them
    is writing to something that will not be there."""
    out: set = set()
    for op in ops:
        spec = reg.get(op.get('kind'))
        if spec is not None and spec.deletes_tokens:
            out.update(_ids(spec.deletes_tokens, op))
    return out


def removed_ids(reg: Mapping[str, OpKind], ops: Iterable[Dict[str, Any]]) -> set:
    """Everything the plan deletes, tokens included. A patch of one of these
    is a request against something gone, and the batch it shares is atomic."""
    out = removed_tokens(reg, ops)
    for op in ops:
        spec = reg.get(op.get('kind'))
        if spec is not None and spec.deletes:
            out.update(_ids(spec.deletes, op))
    return out


def target_of(reg: Mapping[str, OpKind], op: Dict[str, Any]):
    """What an operation writes to, or ``None`` when nothing can supersede
    it. An undeclared kind has no target rather than raising: this runs while
    a plan is being built, where a bad kind is the tool's own bug and the
    executor is the place that refuses it."""
    spec = reg.get(op.get('kind'))
    return spec.target(op) if spec is not None and spec.target else None


def summarize(reg: Mapping[str, OpKind], ops: Iterable[Dict[str, Any]],
              count_of: Optional[Callable[[OpKind, Dict[str, Any]], int]] = None,
              common_first: bool = False) -> str:
    """A plan in one phrase, for the audit label and the applied message.

    ``count_of(spec, op)`` says how many changes one stored operation stands
    for (a folded group, a scope); the default is one. The phrase runs in the
    order the kinds first appear, or largest first with ``common_first``."""
    c: Counter = Counter()
    for op in ops:
        spec = reg.get(op.get('kind'))
        if spec is None:
            # Nothing here refuses a plan (the executor does that); showing the
            # identifier beats leaving the change out of the line silently.
            name = str(op.get('kind'))
            c[(name, name)] += 1
            continue
        n = count_of(spec, op) if count_of else 1
        for noun, k in (spec.summary(op, n) if spec.summary else [(spec.noun, n)]):
            c[noun] += k
    if not c:
        return 'no changes'
    items = c.most_common() if common_first else list(c.items())
    return ', '.join(f'{n} {one if n == 1 else many}' for (one, many), n in items)


def stored_count(spec: OpKind, op: Dict[str, Any]) -> int:
    """How many changes one stored operation stands for: a folded group says
    so, and a scope carries the count its preview found."""
    if op.get('compact') or spec.shape == SCOPE:
        return int(op.get('count') or 1)
    return 1
