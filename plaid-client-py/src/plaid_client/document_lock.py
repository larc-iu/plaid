"""Keeping a document lock alive for as long as a ``locked()`` block runs.

plaid-core expires a document lock about a minute after it was taken, and the
holder's own writes are what renew it (``plaid.sql.operation`` calls
``refresh-locks!`` on every write it accepts). That is the right rule for an
editor, which writes as the person types. It is the wrong one for a service: a
parser loads a model, reads the document, spends minutes in inference and only
then writes, so for most of its run it holds nothing. The lock lapses in
silence, a person's edit lands between the read the work was planned from and
the write about to go out, and the write clobbers it.

A ``locked()`` block therefore renews on a timer of its own. The renewal is an
acquire that names the holder's ``lock_id``: the server refreshes the lock that
id holds, and refuses one somebody else holds (the same user included).

A block may also say when to stop renewing (``should_renew``): a service run
that has been stopped and is not inside its writes lets the lock lapse, so a
model call that hangs after Stop cannot hold the document past the window.

The beat is unconditional rather than "only when no write has gone out
recently". The request layer knows the method of a call but not which document
it touched, so a write to some other document would count as a renewal here and
would not be one. Two extra requests a minute is the whole cost.

A renewal that fails means the block is no longer holding what it asked for, so
it stops the run: the loss is recorded on the client and every later write
raises :class:`DocumentLockLost`. The guard sits in the request layer because
the callers are services, and a check they have to remember to call is a check
that is missing somewhere.
"""

import logging
import threading
import time

logger = logging.getLogger(__name__)

class DocumentLockLost(Exception):
    """The lock a ``documents.locked()`` block was holding is no longer held.

    Raised by the keep-alive when it cannot renew the lock, and then by the
    request layer on every write this client attempts, so work that has been
    running for minutes stops rather than writing over an edit that may have
    landed while the lock was gone.

    Attributes:
        document_id: The document whose lock lapsed.
        cause: The failure the renewal hit, if there was one.
    """

    def __init__(self, message, document_id='', cause=None):
        super().__init__(message)
        self.document_id = document_id
        self.cause = cause


def lock_ttl_s(expires_at, server_now_s) -> float:
    """How long a freshly taken lock lasts, from the server's own answer.

    ``expires_at`` is the epoch-millisecond moment the lock endpoints return,
    on the server's clock, so it is read against the server's clock too
    (``client.server_now()``): this machine's clock being off cannot stretch
    or shrink the window. It is how a window an operator has retuned
    (``:plaid.server.locks/config :expiration-ms``) reaches the keeper.
    """
    if isinstance(expires_at, (int, float)) and not isinstance(expires_at, bool):
        ttl = expires_at / 1000.0 - server_now_s
        if 0 < ttl <= _MAX_TTL_S:
            return float(ttl)
    # No answer at all, or one past an hour or already over: this machine's
    # clock stood in for the server's and is far off. Core's default window
    # is the better guess.
    return _DEFAULT_TTL_S


# Core's default lock window, and the longest one believed.
_DEFAULT_TTL_S = 60.0
_MAX_TTL_S = 3600.0


