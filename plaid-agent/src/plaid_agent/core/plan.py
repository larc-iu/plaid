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
import logging
import unicodedata
import uuid
from contextlib import ExitStack, contextmanager
from typing import Any, Dict, Iterable, List, Optional

# created_id is plaid_client's reader of a create response, kept here for a plan that reads one.
from plaid_client import DocumentLockLost, PlaidAPIError, created_id, metadata_ops, uuid7  # noqa: F401
from plaid_client.client import MAX_BATCH_OPS
from plaid_client.http import minted_taken
from plaid_client.ids import drawn_uuid7
from plaid_client.service import locked_for_writes

from .opkind import MEMBER, ROW
from plaid_client.services import UNKNOWN_OUTCOME, requester_message
from plaid_client.provenance import (confirmed_inferred, contribute_on_edit, stamp_contributed, PROV_KEY, PROV_SOURCE_KEY,
                                     PROV_CONFIRMED_KEY, PROV_PROB_KEY, PROV_DETAIL_KEY)

# How an approval is recorded. 'verified' is the default: the assistant made
# it, a reviewer confirmed it. 'human' is the reviewer saying the work is
# their own. 'contributed' is a contributor's approval, which is their own
# unreviewed work rather than a confirmation of anyone's.
STAMP_MODES = ('verified', 'human', 'contributed')
# Fragments, sent with metadata_ops, which turns a None into a delete.
CLEAR_PROV = {PROV_KEY: None, PROV_SOURCE_KEY: None, PROV_CONFIRMED_KEY: None, PROV_PROB_KEY: None,
              PROV_DETAIL_KEY: None}
CONFIRM = {PROV_CONFIRMED_KEY: True}

BATCH_OP_BUDGET = 800  # the server caps one atomic batch at 1000 ops (MAX_BATCH_OPS)
BULK_CHUNK = 1000      # entities one bulk update request carries
_UNSET = object()

# The most ops one plan may hold. A plan is stored in the conversation record,
# which has a budget and a hard cap on the server, so this is a storage limit
# rather than a matter of taste: past it the turn comes back with no plan at
# all, after the model has already announced one. Anything that reaches a
# whole document or the whole corpus is stored as a single scope op and costs
# one, so the cap bites only on ops that name their targets one by one.
PLAN_MAX_OPS = 3000


class PlanFull(Exception):
    """Staging these ops would push the plan past :data:`PLAN_MAX_OPS`."""


def reserve(staged: int, n: int, note: str = '', cap: int = PLAN_MAX_OPS) -> None:
    """Refuse BEFORE staging what would not fit, so a tool never leaves half
    of its changes behind. ``note`` is the app's own sentence about what
    counts as one change.

    Raises :class:`PlanFull`, which each app turns into its own tool error.
    """
    if staged + n > cap:
        raise PlanFull(
            f'That would bring the plan to {staged + n} changes, more than the {cap} one plan may '
            f'hold. Let the user approve what is planned and go on in another turn, or narrow it.'
            + (f' {note}' if note else ''))


class Minter:
    """The ids an applied plan creates its rows under, drawn in order from a
    seed: the plan's own id, a UUIDv7 minted when the plan was staged.

    Applying the same plan again draws the same ids in the same order, so a
    create whose first send landed (its answer lost, the service restarted)
    is answered from that send under its Idempotency-Key, or refused as
    ``id-taken``, and never makes a second row. The nth id is a UUIDv7 just
    after the seed, one step of its 12-bit counter each, so the ids sort in
    the order they were drawn and are dated when the plan was staged. Its 62
    random bits are a hash of the seed and n.

    A create refused ``id-taken`` for one of these ids was made by an earlier
    run of the same plan (:meth:`made`): the row it names exists, and the
    plan goes on past it.
    """

    def __init__(self, seed: str):
        u = uuid.UUID(seed)
        if u.version != 7:
            raise ValueError(f'a plan draws its ids from a UUIDv7, not {seed!r}')
        self.seed = str(u)
        self._n = 0
        self._drawn: set = set()

    def __call__(self) -> str:
        n, self._n = self._n, self._n + 1
        made = drawn_uuid7(self.seed, n)
        self._drawn.add(made)
        return made

    def made(self, error, whole: bool = False) -> bool:
        """Whether ``error`` refuses a create because an id this plan drew is
        taken: an earlier run of the plan made that row. Its answer was lost,
        or the service stopped before the record said so, and the key that
        would have replayed it is gone or was never the plan's (a batch of
        comments alone takes one of its own).

        For a single create, not when that row has been deleted since: the
        client's rule (``minted_taken``). For a batch or a bulk create
        (``whole``), one transaction, a taken id means the earlier run made
        all of it, whichever row the server names and whether a person
        deleted it since."""
        if not isinstance(error, PlaidAPIError):
            return False
        data = getattr(error, 'response_data', None)
        if whole:
            data = {k: v for k, v in data.items() if k != 'deleted'} if isinstance(data, dict) else data
        return minted_taken(error.status, data, self._drawn)

    def once(self, create, whole: bool = False):
        """Run ``create()``, a write made on the client that makes rows under
        ids this plan drew. Refused because an earlier run made them, it is
        taken as made and answers None. ``whole`` for a batch or a bulk
        create (see :meth:`made`)."""
        try:
            return create()
        except PlaidAPIError as e:
            if self.made(e, whole=whole):
                return None
            raise


