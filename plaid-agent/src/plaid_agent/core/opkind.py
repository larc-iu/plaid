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
    ``certain``   whether what ``deletes`` and ``deletes_tokens`` name is
                  certainly gone. False where the ids are a GUESS, so an
                  operation naming one of them can only be dealt with when the
                  plan is applied, never refused as the plan is built.
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
    certain: bool = True
    shape: str = ORDINARY
    compact_each: Tuple[str, ...] = ()
    compact_label: Optional[Callable[[Dict[str, Any], List[Dict[str, Any]]], str]] = None
    summary: Optional[Callable[[Dict[str, Any], int], Sequence[Tuple[Tuple[str, str], int]]]] = None
    extra: Mapping[str, Any] = _field(default_factory=dict)


class UnknownKind(ValueError):
    """A plan carries an operation of a kind nobody declared."""


# What an executor returns is the per-kind counts KEYED BY PLURAL NOUN, with
# what the plan dropped beside them under ``notes`` (``core.service`` reads it
# back out). A kind whose plural noun were that word would be overwritten by
# the list, and its count would reach the user as a list of sentences.
RESERVED_COUNT_KEYS = frozenset({'notes'})


def registry(kinds: Iterable[OpKind]) -> Dict[str, OpKind]:
    """The kinds by name, in declaration order. A name declared twice, or a
    noun that collides with what rides beside the counts, is a mistake worth
    catching at import rather than at apply time."""
    out: Dict[str, OpKind] = {}
    for k in kinds:
        if k.name in out:
            raise ValueError(f'op kind {k.name!r} is declared twice')
        if k.noun[1] in RESERVED_COUNT_KEYS:
            raise ValueError(f'op kind {k.name!r} cannot be counted as {k.noun[1]!r}: that is what an '
                             f'executor returns the dropped changes under')
        out[k.name] = k
    return out


def check_applicable(reg: Mapping[str, OpKind], ops: Iterable[Dict[str, Any]],
                     stages: Sequence[str], first: int = 1) -> None:
    """Refuse, BEFORE any pass of the executor runs, a plan carrying a kind
    nobody declared, one that should have been resolved away, or one staged
    for a pass this executor does not run.

    ``stages`` is every pass the caller is about to run, so a kind declared
    outside them refuses here rather than being skipped by each pass in turn,
    counted as nothing, and reported applied. All three would otherwise reach
    the user as an operation label saying a change was made that was not,
    which is the worst outcome a plan has."""
    for i, op in enumerate(ops, start=first):
        spec = kind_of(reg, op, index=i)
        if spec.apply is None:
            raise UnknownKind(f'op {i} ({spec.name}): this kind is resolved before the plan is applied')
        if spec.stage not in stages:
            raise UnknownKind(f'op {i} ({spec.name}): no pass of the executor applies a kind staged '
                              f'{spec.stage!r}')


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


def removed_tokens(reg: Mapping[str, OpKind], ops: Iterable[Dict[str, Any]],
                   *, only_certain: bool = False) -> set:
    """Tokens the plan deletes. Everything else it plans against one of them
    is writing to something that will not be there. ``only_certain`` leaves
    out the kinds whose ids are a guess (see :attr:`OpKind.certain`)."""
    out: set = set()
    for op in ops:
        spec = reg.get(op.get('kind'))
        if spec is not None and spec.deletes_tokens and (spec.certain or not only_certain):
            out.update(_ids(spec.deletes_tokens, op))
    return out


def removed_ids(reg: Mapping[str, OpKind], ops: Iterable[Dict[str, Any]],
                *, only_certain: bool = False) -> set:
    """Everything the plan deletes, tokens included. A patch of one of these
    is a request against something gone, and the batch it shares is atomic."""
    out = removed_tokens(reg, ops, only_certain=only_certain)
    for op in ops:
        spec = reg.get(op.get('kind'))
        if spec is not None and spec.deletes and (spec.certain or not only_certain):
            out.update(_ids(spec.deletes, op))
    return out


def written_to(reg: Mapping[str, OpKind], op: Dict[str, Any]) -> set:
    """The entities one operation writes to, by the keys its kind declares
    (:attr:`OpKind.token_keys`). A key may hold one id or a list of them."""
    spec = reg.get(op.get('kind'))
    if spec is None or not spec.token_keys:
        return set()
    out: set = set()
    for key in spec.token_keys:
        value = op.get(key)
        if isinstance(value, (list, tuple)):
            out.update(v for v in value if v)
        elif value:
            out.add(value)
    return out


def delete_clash(reg: Mapping[str, OpKind], planned: Sequence[Dict[str, Any]],
                 op: Dict[str, Any], gone: Optional[set] = None):
    """``(the operation that writes, the operation that deletes)`` where one of
    ``planned`` and ``op`` certainly deletes something the other writes to,
    else ``None``.

    Both directions, because refusing only one of them lets the same plan be
    built by staging its two halves the other way round. ``gone`` is what
    ``planned`` certainly deletes, for a caller that keeps it as the plan
    grows.
    """
    if gone is None:
        gone = removed_ids(reg, planned, only_certain=True)
    if gone:
        writes = written_to(reg, op) & gone
        if writes:
            killer = next((p for p in planned
                           if removed_ids(reg, [p], only_certain=True) & writes), None)
            return op, killer
    mine = removed_ids(reg, [op], only_certain=True)
    if mine:
        for prev in planned:
            if written_to(reg, prev) & mine:
                return prev, op
    return None


def clash_message(victim: Dict[str, Any], killer: Optional[Dict[str, Any]]) -> str:
    """What to tell the model when one change in a plan writes to what another
    deletes. Refused as the plan is built, in either order, so the model can
    drop one of the two and stage the rest now."""
    def name(op):
        return (op or {}).get('label') or (op or {}).get('kind') or 'a change'
    return (f'{name(victim)} writes to something this plan deletes ({name(killer)}). '
            'Keep one of the two (plan_status, drop_planned), or plan them in separate turns.')


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