class LockKeeper:
    """Renews one document's lock until the block holding it exits.

    ``refresh`` is called with the document id and must raise on failure.
    ``on_lost`` is called once, with the :class:`DocumentLockLost`, when the
    lock can no longer be assumed.

    ``should_renew``, when given, is asked before each renewal. While it
    answers False the keeper renews nothing and asks again every
    :attr:`retry_s`, and the lock is lost at the last of those asks that
    comes before the window it last renewed runs out, less
    :attr:`margin_s` for the renewal's latency. So the server still holds the
    lock when the keeper gives it up: a ``critical()`` block entered before
    that is renewed at the next ask on a live lock, and one entered after it
    has its first write refused before anything is written. A stopped service
    run uses it to let the document go while its main thread is stuck in a
    call that never reaches a checkpoint.

    ``clock`` and ``sleep`` exist so the whole policy can be run on a fake
    clock: ``sleep(delay)`` returns True once the block has exited.
    """

    def __init__(self, refresh, document_id, ttl_s, *, on_lost=None,
                 should_renew=None, clock=time.monotonic, sleep=None):
        self._refresh = refresh
        self._should_renew = should_renew
        self._document_id = document_id
        self._ttl_s = float(ttl_s)
        self._on_lost = on_lost
        self._clock = clock
        self._done = threading.Event()
        self._sleep = sleep if sleep is not None else self._done.wait
        self._thread = None
        #: The :class:`DocumentLockLost` this keeper raised, or None.
        self.lost = None

    @property
    def interval_s(self) -> float:
        """Time between renewals: half the window, so a renewal that fails has
        a second chance before the lock it is renewing expires."""
        return max(1.0, self._ttl_s / 2)

    @property
    def retry_s(self) -> float:
        """Time before retrying a renewal that failed. A blip should not end a
        run that the server still considers the holder of."""
        return max(0.5, self._ttl_s / 10)

    @property
    def margin_s(self) -> float:
        """How long before the window ends a run that stopped renewing gives
        the lock up, beyond the next ask: room for a renewal's answer, which
        the server's expiry does not wait for."""
        return min(1.0, self._ttl_s / 4)

    def run(self) -> None:
        """The beat. Returns when the block exits or the lock is lost."""
        deadline = self._clock() + self._ttl_s
        delay = self.interval_s
        while not self._sleep(delay):
            if self._should_renew is not None and not self._should_renew():
                if self._clock() + self.retry_s + self.margin_s >= deadline:
                    self._fail(None)
                    return
                delay = self.retry_s
                continue
            # The window is counted from when the renewal was sent, since the
            # server starts it on receipt, not when its answer gets back.
            sent = self._clock()
            try:
                self._refresh(self._document_id)
            except Exception as error:
                # 423 is definitive: somebody else holds the document now, or
                # ours expired or was dropped, and the server never takes it
                # back. Anything else may be a blip, and is only fatal once the
                # lock we are renewing has actually run out.
                if getattr(error, 'status', 0) == 423 or self._clock() >= deadline:
                    self._fail(error)
                    return
                delay = self.retry_s
                continue
            deadline = sent + self._ttl_s
            delay = self.interval_s

    def start(self) -> None:
        self._thread = threading.Thread(target=self.run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._done.set()

    def _fail(self, error) -> None:
        from plaid_client.http import short_error
        if error is None:
            logger.info('Let the lock on document %s lapse: the run was stopped', self._document_id)
            message = f'The lock on document {self._document_id} lapsed: the run was stopped.'
        else:
            logger.warning('Could not renew the lock on document %s: %s',
                           self._document_id, short_error(error))
            message = f'The lock on document {self._document_id} lapsed: it could not be renewed.'
        self.lost = DocumentLockLost(message, document_id=self._document_id, cause=error)
        if self._on_lost is not None:
            self._on_lost(self.lost)


class DocumentLock:
    """What a ``with client.documents.locked(doc_id) as lock:`` block gets.

    The block does not have to consult it: a lost lock stops the next write on
    its own. Read ``lock.lost`` (or call ``lock.raise_if_lost()``) to give up
    earlier, between steps of work that has not written anything yet.
    """

    __slots__ = ('document_id', 'lock_id', '_keeper')

    def __init__(self, document_id, keeper=None, lock_id=None):
        self.document_id = document_id
        #: The holder id the acquire answered with.
        self.lock_id = lock_id
        self._keeper = keeper

    @property
    def lost(self):
        """The :class:`DocumentLockLost` if the lock lapsed, else None."""
        return self._keeper.lost if self._keeper is not None else None

    def raise_if_lost(self) -> None:
        lost = self.lost
        if lost is not None:
            raise lost
