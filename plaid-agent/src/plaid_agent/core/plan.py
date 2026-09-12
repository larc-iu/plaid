"""Applying a plan: the mechanics every app's assistant shares.

What a plan CONTAINS is the app's own business, and so is the dispatch that
turns one op into client calls. What is here is the part that is the same
wherever a plan is applied, and subtle enough to want one copy of:

* batching against the server's cap on one atomic batch,
* keeping count of what was actually committed, so a failure part-way can say
  how far it got rather than leaving the user to guess,
* the provenance a plan writes, which is a cross-app convention rather than
  any one app's choice.

An app's ``execute_plan`` opens one :meth:`client.operation`, walks its own
ops with a :class:`TrackingBatcher` and a :class:`Stamps`, and lets
:class:`PlanError` out.
"""

import json
from typing import Any, Dict, List, Optional

from plaid_client.provenance import (confirmed_inferred, stamp_contributed, PROV_KEY, PROV_SOURCE_KEY,
                                     PROV_CONFIRMED_KEY, PROV_PROB_KEY, PROV_DETAIL_KEY)

# How an approval is recorded. 'verified' is the default: the assistant made
# it, a reviewer confirmed it. 'human' is the reviewer saying the work is
# their own. 'contributed' is a contributor's approval, which is their own
# unreviewed work rather than a confirmation of anyone's.
STAMP_MODES = ('verified', 'human', 'contributed')
# patch semantics: a null value deletes the key
CLEAR_PROV = {PROV_KEY: None, PROV_SOURCE_KEY: None, PROV_CONFIRMED_KEY: None, PROV_PROB_KEY: None,
              PROV_DETAIL_KEY: None}
CONFIRM = {PROV_CONFIRMED_KEY: True}

BATCH_OP_BUDGET = 800  # the server caps one atomic batch at 1000 ops
BULK_CHUNK = 1000      # entities one bulk update request carries
_UNSET = object()


class Batcher:
    """Queue client calls into atomic batches of at most ``budget`` ops,
    flushing as the budget fills. ``add`` returns a GLOBAL result index valid
    after the next ``flush``; ``results`` accumulates across flushes.

    ``update`` queues a value and/or a metadata patch on one entity. At the
    next flush the queued updates go into the same atomic batch as ONE bulk
    sub-op per resource and chunk (``spans.bulk_update`` and its siblings),
    so a plan of thousands of updates is a handful of sub-ops instead of one
    per span, each re-dispatched through the whole server. The bulk sub-ops
    are appended after everything ``add`` queued in the batch, which is the
    order the executors need: what a pass creates or deletes comes first,
    what it rewrites on entities that already exist comes last.
    """

    def __init__(self, client, budget: int = BATCH_OP_BUDGET):
        self.client = client
        self.budget = budget
        self.results: List[Any] = []
        self._pending = 0   # sub-ops in the open batch (result indexes)
        self._weight = 0    # what the open batch stands for, against the budget
        self._open = False
        self._bulk: Dict[str, Dict[str, Dict[str, Any]]] = {}

    def add(self, fn, weight: int = 1) -> int:
        if not self._open:
            self.client.begin_batch()
            self._open = True
        fn()
        idx = len(self.results) + self._pending
        self._pending += 1
        self._weight += weight
        if self._weight >= self.budget:
            self.flush()
        return idx

    def update(self, resource: str, entity_id: str, value: Any = _UNSET, metadata: Optional[Dict[str, Any]] = None) -> None:
        """Queue a value and/or a metadata patch on ``entity_id`` of
        ``resource`` ('spans', 'relations' or 'tokens'), merged with an
        earlier update of the same entity in this flush."""
        item = self._bulk.setdefault(resource, {}).setdefault(entity_id, {'id': entity_id})
        if value is not _UNSET:
            item['value'] = value
        if metadata:
            item.setdefault('metadata', {}).update(metadata)
        if sum(len(v) for v in self._bulk.values()) >= self.budget:
            self._drain()

    def _drain(self) -> None:
        """Turn the queued updates into bulk sub-ops of the open batch."""
        pending, self._bulk = self._bulk, {}
        for resource, items in pending.items():
            entries = list(items.values())
            for i in range(0, len(entries), BULK_CHUNK):
                chunk = entries[i:i + BULK_CHUNK]
                self.add(lambda r=resource, c=chunk: getattr(self.client, r).bulk_update(c), weight=len(chunk))

    def flush(self) -> None:
        self._drain()
        if not self._open:
            return
        try:
            res = self.client.submit_batch()
        except BaseException:
            if self.client.is_batch_mode():
                self.client.abort_batch()
            raise
        finally:
            self._open = False
        self.results.extend(res or [])
        self._pending = 0
        self._weight = 0


class TrackingBatcher(Batcher):
    """A :class:`Batcher` that counts what has actually been committed.

    Each batch commits on its own, so a plan that fails half way has really
    written its earlier batches. The count rides out on the exception, where
    the app's ``execute_plan`` turns it into :class:`PlanError.applied`: the
    user is told what stands rather than being left to find out. A bulk
    sub-op counts for every entity it carried.
    """

    def __init__(self, client, budget: int = BATCH_OP_BUDGET):
        super().__init__(client, budget)
        self.applied = 0

    def flush(self) -> None:
        self._drain()
        n = self._weight
        try:
            super().flush()
        except Exception as e:
            e._applied = self.applied
            raise
        self.applied += n


