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


class Batcher:
    """Queue client calls into atomic batches of at most ``budget`` ops,
    flushing as the budget fills. ``add`` returns a GLOBAL result index valid
    after the next ``flush``; ``results`` accumulates across flushes."""

    def __init__(self, client, budget: int = BATCH_OP_BUDGET):
        self.client = client
        self.budget = budget
        self.results: List[Any] = []
        self._pending = 0
        self._open = False

    def add(self, fn) -> int:
        if not self._open:
            self.client.begin_batch()
            self._open = True
        fn()
        idx = len(self.results) + self._pending
        self._pending += 1
        if self._pending >= self.budget:
            self.flush()
        return idx

    def flush(self) -> None:
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


class TrackingBatcher(Batcher):
    """A :class:`Batcher` that counts what has actually been committed.

    Each batch commits on its own, so a plan that fails half way has really
    written its earlier batches. The count rides out on the exception, where
    the app's ``execute_plan`` turns it into :class:`PlanError.applied`: the
    user is told what stands rather than being left to find out.
    """

    def __init__(self, client, budget: int = BATCH_OP_BUDGET):
        super().__init__(client, budget)
        self.applied = 0

    def flush(self) -> None:
        n = self._pending
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