def drawable(plan_id) -> bool:
    """Whether a plan's id is one its ids can be drawn from (a UUIDv7)."""
    try:
        return uuid.UUID(str(plan_id)).version == 7
    except ValueError:
        return False


# The version a document had when the first run of a plan took hold of it,
# kept on the plan's record of that document.
HELD_FROM = 'held_from'


def held_from(client, documents: List[Dict[str, Any]], remember) -> None:
    """Hold each document the plan holds (``holding``) at the version its
    first run held it at, so a run again sends the requests the first run sent
    (the document version is part of a keyed request) and the ones that landed
    are answered from their first send. Each answer moves the version on as
    it did the first time.

    The first run records the versions on the plan's ``documents`` (compacted
    away once the plan is settled) and writes the record with ``remember()``
    before anything is sent, so a service that stops partway leaves them for
    the next approval."""
    held = getattr(client, HELD_DOCUMENTS, None) or {client.strict_mode_document_id} - {None}
    fresh = False
    for d in documents or []:
        if not isinstance(d, dict) or d.get('id') not in held:
            continue
        if d.get(HELD_FROM) is not None:
            client.document_versions[d['id']] = d[HELD_FROM]
        elif client.document_versions.get(d['id']) is not None:
            d[HELD_FROM] = client.document_versions[d['id']]
            fresh = True
    if fresh:
        remember()


def forget_held(documents: List[Dict[str, Any]]) -> None:
    """A run that wrote nothing leaves no versions to repeat: the next one
    holds the documents as they are then."""
    for d in documents or []:
        if isinstance(d, dict):
            d.pop(HELD_FROM, None)


