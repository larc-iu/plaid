"""Logical operations: the audit-log group a run of writes is labelled
with, its kind and reference, and the keys that make a rerun send the same
requests. The twin of plaid-client-js's operations.js. ``_Operations`` is a
mixin of PlaidClient.
"""

from __future__ import annotations

import logging
import uuid
from contextlib import contextmanager

from plaid_client.http import PlaidAPIError
from plaid_client.ids import uuid7

# The kinds an operation may say it is (``?group-kind=``), the server's closed
# list (plaid.sql.operation-group/kinds). An operation of any other kind is
# refused when it begins, before it writes anything.
_OPERATION_KINDS = ('assistant-plan', 'service-run', 'import', 'bulk-edit',
                    'guess-adoption', 'repair', 'review')


def _check_operation_kind(kind) -> None:
    """Raise ``ValueError`` for a ``kind`` the server would refuse."""
    if kind is not None and str(kind) not in _OPERATION_KINDS:
        raise ValueError(f'Unknown operation kind "{kind}". It is one of: '
                         f'{", ".join(_OPERATION_KINDS)}.')


_UNSET_MESSAGE = object()


class _OperationContext:
    """Yielded by ``with client.operation(...)``; lets the block refine the
    label (sent when the outermost operation ends)."""
    __slots__ = ('_group',)

    def __init__(self, group):
        self._group = group

    @property
    def id(self) -> str:
        return self._group['id']

    def set_message(self, message: str | None) -> None:
        if self._group['depth'] == 1:
            self._group['refined'] = message


