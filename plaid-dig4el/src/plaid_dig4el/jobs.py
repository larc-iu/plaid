"""Background jobs: a persistent queue in dig4el's database and one worker thread.

A job acts as the person who started it (their Plaid token is stored on the row
until the job finishes). Jobs interrupted by a server restart go back in the queue
at startup and are given up after ``MAX_ATTEMPTS``.
"""

from __future__ import annotations

import queue
import threading
import traceback
from typing import Callable

from plaid_client import PlaidClient
from plaid_client.http import PlaidAPIError

from . import db
from .config import settings

Handler = Callable[[db.Job, PlaidClient], None]

MAX_ATTEMPTS = 2
INTERRUPTED = "The server restarted twice while this job was running. Run it again."
LOGIN_EXPIRED = "Your login expired before the job could read from Plaid. Log in and run it again."
REFUSED = "Plaid refused access to the language's data. Check your role on the project and run it again."

_handlers: dict[str, Handler] = {}
_queue: queue.Queue[str] = queue.Queue()
_worker: threading.Thread | None = None


def handler(kind: str) -> Callable[[Handler], Handler]:
    """Register the function that executes jobs of ``kind``."""

    def register(fn: Handler) -> Handler:
        _handlers[kind] = fn
        return fn

    return register


def enqueue(s: db.Session, kind: str, payload: dict, user_id: str, token: str) -> db.Job:
    """Add a job to the session. Call ``submit`` with its id once the session has
    committed, so the worker never sees a job before the rows it refers to."""
    job = db.Job(kind=kind, payload=payload, created_by=user_id, token=token)
    s.add(job)
    return job


def submit(job_id: str) -> None:
    _queue.put(job_id)


def start_worker() -> int:
    """Requeue what a previous process left behind, then start the worker. Returns
    the number of jobs requeued."""
    global _worker
    with db.session() as s:
        pending = (s.query(db.Job).filter(db.Job.status.in_(("queued", "running")))
                   .order_by(db.Job.created_at).all())
        ids = []
        for job in pending:
            if job.status == "running" and job.attempts >= MAX_ATTEMPTS:
                _finish(job, "failed", INTERRUPTED)
            else:
                job.status = "queued"
                ids.append(job.id)
        s.commit()
    for jid in ids:
        _queue.put(jid)
    if _worker is None:
        _worker = threading.Thread(target=_loop, name="dig4el-jobs", daemon=True)
        _worker.start()
    return len(ids)


def _finish(job: db.Job, status: str, error: str = "") -> None:
    job.status = status
    job.error = error
    job.finished_at = db.now()
    job.token = ""


def _loop() -> None:
    while True:
        jid = _queue.get()
        try:
            _run(jid)
        except Exception:  # never let the worker die
            traceback.print_exc()


def _run(jid: str) -> None:
    with db.session() as s:
        job = s.get(db.Job, jid)
        if job is None or job.status != "queued":
            return
        job.status = "running"
        job.attempts += 1
        job.started_at = db.now()
        s.commit()
        kind, token = job.kind, job.token
    fn = _handlers.get(kind)
    try:
        if fn is None:
            raise RuntimeError(f"No handler for job kind {kind!r}")
        fn(job, PlaidClient(settings().plaid_url, token))
        status, error = "done", ""
    except PlaidAPIError as e:
        status = "failed"
        error = {401: LOGIN_EXPIRED, 403: REFUSED}.get(e.status) or traceback.format_exc()[-4000:]
    except Exception:
        status, error = "failed", traceback.format_exc()[-4000:]
    with db.session() as s:
        job = s.get(db.Job, jid)
        _finish(job, status, error)
        s.commit()