class Batcher:
    """Queue client calls into atomic batches of at most ``budget`` ops,
    flushing as the budget fills. ``add`` takes ``fn(batch)`` and calls it with
    the open batch, which is what every write inside it must be made on: a
    write made on the client goes over the wire at once, outside the
    transaction. ``add`` returns a GLOBAL result index valid after the next
    ``flush``; ``results`` accumulates across flushes.

    ``update`` queues a value and/or metadata ops on one entity. At the
    next flush the queued updates go into the same atomic batch as ONE bulk
    sub-op per resource and chunk (``spans.bulk_update`` and its siblings),
    so a plan of thousands of updates is a handful of sub-ops instead of one
    per span, each re-dispatched through the whole server. The bulk sub-ops
    are appended after everything ``add`` queued in the batch, which is the
    order the executors need: what a pass creates or deletes comes first,
    what it rewrites on entities that already exist comes last.

    A plan over several documents holds each at its own version
    (:func:`holding`), and a write carries the version of the document it is
    for, which the executor names with :meth:`writing_for` around each op.
    A write made outside one carries none. Updates are kept per document, so
    one bulk update never reaches two of them.

    Every create names the id of its row, drawn from ``new_id``, and a later
    write names that id, in the same batch or another: nothing waits on a
    create's answer.
    """

    def __init__(self, client, budget: int = BATCH_OP_BUDGET, ids: Optional[Minter] = None):
        self.client = client
        self.budget = budget
        #: the id of the next row the plan creates (see :class:`Minter`)
        self.new_id = ids or Minter(uuid7())
        self.results: List[Any] = []
        self._pending = 0   # sub-ops in the open batch (result indexes)
        self._weight = 0    # what the open batch stands for, against the budget
        self._batch = None  # the open batch, or None between flushes
        # (document, resource) -> entity id -> the update queued on it
        self._bulk: Dict[tuple, Dict[str, Dict[str, Any]]] = {}
        #: the document the writes queued now are for (see ``writing_for``)
        self.document: Optional[str] = None
        # How deep inside one change's writes the executor is (``writing_for``
        # with an op). The budget is not checked there, so a change is never
        # cut across two batches.
        self._held = 0

    @contextmanager
    def writing_for(self, op_or_document):
        """Queue the block's writes for one document: an op's, when it
        reaches exactly one (``docs_of_op``), or a document id. Under a hold
        of several documents each write then carries that document's
        version, and a batch of the plan's that lands after the apply gave up
        on it is refused over an edit made since, as a one-document plan's
        is.

        Given an op, the block is one change: its writes go in one batch,
        the budget checked once it ends, so a failure leaves the change
        whole or not written. Only a change that would take the batch past
        the server's cap (``MAX_BATCH_OPS``) is cut."""
        change = isinstance(op_or_document, dict)
        if change:
            docs = docs_of_op(op_or_document)
            document = next(iter(docs)) if len(docs) == 1 else None
        else:
            document = op_or_document
        previous, self.document = self.document, document
        if change:
            self._held += 1
        try:
            yield
        finally:
            self.document = previous
            if change:
                self._held -= 1
        if change and not self._held and self._weight >= self.budget:
            self.flush()

    @contextmanager
    def _stamping(self):
        """Under a hold of several documents, point strict mode at the one
        the writes queued in the block are for (a queued write takes its
        stamp when it is queued), and at none again after, so a write the
        executor makes on the client itself carries no other document's
        version."""
        held = getattr(self.client, HELD_DOCUMENTS, None)
        if not held:
            yield
            return
        self.client.strict_mode_document_id = self.document if self.document in held else None
        try:
            yield
        finally:
            self.client.strict_mode_document_id = None

    @contextmanager
    def on_client(self, document: Optional[str]):
        """For the writes the executor makes on the client itself, outside
        the batches (a text update, a restore): under a hold of several
        documents they carry ``document``'s version, as a queued write does,
        so one whose answer was lost cannot land after the apply gave up on
        it, over an edit made since."""
        previous, self.document = self.document, document
        try:
            with self._stamping():
                yield
        finally:
            self.document = previous

    def add(self, fn, weight: int = 1, count: int = 1) -> int:
        """Queue what ``fn(batch)`` writes: ``count`` sub-ops, which land in
        one batch together. Returns the result index of the first."""
        if self._batch is not None and self._held and self._pending + count > MAX_BATCH_OPS:
            # A change too big for one batch: the server would take this
            # write in a request of its own anyway.
            self.flush()
        if self._batch is None:
            self._batch = self.client.batch()
        with self._stamping():
            fn(self._batch)
        idx = len(self.results) + self._pending
        self._pending += count
        self._weight += weight
        if self._weight >= self.budget and (not self._held or self._pending >= MAX_BATCH_OPS):
            self.flush()
        return idx

    def update(self, resource: str, entity_id: str, value: Any = _UNSET,
               metadata: Optional[List[Dict[str, Any]]] = None) -> None:
        """Queue a value and/or metadata ops (see ``plaid_client.metadata_ops``)
        on ``entity_id`` of ``resource`` ('spans', 'relations' or 'tokens').
        An earlier update of the same entity in this flush is joined: its ops
        run first, then these."""
        item = self._bulk.setdefault((self.document, resource), {}).setdefault(entity_id, {'id': entity_id})
        if value is not _UNSET:
            item['value'] = value
        if metadata:
            item.setdefault('metadata', []).extend(metadata)
        if sum(len(v) for v in self._bulk.values()) >= self.budget:
            self._drain()

    def _drain(self) -> None:
        """Turn the queued updates into bulk sub-ops of the open batch."""
        pending, self._bulk = self._bulk, {}
        for (document, resource), items in pending.items():
            entries = list(items.values())
            with self.writing_for(document):
                for i in range(0, len(entries), BULK_CHUNK):
                    chunk = entries[i:i + BULK_CHUNK]
                    self.add(lambda batch, r=resource, c=chunk: getattr(batch, r).bulk_update(c),
                             weight=len(chunk))

    def flush(self) -> None:
        self._drain()
        batch, self._batch = self._batch, None
        if batch is None:
            return
        try:
            res = batch.submit()
        except PlaidAPIError as e:
            if not self.new_id.made(e, whole=True):
                raise
            # An earlier run of this plan committed this very batch: the same
            # plan draws the same ids and cuts the same batches, and a batch
            # is written whole or not at all, so one row of it made means all
            # of it was. It counts as written, and the plan goes on.
            res = [None] * self._pending
        self.results.extend(res or [])
        self._pending = 0
        self._weight = 0


class Tracker:
    """Where an executor's batcher registers itself, so a failure that did not
    come out of ``flush`` can still say how much stood.

    Only a failure inside ``flush`` carries ``_applied`` out with it.
    Everything else raised mid-plan (a service refusing, an entity that could
    not be made) arrives bare, and reporting zero there told the user
    "Nothing was written" while earlier batches stood committed. The batcher
    itself is the count, and this is how :func:`applying` reaches it.
    """

    def __init__(self):
        self.batcher: Optional['TrackingBatcher'] = None

    @property
    def applied(self) -> int:
        return self.batcher.applied if self.batcher is not None else 0