class _Operations:
    """PlaidClient's logical operations (see the module note)."""

    def begin_operation(self, message: str | None, *, group_id: str | None = None,
                        kind: str | None = None, ref: str | None = None,
                        keys: dict | None = None, minted=None) -> str:
        """Begin a LOGICAL OPERATION: a user-meaningful action ("Merge
        morphemes", "Re-transcribe") implemented as many low-level writes,
        possibly across several batches and even a service round-trip. Until
        ``end_operation()``, every write is stamped with a client-minted
        ``?group-id=`` (and the message) so the audit log shows the whole run
        as ONE expandable entry labeled ``message``, with each write's own
        description underneath.

        Grouping is orthogonal to batches: a batch is a transaction boundary,
        an operation is an intent boundary. An operation is NOT atomic — if
        write 3 of 5 fails, writes 1–2 stay committed (and logged under the
        group). Use a batch inside the operation for any step that must be
        all-or-nothing.

        Nesting flattens: a ``begin_operation`` while one is open is a no-op
        that joins the outer operation (the outer label wins), and the
        matching ``end_operation`` is likewise a no-op. The label is recorded
        on the FIRST write, so an operation that is never ended (crash) is
        still labeled in the log.

        "Every write" is the writes of project data. Reads never join, and
        neither do the out-of-band signals shaped like a write (a document lock
        taken or renewed, a stopped service request, a service reporting
        itself, an admin control), and neither does a broadcast message
        (``messages.send_message``): none of them is audited, so there would
        be nothing under the label.

        ``kind`` says what kind of operation this is, for a program reading
        the log: one of ``assistant-plan``, ``service-run``, ``import``,
        ``bulk-edit``, ``guess-adoption``, ``repair`` or ``review`` (the server
        refuses any other, and so does this method: any other kind raises
        ``ValueError`` here, before anything is written). ``ref`` is a short string naming what the operation came from,
        in the shape its kind documents (the core manual, "Kinds of
        operation"). Both are recorded from the first write like the label,
        and a nested operation keeps the outer one's.

        ``keys`` (from ``key_seed()``) makes a run of the operation send the
        same requests as an earlier run with the same keys: the nth keyed
        request that joins it takes the Idempotency-Key ``<seed>.<n>`` and the
        document-version its first run claimed, so a request that landed is
        answered from its first send and writes nothing again. The count
        starts at 0 at each outermost begin. A nested operation joins the
        outer one's keys, unless it brings its own: then it numbers from 0
        under its own seed until its matching end, and the outer numbering
        resumes after it.

        Prefer the ``operation()`` context manager; this is the manual form.

        Args:
            message: Human label for the operation (shown as the audit-log entry).
            group_id: Optional. Adopt an existing group id instead of minting one
                (a service joining the requester's operation; ``BaseService`` does
                this automatically from the propagated ``operation_group`` field).
            kind: Optional. What kind of operation this is (see above).
            ref: Optional. What the operation refers to (see above).
            keys: Optional. A seed from ``key_seed()`` (see above).
            minted: Optional. The ids this operation mints for what it creates:
                a create refused 409 id-taken for one of them was made by an
                earlier send of the operation, and answers as made.

        Returns:
            The operation's group id.

        Raises:
            ValueError: ``kind`` is not one of the kinds listed above.
        """
        _check_operation_kind(kind)
        frame = {'keys': keys or None, 'count': 0, 'minted': set(minted) if minted else None,
                 'depth': 1, 'owned': False}
        open_group = self._operation_group
        self._opened_frame = None
        if open_group is not None:
            # A nested operation that brings its own key seed or ids numbers
            # the keys in a frame of its own until it ends, then the frame
            # under it numbers again.
            open_group['depth'] += 1
            if keys or minted:
                frame['depth'] = open_group['depth']
                open_group['frames'].append(frame)
                self._opened_frame = frame
            return open_group['id']
        self._operation_group = {
            'id': str(group_id) if group_id else str(uuid.uuid4()),
            'message': None if message is None else str(message),
            'kind': None if kind is None else str(kind),
            'ref': None if ref is None else str(ref),
            'depth': 1,
            'written': False,
            'refined': _UNSET_MESSAGE,
            'frames': [frame],
        }
        self._opened_frame = frame
        return self._operation_group['id']

    def key_seed(self) -> dict:
        """A seed for the Idempotency-Keys of a logical operation that may be
        run again from the top (see ``begin_operation``'s ``keys``). Keep it
        with the work it belongs to and pass it to every run.

        Returns:
            ``{'seed': <UUIDv7>, 'stamps': {}}``, where ``stamps`` comes to
            map each request's number to the version it claimed (None for
            none).
        """
        return {'seed': uuid7(), 'stamps': {}}

    def end_operation(self, message: str | None | object = _UNSET_MESSAGE) -> None:
        """End the current logical operation. With no argument this is purely
        local (no request). Pass a refined ``message`` to relabel the group now
        that the outcome is known (``end_operation('Merged 3 morphemes')``) —
        that sends one PATCH, skipped if the operation never wrote anything. A
        refine from a nested (flattened) ``end_operation`` is ignored; the
        outer label wins.

        Args:
            message: Optional. A refined label for the finished operation.
        """
        group = self._operation_group
        if group is None:
            return
        if group['depth'] > 1:
            # A frame begun at this depth by hand (begin_operation) ends here.
            # One begun by operation() is ended by that block itself.
            frames = group['frames']
            top = frames[-1]
            if len(frames) > 1 and not top['owned'] and top['depth'] == group['depth']:
                frames.pop()
            group['depth'] -= 1
            return
        self._operation_group = None
        refined = message if message is not _UNSET_MESSAGE else group['refined']
        if refined is not _UNSET_MESSAGE and group['written']:
            try:
                self.operation_groups.update(group['id'], refined)
            except PlaidAPIError as e:
                # 404: the group never materialized server-side (every tagged
                # write failed or a batch was aborted). Nothing to relabel.
                if e.status != 404:
                    raise

    @contextmanager
    def operation(self, message: str, *, kind: str | None = None, ref: str | None = None,
                  group_id: str | None = None, keys: dict | None = None, minted=None):
        """Run the block as one logical operation (see ``begin_operation``),
        ending it when the block exits — including on exception. The yielded
        object's ``set_message(msg)`` refines the label once the outcome is
        known::

            with client.operation('Merge morphemes') as op:
                with client.batched() as b:
                    ...
                op.set_message(f'Merged {n} morphemes')

        Not atomic (see ``begin_operation``): use ``batched()`` inside for any
        step that must be all-or-nothing. A service request made inside the
        block carries the operation to the service, whose writes then fold
        under this entry.

        ``kind`` and ``ref`` say what kind of operation this is and what it
        refers to (see ``begin_operation``)::

            with client.operation('Import ELAN corpus', kind='import', ref='format:elan'):
                ...

        Args:
            message: Human label for the operation (shown as the audit-log entry).
            kind: Optional. What kind of operation this is: one of
                ``assistant-plan``, ``service-run``, ``import``, ``bulk-edit``,
                ``guess-adoption``, ``repair`` or ``review``. Any other raises
                ``ValueError`` before the block runs.
            ref: Optional. What the operation refers to.
            group_id: Optional. Adopt an existing group id (see ``begin_operation``).
            keys: Optional. A seed from ``key_seed()`` (see ``begin_operation``).
            minted: Optional. The ids the block mints for what it creates: a
                create refused 409 id-taken for one of them answers as made.
        """
        self.begin_operation(message, group_id=group_id, kind=kind, ref=ref, keys=keys,
                             minted=minted)
        group = self._operation_group
        # The key frame this block opened is ended by this block, whatever
        # else began or ended meanwhile.
        frame = self._opened_frame
        if frame is not None:
            frame['owned'] = True
        ctx = _OperationContext(group)
        try:
            yield ctx
        except BaseException:
            self._drop_frame(group, frame)
            # A relabel the server refuses (a token scoped to projects may not
            # relabel a group, which names none) must not take the place of
            # the error the block raised: the caller answers for that one.
            try:
                self.end_operation()
            except PlaidAPIError as e:
                logging.getLogger(__name__).warning('The operation was not relabelled: %s', e)
            raise
        self._drop_frame(group, frame)
        self.end_operation()

    @staticmethod
    def _drop_frame(group, frame):
        """End the key frame ``frame`` of ``group``, wherever it is among the
        frames open."""
        if group is None or frame is None or group['frames'][0] is frame:
            return
        group['frames'] = [f for f in group['frames'] if f is not frame]
