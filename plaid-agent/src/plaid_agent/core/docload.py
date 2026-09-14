"""Reading a project's documents, overlapping the reads where that is safe.

A corpus question is a walk. The model's code says ``for d in documents():
load(d["id"])``, and each ``load`` is a host call that blocks the interpreter
while one HTTP GET goes out and comes back. Strictly one at a time, a
thousand-document project costs a thousand round trips end to end, and the
model waits through all of them.

The reads are independent, so they can overlap. What must not happen is
overlapping them without a ceiling. The server is meant to run on a small
machine, it keeps ten pooled database connections by default, and a fan-out
that asks for a whole corpus at once costs it far more in one moment than the
serial walk ever did, while an editor is trying to use the same server. So:
a small fixed number of workers (:data:`WORKERS`, which an operator may lower
or raise), and a walk is only read ahead of once it is clearly a walk.

The other half of the saving is not reading what will not be parsed. An app
knows which layers it reads, so it names them and the server never fetches,
serializes or compresses the rest. See each app's ``read_layer_ids``.

A parsed document is cached under ``(document id, version)``. Every write
inside a document bumps that version, and so does every write outside it that
restates the document's body. The version a turn compares against comes from
the document list it starts from, so a cached document is exact or unused. Any
reader of a project may read all of its documents, so one process-wide cache
is safe to share.

What this does NOT cover: renaming a layer, or changing its config, restates
every document in the project, and no version moves for it. A turn rebuilds
its project view from scratch, so it sees the new names, but a document cached
under an older parse keeps the old ones until it ages out. Closing that needs
a project-level version the server does not keep yet.
"""

import os
import threading
from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from .limits import DOC_CACHE_SIZE

# How many document reads may be in flight at once. Deliberately well under
# the server's default pool of ten: the assistant is one of several things
# talking to it, and leaving room is what keeps an editor responsive while a
# corpus walk runs.
WORKERS = 4

# After how many documents a turn's reads count as a walk and the rest of the
# list is read ahead of. Two is enough to tell a walk from a question about
# one document, and a question about two costs nothing extra.
WALK_AFTER = 2

# How many documents may be read ahead per worker. This is what bounds memory:
# a walk holds at most this many parsed documents beyond the one it is looking
# at, however long the corpus is.
WINDOW_PER_WORKER = 3

_ENV_WORKERS = 'PLAID_AGENT_READ_WORKERS'


def workers() -> int:
    """The ceiling, which an operator may move with ``PLAID_AGENT_READ_WORKERS``.
    One disables overlapping entirely, which is the setting for a server with
    nothing to spare."""
    raw = os.environ.get(_ENV_WORKERS)
    if not raw:
        return WORKERS
    try:
        return max(1, min(16, int(raw)))
    except ValueError:
        return WORKERS


class DocCache:
    """Parsed documents by ``(id, version)``, bounded, least recently used out.

    Shared by every turn in this process, so it is locked. The lock covers
    only the dictionary: parsing happens outside it, and two turns that want
    the same uncached document simply both parse it, which is cheaper than
    holding a lock across an HTTP request.
    """

    def __init__(self, size: Optional[int] = None):
        self.size = DOC_CACHE_SIZE if size is None else size
        self._lock = threading.Lock()
        self._entries: 'OrderedDict[tuple, Any]' = OrderedDict()

    def get(self, key: tuple) -> Optional[Any]:
        with self._lock:
            doc = self._entries.get(key)
            if doc is not None:
                self._entries.move_to_end(key)
            return doc

    def put(self, key: tuple, doc: Any) -> None:
        with self._lock:
            self._entries[key] = doc
            self._entries.move_to_end(key)
            while len(self._entries) > self.size:
                self._entries.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()