class TrackingBatcher(Batcher):
    """A :class:`Batcher` that counts what has actually been committed.

    Each batch commits on its own, so a plan that fails half way has really
    written its earlier batches. The count rides out on the exception, where
    the app's ``execute_plan`` turns it into :class:`PlanError.applied`: the
    user is told what stands rather than being left to find out. A bulk
    sub-op counts for every entity it carried.
    """

    def __init__(self, client, budget: int = BATCH_OP_BUDGET, tracker: Optional[Tracker] = None,
                 ids: Optional[Minter] = None):
        super().__init__(client, budget, ids)
        self.applied = 0
        #: batches that committed
        self.flushed = 0
        # Card row (see ``opkind.ROW``): [ops from it, ops finished, batches
        # that must commit before all their writes stand].
        self._rows: Dict[Any, List[int]] = {}
        # The same for each member of a folded row (``opkind.MEMBER``), keyed
        # (row, member).
        self._members: Dict[Any, List[int]] = {}
        if tracker is not None:
            tracker.batcher = self

    def flush(self) -> None:
        self._drain()
        n = self._weight
        sending = self._batch is not None
        try:
            super().flush()
        except Exception as e:
            e._applied = self.applied
            # A batch whose answer was lost may have been saved all the same,
            # which counting it as not applied told the user was nothing.
            e._unknown = outcome_unknown(e)
            raise
        self.applied += n
        if sending:
            self.flushed += 1

    # A change on the card is written when every operation it became has
    # queued or sent all its writes (``finish``) and the batches holding them
    # committed. An executor calls ``expect`` with the operations it is about
    # to run, and ``finish`` for each once its last write is queued or made.

    def expect(self, ops: List[Dict[str, Any]]) -> None:
        for op in ops:
            if op.get(ROW) is not None:
                self._rows.setdefault(op[ROW], [0, 0, 0])[0] += 1
                if op.get(MEMBER) is not None:
                    self._members.setdefault((op[ROW], op[MEMBER]), [0, 0, 0])[0] += 1

    def finish(self, op: Dict[str, Any]) -> None:
        row = self._rows.get(op.get(ROW))
        if row is None:
            return
        queued = self._batch is not None or any(self._bulk.values())
        need = self.flushed + (1 if queued else 0)
        member = self._members.get((op.get(ROW), op.get(MEMBER)))
        for counts in (row, member) if member is not None else (row,):
            counts[1] += 1
            counts[2] = max(counts[2], need)

    def _stands(self, counts: List[int]) -> bool:
        n, done, need = counts
        return done == n and need <= self.flushed

    def written_rows(self) -> List[Any]:
        """The card rows every write of which stands."""
        return sorted(r for r, counts in self._rows.items() if self._stands(counts))

    def written_members(self) -> Dict[Any, int]:
        """For each card row that folds many changes, how many of them stand
        in full, where that is some and not all (a row written whole is in
        :meth:`written_rows`)."""
        out: Dict[Any, int] = {}
        for (row, _), counts in self._members.items():
            if self._stands(counts):
                out[row] = out.get(row, 0) + 1
        whole = set(self.written_rows())
        return {r: n for r, n in out.items() if r not in whole}


def outcome_unknown(error) -> bool:
    """Whether ``error`` is a write whose answer never came back (a reset, a
    timeout), so it may have been saved. A refused connection sent nothing."""
    return (isinstance(error, PlaidAPIError) and not error.status
            and requester_message(error) == UNKNOWN_OUTCOME)


class PlanError(Exception):
    """A plan failed part-way.

    ``applied`` is how many WRITES had already been committed when it failed,
    counted in batch calls: each atomic batch commits on its own, and the
    operation label is only an audit grouping. One plan op can be several
    calls, so this is NOT a count of the plan's changes and must never be
    shown as a fraction of ``total`` (which is ops). What it is good for is
    the only question that matters here: did anything land. The write it
    failed on is not counted, and ``unknown`` says it may have landed too,
    when its answer was lost.
    """

    def __init__(self, message: str, applied: int, total: int, unknown: bool = False,
                 written: Optional[List[Any]] = None, members: Optional[Dict[Any, int]] = None,
                 partly: Optional[List[Any]] = None):
        super().__init__(message)
        self.applied = applied
        self.total = total
        #: The write it failed on got no answer, so it may have landed too.
        self.unknown = unknown
        #: The card rows written in full (``TrackingBatcher.written_rows``).
        self.written = written
        #: Of each folded row not written in full, how many of its changes
        #: were (``TrackingBatcher.written_members``).
        self.members = members
        #: The card rows another service wrote in part for the plan (a parse
        #: that stopped partway), which no batch of the plan's counts. The
        #: message says how much, in that service's words.
        self.partly = list(partly or [])

    @property
    def wrote(self) -> bool:
        """Whether anything the plan asked for may stand."""
        return bool(self.applied or self.unknown or self.partly)