def created_id(r):
    """The id of an entity a batch created, out of that op's result."""
    if isinstance(r, dict):
        body = r.get('body')
        if isinstance(body, dict):
            return body.get('id')
    return None


class PlanError(Exception):
    """A plan failed part-way.

    ``applied`` is how many WRITES had already been committed when it failed,
    counted in batch calls: each atomic batch commits on its own, and the
    operation label is only an audit grouping. One plan op can be several
    calls, so this is NOT a count of the plan's changes and must never be
    shown as a fraction of ``total`` (which is ops). What it is good for is
    the only question that matters here: did anything land.
    """

    def __init__(self, message: str, applied: int, total: int):
        super().__init__(message)
        self.applied = applied
        self.total = total


class Stamps:
    """The provenance a plan writes, under one approval mode.

    :meth:`stamp` is merged into everything the plan CREATES. :meth:`restamp`
    is patched onto an entity the plan REWRITES, where the new value is this
    plan's whatever the entity was before: a contributor's rewrite drops the
    entity's confirmation and machine keys, keeping nothing but the
    contributed stamp.
    """

    def __init__(self, mode: str, source: str, contributor: Optional[str] = None):
        if mode not in STAMP_MODES:
            raise ValueError(f'stamp_mode must be one of {STAMP_MODES}')
        if mode == 'contributed' and not contributor:
            raise ValueError("stamp_mode 'contributed' needs the contributor's user id")
        self.mode = mode
        self.source = source
        self.contributor = contributor

    @property
    def human(self) -> bool:
        return self.mode == 'human'

    @property
    def contributed(self) -> bool:
        return self.mode == 'contributed'

    def stamp(self) -> Dict[str, Any]:
        if self.human:
            return {}
        return stamp_contributed(self.contributor) if self.contributed else confirmed_inferred(self.source)

    def restamp(self) -> Dict[str, Any]:
        if self.human:
            return CLEAR_PROV
        if self.contributed:
            return {**CLEAR_PROV, **stamp_contributed(self.contributor)}
        return confirmed_inferred(self.source)


# --- storing a large plan ---------------------------------------------------------
#
# A plan lives in the conversation record, which has a budget (see
# :mod:`.conversation`) and a hard cap on the server. One op per span costs
# about 600 bytes stored (the op, its label, and its row on the card), so a
# plan over one long document was several megabytes and the save was refused
# after the model had already announced the plan. Ops of one kind that differ
# only in what they name are stored as ONE op carrying the id lists, and
# expanded again when the plan is applied. The card shows such a group as one
# row, with the count in its label.

COMPACT_ABOVE = 12  # a group larger than this is stored as one op


def _hashable(v: Any):
    return json.dumps(v, sort_keys=True, ensure_ascii=False, default=str)


def compact_ops(ops: List[Dict[str, Any]], spec: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
    """``spec`` maps an op kind to ``{'each': keys, 'label': fn}``: ``each``
    are the keys that vary per member, and ops of that kind equal in EVERY
    other key (the label aside) form a group, so a key the spec did not
    foresee keeps an op out of a group rather than being dropped from it.
    ``label(first, members)`` writes the group's line. A group at or under
    :data:`COMPACT_ABOVE` is left as it is. Order is the order of first
    appearance."""
    groups: Dict[tuple, List[int]] = {}
    for i, op in enumerate(ops):
        s = spec.get(op.get('kind'))
        if s is None:
            continue
        each = set(s['each'])
        key = tuple(sorted((k, _hashable(v)) for k, v in op.items() if k not in each and k != 'label'))
        groups.setdefault(key, []).append(i)
    replaced: Dict[int, Dict[str, Any]] = {}
    dropped: set = set()
    for key, members in groups.items():
        if len(members) <= COMPACT_ABOVE:
            continue
        first = ops[members[0]]
        s = spec[first['kind']]
        each = list(s['each'])
        group = {k: v for k, v in first.items() if k not in each and k != 'label'}
        group.update({'items': {k: [ops[i].get(k) for i in members] for k in each},
                      'count': len(members), 'compact': True,
                      'label': s['label'](first, [ops[i] for i in members])})
        replaced[members[0]] = group
        dropped.update(members[1:])
    out = []
    for i, op in enumerate(ops):
        if i in replaced:
            out.append(replaced[i])
        elif i not in dropped:
            out.append(op)
    return out


def expand_ops(ops: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The per-item ops a stored plan stands for. An op that was never
    compacted comes back as it is."""
    out = []
    for op in ops:
        if not op.get('compact'):
            out.append(op)
            continue
        items = op.get('items') or {}
        fixed = {k: v for k, v in op.items() if k not in ('items', 'count', 'compact')}
        for i in range(int(op.get('count') or 0)):
            out.append({**fixed, **{k: vals[i] for k, vals in items.items()}})
    return out