class Reader:
    """One turn's document reads, with the ones it can see coming started early.

    ``fetch`` is the app's own loader, ``(document id) -> parsed document``.
    It runs on worker threads, so it must not touch the workspace: it takes a
    client and a project and returns a value, and everything that files that
    value away happens back on the calling thread.

    Reading ahead is WINDOWED, not unbounded. A walk over a thousand documents
    that started all thousand would hold a thousand parsed documents in memory
    at once, which is a worse problem than the one being solved: the walk
    usually reads each document, counts something, and drops it. So a bounded
    number are in flight or waiting to be taken, and finishing one starts the
    next.
    """

    def __init__(self, fetch: Callable[[str], Any], cache: DocCache,
                 on_progress: Optional[Callable[[str], None]] = None):
        self._fetch = fetch
        self._cache = cache
        self._on_progress = on_progress or (lambda msg: None)
        self._pool: Optional[ThreadPoolExecutor] = None
        self._workers = workers()
        self._window = max(WINDOW_PER_WORKER * self._workers, 4)
        # Running or finished and not yet taken, capped at the window.
        self._inflight: 'OrderedDict[tuple, Future]' = OrderedDict()
        # Wanted, in the order they were asked for, not started yet.
        self._queued: 'OrderedDict[tuple, str]' = OrderedDict()
        self._lock = threading.Lock()
        self._closed = False
        # Distinct documents this turn has asked for, which is what tells a
        # walk from a question about one document.
        self._asked: set = set()
        self._read_ahead_done = False

    # --- reading ----------------------------------------------------------

    def get(self, doc_id: str, version: Optional[Any], label: str = '') -> Any:
        """The parsed document: from a read already running, from the cache, or
        read now on this thread.

        The order matters. A read that finished ahead of us has ALREADY put its
        document in the cache, so answering from the cache first would leave
        its window slot held by a finished read forever: the window fills with
        documents nobody is waiting for, nothing tops it up, and the rest of
        the walk goes back to reading one at a time. Taking the slot back is
        what keeps the reads running.
        """
        key = (doc_id, version)
        with self._lock:
            self._asked.add(doc_id)
            future = self._inflight.pop(key, None)
            self._queued.pop(key, None)
        if future is None and version is not None:
            cached = self._cache.get(key)
            if cached is not None:
                return cached
        # Said on THIS thread, in the order the caller takes documents, whether
        # the read is still running or starts here. A walk that reported only
        # the documents it had to wait for would go quiet exactly when the
        # reading ahead is working, which reads as a hang.
        self._on_progress(f'Reading "{label or doc_id}"…')
        if future is not None:
            doc = future.result()
            self._start_more()
            return doc
        doc = self._fetch(doc_id)
        self._remember(key, version, doc)
        return doc

    def _remember(self, key: tuple, version: Optional[Any], doc: Any) -> None:
        """Cache the document if it is still the version we asked for. One
        written between the list read and this read comes back at a later
        version, and caching it under the version we asked for would hand the
        next turn a document that is not what its key claims."""
        if version is not None and getattr(doc, 'version', None) == version:
            self._cache.put(key, doc)

    # --- reading ahead ----------------------------------------------------

    def walking(self) -> bool:
        """Whether this turn has asked for enough documents to be walking the
        corpus rather than asking about one."""
        return len(self._asked) >= WALK_AFTER

    def read_ahead(self, entries: Iterable[Tuple[str, Any]], *, once: bool = False) -> None:
        """Queue ``(document id, version)`` pairs to be read in the background,
        in the order given.

        Already cached, already queued and unversioned entries are skipped, so
        passing the whole document list when only some are wanted costs nothing
        for the rest. ``once`` makes the call a no-op after the first one, so
        the speculative path in a code run does not re-arm on every load.
        """
        if self._closed or (once and self._read_ahead_done):
            return
        with self._lock:
            if once and self._read_ahead_done:
                return
            for doc_id, version in entries:
                if version is None:
                    continue
                key = (doc_id, version)
                if key in self._queued or key in self._inflight:
                    continue
                if self._cache.get(key) is not None:
                    continue
                self._queued[key] = doc_id
            if once:
                self._read_ahead_done = True
        self._start_more()

    def _start_more(self) -> None:
        """Fill the window from the queue. Called after queueing and after
        each document is taken, so the reads stay one window ahead of the
        walk and no further."""
        with self._lock:
            if self._closed:
                return
            starting: List[Tuple[tuple, str]] = []
            # The window counts what is ALREADY running plus what this call is
            # about to start: reading len(self._inflight) alone leaves it
            # unchanged until the loop ends, and drains the whole queue.
            while self._queued and len(self._inflight) + len(starting) < self._window:
                key, doc_id = self._queued.popitem(last=False)
                starting.append((key, doc_id))
            if not starting:
                return
            if self._pool is None:
                self._pool = ThreadPoolExecutor(max_workers=self._workers,
                                                thread_name_prefix='plaid-doc-read')
            for key, doc_id in starting:
                self._inflight[key] = self._pool.submit(self._read_one, key, doc_id)

    def _read_one(self, key: tuple, doc_id: str) -> Any:
        doc = self._fetch(doc_id)
        self._remember(key, key[1], doc)
        return doc

    # --- lifecycle --------------------------------------------------------

    def close(self) -> None:
        """Stop reading ahead. Whatever has not started is dropped, so a turn
        that ended after three documents does not go on reading the other
        nine hundred."""
        with self._lock:
            self._closed = True
            pool, self._pool = self._pool, None
            self._inflight.clear()
            self._queued.clear()
        if pool is not None:
            pool.shutdown(wait=False, cancel_futures=True)