def applying(ops: List[Dict[str, Any]], run) -> Dict[str, int]:
    """Run an app's executor and let nothing out of it but :class:`PlanError`,
    carrying how much of the plan really landed.

    ``run(tracker)`` is the executor; it hands the :class:`Tracker` to its
    :class:`TrackingBatcher`. Without this an executor's own raise, after
    batches had already committed, reported nothing written.
    """
    tracker = Tracker()

    def written():
        return tracker.batcher.written_rows() if tracker.batcher is not None else []

    def members():
        return tracker.batcher.written_members() if tracker.batcher is not None else {}
    try:
        return run(tracker)
    except PlanError as e:
        if e.written is None:
            e.written = written()
        if e.members is None:
            e.members = members()
        raise
    except PlanOutOfDate as e:
        # Found out of date by a write the server refused: settled as out of
        # date when nothing stands, as partly applied when something does.
        if not tracker.applied:
            raise
        raise PlanError(' '.join(e.reasons), tracker.applied, len(ops), False, written(), members()) from e
    except Exception as e:  # noqa: BLE001 - every failure becomes one the user can read
        applied = getattr(e, '_applied', None)
        unknown = bool(getattr(e, '_unknown', False)) or outcome_unknown(e)
        # A client error is told the way every service tells one, without its
        # class or the server's address.
        if isinstance(e, PlaidAPIError):
            raise PlanError(requester_message(e), applied if applied is not None else tracker.applied,
                            len(ops), unknown, written(), members()) from e
        # The one message in the package that keeps a Python class name. This
        # one reaches the USER, after batches have already committed, and an
        # exception carrying no message of its own would otherwise leave them
        # a sentence with a blank in it. The counts beside it are what they
        # act on; the class name is for the operator reading the same line in
        # the log.
        raise PlanError(f'{type(e).__name__}: {e}',
                        applied if applied is not None else tracker.applied, len(ops), unknown,
                        written(), members()) from e


class Stamps:
    """The provenance a plan writes, under one approval mode.

    :meth:`stamp` is merged into everything the plan CREATES. :meth:`restamp`
    is patched onto an entity the plan REWRITES, where the new value is this
    plan's whatever the entity was before: a contributor's rewrite drops the
    entity's confirmation and machine keys, keeping nothing but the
    contributed stamp.

    ``detail`` is the provDetail of the plan's machine work: the model and
    the version of the turn that proposed it. A verified write carries it as
    it is. A contributor's approval is their own work, and keeps it with the
    assistant as ``guess``, as a contributor adopting a service's guess does
    (``WriterPolicy.adopt_stamp``). A write recorded as human carries none.
    """

    def __init__(self, mode: str, source: str, contributor: Optional[str] = None,
                 detail: Optional[Dict[str, Any]] = None):
        if mode not in STAMP_MODES:
            raise ValueError(f'stamp_mode must be one of {STAMP_MODES}')
        if mode == 'contributed' and not contributor:
            raise ValueError("stamp_mode 'contributed' needs the contributor's user id")
        self.mode = mode
        self.source = source
        self.contributor = contributor
        self.detail = dict(detail) if detail else None

    @property
    def human(self) -> bool:
        return self.mode == 'human'

    @property
    def contributed(self) -> bool:
        return self.mode == 'contributed'

    def stamp(self) -> Dict[str, Any]:
        if self.human:
            return {}
        if self.contributed:
            frag = stamp_contributed(self.contributor)
            if self.detail:
                frag[PROV_DETAIL_KEY] = {**self.detail, 'guess': self.source}
            return frag
        return confirmed_inferred(self.source, detail=self.detail)

    def restamp(self) -> Dict[str, Any]:
        # Every key goes: what an earlier producer recorded (its detail, its
        # probability) describes a value this write replaces.
        return {**CLEAR_PROV, **self.stamp()}

    def confirm(self, contributed_work: bool) -> Optional[Dict[str, Any]]:
        """What a confirmation patches onto one piece awaiting review, or None
        when this approval leaves it alone. ``contributed_work`` says the piece
        is a contributor's unreviewed work rather than machine output.

        The editor's rule (``WriterPolicy.confirm_stamp``): a contributor
        accepting a machine proposal makes it their own contribution, never a
        verification, and a contributor reviews no one's work, theirs or
        another contributor's. Any other approval confirms it."""
        if not self.contributed:
            return dict(CONFIRM)
        if contributed_work:
            return None
        return contribute_on_edit(None, self.contributor)


def confirm_preview(machine: int, theirs: int) -> str:
    """What a staged confirmation will do when the requester's work is
    reviewed, for the tool's answer: their approval makes the machine's
    annotations their own contribution and leaves contributors' work for a
    reviewer (``Stamps.confirm``)."""
    bits = []
    if machine:
        bits.append(f'{machine} machine annotation{"s" if machine != 1 else ""} will become your contribution')
    if theirs:
        bits.append(f'{theirs} contributor\'s annotation{"s" if theirs != 1 else ""} '
                    f'{"are" if theirs != 1 else "is"} left for a reviewer')
    return ', '.join(bits) + '. Your work is reviewed in this project, so nothing is marked verified.'


class ConfirmRows:
    """Which card rows of confirmations wrote something under this approval.
    A contributor's approval leaves another contributor's work alone, so a row
    of only that wrote nothing, and the card must not show it as applied."""

    def __init__(self):
        self.written: Dict[Any, int] = {}

    def add(self, op: Dict[str, Any], n: int) -> None:
        row = op.get(ROW)
        if row is not None:
            self.written[row] = self.written.get(row, 0) + n

    def unwritten(self) -> List[Any]:
        return sorted(r for r, n in self.written.items() if not n)


def confirm_note(accepted: int, left: int) -> Optional[str]:
    """The applied note of a contributor's approval of confirmations: how many
    became their own contribution and how many were left for a reviewer.
    None when there were none."""
    if not accepted and not left:
        return None
    bits = []
    if accepted:
        bits.append(f'{accepted} annotation{"s" if accepted != 1 else ""} accepted as your contribution')
    if left:
        bits.append(f'{left} contributor\'s annotation{"s" if left != 1 else ""} left for a reviewer')
    return ', '.join(bits)


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

# The keys an op carries for people rather than for the write. Two ops that
# differ only in these are the same change, so they never keep ops apart.
PRESENTATION_KEYS = ('label', 'change_at')


def labelled(place: str, change: str) -> Dict[str, Any]:
    """An op's ``label`` (``<place>: <change>``) and ``change_at``, where in
    it the change starts. A reader wanting the change alone asks
    :func:`change_of`, never splits the label: a document name may itself
    hold ``": "``. With no place the label is the change."""
    if not place:
        return {'label': change, 'change_at': 0}
    return {'label': f'{place}: {change}', 'change_at': len(place) + 2}


def change_of(op: Dict[str, Any]) -> Optional[str]:
    """The change an op's label describes, without its location, or None when
    the op was not built by :func:`labelled`."""
    at = op.get('change_at')
    label = op.get('label')
    if not isinstance(at, int) or not isinstance(label, str) or not 0 <= at <= len(label):
        return None
    return label[at:]


def by_document(names: List[str], limit: int = 0) -> str:
    """How many changes land in each document, largest first: one name per
    change, so the counts are exact. ``'In 2 documents: "A" 12, "B" 8.'``,
    and past ``limit`` names ``'…, and 3 more documents (5 changes).'``."""
    from .limits import BY_DOCUMENT_LINES
    limit = limit or BY_DOCUMENT_LINES
    counts: Dict[str, int] = {}
    for name in names:
        counts[name] = counts.get(name, 0) + 1
    if not counts:
        return ''
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    shown = ', '.join(f'"{name}" {n}' for name, n in ranked[:limit])
    rest = ranked[limit:]
    more = ''
    if rest:
        left = sum(n for _, n in rest)
        more = (f', and {len(rest)} more document{"s" if len(rest) != 1 else ""} '
                f'({left} change{"s" if left != 1 else ""})')
    k = len(counts)
    return f'In {k} document{"s" if k != 1 else ""}: {shown}{more}.'


def _hashable(v: Any):
    return json.dumps(v, sort_keys=True, ensure_ascii=False, default=str)


def compact_ops(ops: List[Dict[str, Any]], spec: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
    """``spec`` maps an op kind to ``{'each': keys, 'label': fn}``: ``each``
    are the keys that vary per member, and ops of that kind equal in EVERY
    other key (the :data:`PRESENTATION_KEYS` aside) form a group, so a key the spec did not
    foresee keeps an op out of a group rather than being dropped from it.
    ``label(first, members)`` writes the group's line. A group at or under
    :data:`COMPACT_ABOVE` is left as it is. Order is the order of first
    appearance.

    A change flagged as replacing a person's work (``replaces_work``, see
    core/work.py) is never folded: the card lists it on a row of its own."""
    groups: Dict[tuple, List[int]] = {}
    for i, op in enumerate(ops):
        s = spec.get(op.get('kind'))
        if s is None or op.get('replaces_work'):
            continue
        each = set(s['each'])
        key = tuple(sorted((k, _hashable(v)) for k, v in op.items() if k not in each and k not in PRESENTATION_KEYS))
        groups.setdefault(key, []).append(i)
    replaced: Dict[int, Dict[str, Any]] = {}
    dropped: set = set()
    for key, members in groups.items():
        if len(members) <= COMPACT_ABOVE:
            continue
        first = ops[members[0]]
        s = spec[first['kind']]
        each = list(s['each'])
        group = {k: v for k, v in first.items() if k not in each and k not in PRESENTATION_KEYS}
        group.update({'items': {k: [ops[i].get(k) for i in members] for k in each},
                      'count': len(members), 'compact': True})
        # The line is a string, or what `labelled` returns for one.
        line = s['label'](first, [ops[i] for i in members])
        group.update(line if isinstance(line, dict) else {'label': line})
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
            # A member of a card row knows which, so a plan that stops partway
            # can count the row's changes that were written.
            out.append({**fixed, **{k: vals[i] for k, vals in items.items()},
                        **({MEMBER: i} if ROW in fixed else {})})
    return out


# --- the two appliers that are the same wherever they run -------------------------
# A ``ctx`` here is the app's own execution context: it carries the client, the
# batcher ``b``, and the list of restores to run after the batches.

ANCHOR_LABEL_MAX = 200  # the server's ceiling on a comment's caption, in code points


def _extends(ch: str) -> bool:
    """Whether ``ch`` belongs to the character before it: a combining mark,
    a zero-width joiner, a variation selector, a skin tone or an emoji tag."""
    o = ord(ch)
    return (unicodedata.category(ch).startswith('M') or o == 0x200D or 0xFE00 <= o <= 0xFE0F
            or 0x1F3FB <= o <= 0x1F3FF or 0xE0020 <= o <= 0xE007F or 0xE0100 <= o <= 0xE01EF)


def clip_caption(text: str, limit: int = ANCHOR_LABEL_MAX) -> str:
    """``text`` cut to at most ``limit`` code points, backing off so the cut
    does not fall inside a character a person sees as one, as the editor's
    clipText does. A single such character longer than ``limit`` is cut by
    code point."""
    if len(text) <= limit:
        return text
    cut = limit
    while cut > 0 and (_extends(text[cut]) or text[cut - 1] == '\u200d'):
        cut -= 1
    # A flag is a pair of regional indicators: never keep half of one.
    ri = lambda c: 0x1F1E6 <= ord(c) <= 0x1F1FF  # noqa: E731
    if cut > 0 and ri(text[cut]):
        run = 0
        while run < cut and ri(text[cut - 1 - run]):
            run += 1
        cut -= run % 2
    return text[:cut] if cut > 0 else text[:limit]


def apply_add_comment(ctx, op) -> int:
    """A comment, unaudited like every comment and under the requester's name.
    The caption is shortened to the server's ceiling here, for every app."""
    label = clip_caption((op.get('anchor_label') or '').strip()).strip() or None
    ctx.b.add(lambda batch, o=op: batch.comments.create(o['entity_type'], o['entity_id'], o['body'],
                                                        anchor_label=label, id=ctx.b.new_id()))
    return 1


def apply_restore_document(ctx, op) -> int:
    """A restore runs after the batches: it is the server's own operation."""
    ctx.restores.append(op)
    return 1


class Resolution:
    """What the scopes of one plan resolve with: the client, the project, and
    the documents read so far, so two scopes over one document read it once.

    ``load`` is the app's document reader, because that is the one thing about
    reading a document that is the app's.
    """

    def __init__(self, client, project, load):
        self.client = client
        self.project = project
        self._load = load
        self._docs: Dict[str, Any] = {}

    def document(self, document_id: str):
        if document_id not in self._docs:
            self._docs[document_id] = self._load(self.client, self.project, document_id)
        return self._docs[document_id]


def docs_of_op(op: Dict[str, Any]) -> set:
    """The documents an op reaches: one, a list it carries, or every document a
    corpus-wide change matched. Every guard that reasons about what a plan
    touches asks this, the tools' as well as the executor's, so the two cannot
    drift into disagreeing about what an op reaches."""
    out = set()
    if op.get('document_id'):
        out.add(op['document_id'])
    out.update(op.get('document_ids') or [])
    out.update(op.get('documents') or [])
    return out


# --- holding the documents a plan writes ----------------------------------------
#
# A plan is applied in several requests: an app's executor needs the ids one
# batch mints before it can write what hangs off them. Between two of them the
# document is half written, and whoever opens it then sees the half. An editor
# that repairs on open can take what the first batch made for what an
# interrupted edit left and delete it, and the plan's next batch then fails on
# an id that is gone. A person's edit can land in the same gap. So an approval
# holds the lock on every document it writes, from the staleness check to the
# last write, as every multi-request writer does.

logger = logging.getLogger(__name__)

#: The attribute a client carries while a plan holds several documents: which
#: ones, each at its own version (see :func:`holding`).
HELD_DOCUMENTS = 'plan_held_documents'


class DocumentsBusy(Exception):
    """A document the plan writes could not be locked, so nothing was
    written. ``document_id`` names it. ``cause`` is None when another user
    holds it, else the failure the request met."""

    def __init__(self, document_id: str, cause: Optional[BaseException] = None):
        super().__init__(document_id)
        self.document_id = document_id
        self.cause = cause


class PlanOutOfDate(ValueError):
    """Something the plan names outside its documents is gone since it was
    made (a record the plan links to or changes, deleted or folded into
    another), so no version the staleness check reads has moved. Raised
    before anything is written, and settled like a stale document: the card
    stops offering Approve and the model is told to plan again. ``reasons``
    are sentences for the user, one per thing gone."""

    def __init__(self, reasons: List[str]):
        super().__init__('; '.join(reasons))
        self.reasons = list(reasons)


class ScopeMoved(Exception):
    """A change the plan stored as a scope, found again at approval, reaches
    other documents than it did when the plan was made. ``gained`` are the
    ids it reaches now and did not, ``lost`` the ones it no longer reaches.
    Raised before anything is written.

    A document it now reaches was never pinned, checked for staleness or
    locked, and its change was not on the card the user approved. One it no
    longer reaches means the card's count is wrong."""

    def __init__(self, gained: List[str], lost: List[str]):
        super().__init__(f'reaches {gained} it did not and no longer reaches {lost}')
        self.gained = gained
        self.lost = lost


def check_reach(op: Dict[str, Any], resolved: Iterable[Dict[str, Any]], doc_of) -> None:
    """Refuse a scope whose resolved changes reach other documents than the
    ``documents`` it recorded when it was staged. ``doc_of(change)`` is the
    document a resolved change writes to, or None for one outside any
    document. A scope that recorded no set names its one document itself,
    and cannot reach another."""
    recorded = op.get('documents')
    if recorded is None:
        return
    recorded = set(recorded)
    now = {doc_of(o) for o in resolved} - {None}
    if now != recorded:
        raise ScopeMoved(sorted(now - recorded), sorted(recorded - now))


def documents_to_lock(ops: List[Dict[str, Any]], documents: Iterable[Dict[str, Any]] = (),
                      exclude: Iterable[str] = ()) -> List[str]:
    """The documents an approved plan writes, in one order for every caller:
    every document the plan was pinned to and every one an op names, less
    those reached by a kind in ``exclude``, which another service carries out
    under a lock of its own (holding that document would refuse it)."""
    ops = expand_ops(ops)
    exclude = set(exclude)
    ids = {d.get('id') for d in documents or () if isinstance(d, dict)}
    for op in ops:
        ids |= docs_of_op(op)
    for op in ops:
        if op.get('kind') in exclude:
            ids -= docs_of_op(op)
    ids.discard(None)
    return sorted(ids)


@contextmanager
def holding(client, document_ids: Iterable[str]):
    """Hold the lock on each of ``document_ids`` for the block, released on
    the way out however it ends. Raises :class:`DocumentsBusy` before the block
    runs when one of them cannot be locked, releasing what it took. A document
    that is gone or unreadable (403, 404) is passed over: nothing can be
    written to it, and the staleness check inside the block names it.

    Each is ``client.documents.locked``, renewed on a beat while the block
    runs, and a write after a lock lapsed is refused (``DocumentLockLost``).
    A block that ran to its end made every write before any lapse, so a lapse
    found only on the way out is logged rather than raised over a plan that
    was applied.

    Each document is held at the version it has once locked, and the plan's
    writes carry it, so a batch of the plan's that lands after the apply gave
    up on it is refused over an edit made since. One document is the client's
    strict mode. Over several, strict mode names one document at a time: the
    executor's :class:`Batcher` points it at the document each write is for
    (``Batcher.writing_for``), which the client keeps in ``HELD_DOCUMENTS``
    for the block."""
    document_ids = list(document_ids)
    finished = False
    try:
        with ExitStack() as stack:
            held = []
            for did in document_ids:
                try:
                    stack.enter_context(locked_for_writes(client, did))
                    held.append(did)
                except PlaidAPIError as e:
                    status = getattr(e, 'status', 0)
                    if status in (403, 404):
                        continue
                    raise DocumentsBusy(did, None if status == 423 else e) from e
            if len(held) > 1:
                # Each `locked_for_writes` put strict mode on its own document
                # and puts back what it found on the way out. In between, no
                # write is stamped until the batcher names its document.
                client.strict_mode_document_id = None
                setattr(client, HELD_DOCUMENTS, frozenset(held))
                stack.callback(setattr, client, HELD_DOCUMENTS, None)
            yield
            finished = True
    except DocumentLockLost as e:
        if not finished:
            raise
        logger.warning('The lock on document %s lapsed after the last write: %s', e.document_id, e)


# --- the plan, as the model reads and edits it --------------------------------
# A plan is a list of labelled changes nobody has agreed to yet, so the model
# needs to see it, throw it away and take one line out of it. None of that
# depends on what the changes are, so it is written once here. An app whose
# plan carries more than `ops` (entries created alongside it, say) overrides
# what it has to and calls back here.

def plan_status(ws) -> str:
    if not ws.ops:
        return 'Nothing is planned yet.'
    out = [f'{len(ws.ops)} change(s) planned. The user approves or discards them as one plan.']
    for i, op in enumerate(ws.ops, start=1):
        where = f' ({op["ref"]})' if op.get('ref') else ''
        out.append(f'  {i}. {op.get("label")}{where}')
    return '\n'.join(out)


def discard_plan(ws) -> str:
    n = len(ws.ops)
    ws.ops.clear()
    return f'Discarded {n} planned change(s).' if n else 'Nothing was planned.'


def drop_planned(ws, indexes=None) -> str:
    from .args import whole
    from .tools import ToolError
    if not indexes:
        raise ToolError('Give indexes: the numbers plan_status shows, as a list.')
    try:
        drop = {whole(i, 'indexes') for i in indexes}
    except (TypeError, ValueError):
        raise ToolError('indexes must be the whole numbers plan_status shows, as a list, '
                        'e.g. [2, 5].')
    bad = [i for i in drop if not 1 <= i <= len(ws.ops)]
    if bad:
        raise ToolError(f'No planned change numbered {", ".join(str(b) for b in bad)}. '
                        f'{len(ws.ops)} are planned.')
    ws.ops[:] = [op for i, op in enumerate(ws.ops, start=1) if i not in drop]
    return f'Dropped {len(drop)} planned change(s). {len(ws.ops)} remain.'
