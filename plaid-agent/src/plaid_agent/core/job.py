"""Unattended jobs: the worker and the parts of a job every app shares.

A writer starts a job on a project in the app, core stores it, and one worker
process (``plaid-job-worker``, :mod:`plaid_agent.jobworker`) takes jobs one at
a time across the server. It holds a claimed job with a heartbeat, writes with
a token core mints for the person who started the job, waits while people use
the model, and walks the job's documents in stretches of a few sentences, each
a fresh conversation (the jobs round of 2026-11-12, its SPEC and CONTRACT).

What is here is the app's business in none of it: the heartbeat and what it
learns (:class:`Job`), the budgets of a stretch and the decide-now line
(:class:`Pace`), how a stretch fails and how a failed one is halved
(:func:`failure_kind`, :func:`halve`), yielding to people on the model key,
the wait for a model that does not answer, the report's frame and the order
of a job's phases (:func:`run_job`). The app answers the rest through its
runner: the checks, the work on each document, the pass that makes the job's
own work consistent, and its parts of the report.
"""

import json
import logging
import math
import threading
import time
import unicodedata
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

import litellm
from plaid_client import DocumentLockLost, PlaidAPIError
from plaid_client.workflows.llm import did_not_answer, is_busy, is_timeout, transient_errors

from .agent import REPEATING_LINE, TurnCancelled, TurnFailed, token_counter, too_long
from .limits import (HARMONIZE_MAJORITY, JOB_CALL_DECIDE_AT_TOKENS, JOB_CORE_TRIES, JOB_CORE_WAIT_S,
                     JOB_DECISIONS_PER_CALL, JOB_CALL_MAX_PROMPT_TOKENS,
                     JOB_HEARTBEAT_S, JOB_MODEL_RETRY_S, JOB_REPORT_BUDGET_BYTES, JOB_REPORT_LIST_MAX,
                     JOB_STRETCH_DECIDE_AT_ROUNDS,
                     JOB_STRETCH_MAX_ROUNDS, JOB_STRETCH_MAX_SENT_TOKENS, JOB_YIELD_POLL_S, JOB_YIELD_QUIET_S,
                     JOB_YIELD_STEADY_S)
from .prompt import JOB_DECIDE_NOW, JOB_STEPS_USED_UP, job_cut_at_limit

logger = logging.getLogger(__name__)

#: How a stretch fails (CONTRACT 5.2 ``kind``).
BUDGET, CONTEXT, OUTPUT, REPEATING = 'budget', 'context', 'output', 'repeating'

#: What the job's line ends with while it takes turns with people on the
#: model (RPF-A6): from its first pause for them until JOB_YIELD_STEADY_S
#: pass with no pause, so a job yielding in bursts keeps one steady line in
#: place of a line that flips between its work and a pause every minute.
TAKING_TURNS = 'Taking turns with people using the model.'


def not_answering_line(seconds: float) -> str:
    """The job's line while the model does not answer. It says how long,
    never a clock time: the worker's clock is not the reader's."""
    minutes = max(1, round(seconds / 60))
    return f'The model is not answering. Trying again in {minutes} minute{"" if minutes == 1 else "s"}.'


class StretchFailed(Exception):
    """A stretch that cannot finish as it is: halved, or skipped when it is
    one sentence (SPEC 3.6). ``kind`` is one of the kinds above."""

    def __init__(self, kind: str, detail: str = ''):
        super().__init__(detail or kind)
        self.kind = kind


class JobStopped(Exception):
    """The job may not go on: ``why`` is ``cancelled`` (a person stopped it),
    ``failed`` (its starter can no longer write, core says), ``taken``
    (another worker holds it), ``gone`` (it or its project is gone) or
    ``finished``. Raised only at a checkpoint, never in a write."""

    def __init__(self, why: str):
        super().__init__(why)
        self.why = why


def not_answering(e: BaseException) -> bool:
    """A model call that failed because the endpoint is not answering: the
    deadline passed after its retries, the provider could not be reached or
    was down, or it was still busy after the wait. Not the stretch's fault,
    so it is asked again later rather than halved (SPEC 3.7)."""
    if isinstance(e, (StretchFailed, TurnFailed, TurnCancelled)) or too_long(e):
        return False
    return bool(is_timeout(e, litellm) or did_not_answer(e) or is_busy(e, litellm)
                or isinstance(e, transient_errors(litellm)))


def failure_kind(e: BaseException) -> Optional[str]:
    """The kind of a stretch's failure ``e``, or None when ``e`` is not one
    (SPEC 3.6): a budget spent, a context the endpoint refused, a call that
    reached the output cap or that the model's provider refused, a model
    repeating itself. A stop, a model that does not answer, and anything
    that did not come from the model call (a refusal of core, a network
    error to core, a fault of the worker's own) are not, and are never
    halved: the caller sorts them (:func:`core_fault`)."""
    if isinstance(e, StretchFailed):
        return e.kind
    if isinstance(e, TurnCancelled) or not_answering(e):
        return None
    if too_long(e):
        return CONTEXT
    if isinstance(e, TurnFailed):
        return REPEATING if str(e) == REPEATING_LINE else OUTPUT
    if type(e).__module__.split('.')[0] in ('litellm', 'openai'):
        return OUTPUT
    return None


class Pace:
    """The budgets of one stretch (SPEC 3.6), asked by the model loop before
    every call (``run_turn(..., pace=)``).

    A stretch fails when a call would be past :data:`JOB_STRETCH_MAX_ROUNDS`,
    when one call's prompt is over :data:`JOB_CALL_MAX_PROMPT_TOKENS`, or when
    the prompts sent over the stretch would pass
    :data:`JOB_STRETCH_MAX_SENT_TOKENS`, each counted here by the model's
    tokenizer, before the call goes out. The call numbered
    :data:`JOB_STRETCH_DECIDE_AT_ROUNDS`, or the first whose prompt reaches
    :data:`JOB_CALL_DECIDE_AT_TOKENS`, is sent the decide-now line once, and
    ``decided`` is called so the stretch offers the plan tools alone from then
    on. ``line`` is that line, a piece's unless given (the planning context
    is sent JOB_PLAN_NOW). ``before_call`` runs last, just before the call: the wait for people
    on the model key, which may raise to stop the job. One Pace spans every
    turn of a stretch: the budgets count the calls and tokens of all of
    them.

    ``output_tokens``: a ceiling on what one call may write, below the
    model's own cap (an operator's ``--piece-output-tokens``), None for
    none. ``asks_again`` (a piece's): the first call that reaches its
    output limit, whichever it is, is dropped and the context asked again
    once (:meth:`cut`), the second ends the turn as before.

    ``holds`` (a piece's): whether the context holds staged work. A budget
    that runs out while it does fails nothing: the context is sent ONE
    closing call, :data:`JOB_STEPS_USED_UP`, past the budgets, and
    ``closing`` is called first so the call offers no tool (BRIEF RW B2).
    No call follows it (``closed`` is then True, and a next call raises).
    The planning and the report's prose stage nothing and close nothing."""

    def __init__(self, model: str, before_call: Callable[[], None] = lambda: None,
                 count: Optional[Callable[[Any], int]] = None, decided: Callable[[], None] = lambda: None,
                 line: str = JOB_DECIDE_NOW, output_tokens: Optional[int] = None, asks_again: bool = False,
                 holds: Callable[[], bool] = lambda: False, closing: Callable[[], None] = lambda: None):
        self.count = count or token_counter(model)
        self.line = line
        self.output_tokens = output_tokens or None
        self.asks_again = asks_again
        self.holds = holds
        self.closing = closing
        self.closed = False
        self.cuts = 0
        self.before_call = before_call
        self.decided = decided
        self.told = False
        self.sent = 0
        self.calls = 0
        self.largest = 0

    def _prompt(self, kwargs: Dict[str, Any]) -> int:
        return self.count(kwargs.get('messages') or []) + (self.count(kwargs['tools']) if kwargs.get('tools') else 0)

    def note(self, rounds: int, kwargs: Dict[str, Any]) -> Optional[str]:
        """Before a call: the line it is sent with, if any. The calls'
        budget closes the piece (:meth:`close`), else the decide-now line
        comes once."""
        if self.closed:
            raise StretchFailed(BUDGET, 'a call after the closing call')
        # The calls of every turn of the stretch: a piece asked again (it
        # answered nothing) goes on from the calls its first answer used.
        rounds = max(rounds, self.calls)
        if rounds >= JOB_STRETCH_MAX_ROUNDS:
            return self.close(f'more than {JOB_STRETCH_MAX_ROUNDS} model calls')
        if self.told:
            return None
        if rounds + 1 >= JOB_STRETCH_DECIDE_AT_ROUNDS or self._prompt(kwargs) >= JOB_CALL_DECIDE_AT_TOKENS:
            self.told = True
            self.decided()
            return self.line
        return None

    def close(self, spent: str) -> str:
        """A budget is spent (``spent``, in words): the closing call's line
        when the context holds staged work, else the stretch fails."""
        if not self.holds():
            raise StretchFailed(BUDGET, spent)
        self.closed = True
        self.closing()
        return JOB_STEPS_USED_UP

    def sending(self, kwargs: Dict[str, Any]) -> Optional[str]:
        """The call as it will go out: its prompt's budgets, then the wait
        for people, then counted. A spent budget closes the piece: the
        closing call's line is answered, for the caller to send that call
        instead, never counted against the budgets."""
        if self.output_tokens:
            kwargs['max_tokens'] = min(kwargs.get('max_tokens') or self.output_tokens, self.output_tokens)
        n = self._prompt(kwargs)
        if not self.closed:
            if n > JOB_CALL_MAX_PROMPT_TOKENS:
                return self.close(f'a prompt of {n} tokens')
            if self.sent + n > JOB_STRETCH_MAX_SENT_TOKENS:
                return self.close(f'{self.sent + n} tokens sent')
        self.before_call()
        self.sent += n
        self.calls += 1
        self.largest = max(self.largest, n)
        return None

    def cut(self, limit: Optional[int]) -> Optional[str]:
        """After a call that reached its output limit (``limit`` tokens, the
        model's own cap or the ceiling): the line the context is asked again
        with, once, where the pace asks again, else None (the turn ends)."""
        if not self.asks_again or self.cuts or self.closed:
            return None
        self.cuts += 1
        return job_cut_at_limit(limit or self.output_tokens)


def halve(sentences: List[Any], attempt: Callable[[List[Any]], None],
          skip: Callable[[Any, str], None]) -> None:
    """Run ``attempt`` over ``sentences`` as one stretch, and a stretch that
    fails (:class:`StretchFailed`) as two, the first ceil(n/2) sentences and
    then the rest, each of them halved again on failure, in order. A failed
    stretch of one sentence is skipped with its failure's kind
    (``skip(sentence, kind)``). Nothing else is caught: a stop, a lost job,
    a model that does not answer are the caller's."""
    queue = [list(sentences)]
    while queue:
        part = queue.pop(0)
        if not part:
            continue
        try:
            attempt(part)
        except StretchFailed as e:
            if len(part) == 1:
                skip(part[0], e.kind)
            else:
                half = math.ceil(len(part) / 2)
                queue[0:0] = [part[:half], part[half:]]


def harmonized(job_keys: Dict[str, int], people_keys: Dict[str, int]):
    """The analysis a form's job-made words are all set to, by the fixed rule
    of SPEC 8: ``(key, by)`` with ``by`` ``'person'`` or ``'majority'``, or
    ``(None, reason)`` when the form is left. ``job_keys`` counts the job's
    own words of the form by analysis key, ``people_keys`` people's. Asked
    only of a form the job analysed in two or more ways."""
    if len(people_keys) >= 2:
        return None, 'people-differ'
    if len(people_keys) == 1:
        return next(iter(people_keys)), 'person'
    n = sum(job_keys.values())
    key, m = max(sorted(job_keys.items()), key=lambda kv: kv[1])
    num, den = HARMONIZE_MAJORITY
    if m * den >= num * n:
        return key, 'majority'
    return None, 'no-clear-majority'


def analysis_key(text: str) -> str:
    """The digest a decision is keyed by: the first 32 hex characters of the
    SHA-256 of its canonical text (CONTRACT 5.1)."""
    import hashlib
    return hashlib.sha256(text.encode('utf-8')).hexdigest()[:32]


def composed(text: str) -> str:
    """``text`` as core keeps and measures it: composed (NFC), which can
    make it longer (a precomposed nukta letter is two characters composed,
    REV-L2-2). Every capped text the worker sends core is measured and cut
    through this."""
    return unicodedata.normalize('NFC', text)


def canonical(value: Any) -> str:
    """JSON with sorted keys and no spaces, composed (:func:`composed`): the
    one spelling of a decision, as core keeps it."""
    return composed(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False))


def cut(items: List[Any], limit: int = JOB_REPORT_LIST_MAX):
    """``(the first limit items, how many more there were)``, a report's list
    and its ``-more`` count."""
    items = list(items)
    return items[:limit], max(0, len(items) - limit)


def _iso_seconds(text: Optional[str]) -> Optional[float]:
    if not text:
        return None
    try:
        return datetime.fromisoformat(str(text).replace('Z', '+00:00')).timestamp()
    except ValueError:
        return None


def api_code(e: BaseException) -> Optional[str]:
    data = getattr(e, 'response_data', None)
    return data.get('code') if isinstance(data, dict) else None


def plaid_error(e: Optional[BaseException]) -> Optional[PlaidAPIError]:
    """The refusal of core in ``e`` or in what caused it, or None. A
    document's lock lost (``DocumentLockLost``) carries what its renewal met
    as ``cause``, which is followed too: core refusing the renewal (423, a
    restart dropped the lock) or out of reach (REV-J-B3 B3-4)."""
    while e is not None:
        if isinstance(e, PlaidAPIError):
            return e
        if isinstance(e, DocumentLockLost) and e.cause is not None:
            e = e.cause
            continue
        e = e.__cause__ or e.__context__
    return None


def no_longer_mine(e: Optional[BaseException]) -> bool:
    """Was ``e``, or what caused it, core saying the job is no longer this
    worker's to work: its token refused because the job ended or another
    worker took it (401 ``job-ended``), a row or decision refused for the
    same reasons or because core failed the job (409 ``job-finished``,
    ``job-taken``, ``job-failed``), or the job gone (404 "Job not found")?"""
    err = plaid_error(e)
    if err is None:
        return False
    data = err.response_data if isinstance(err.response_data, dict) else {}
    return ((err.status == 401 and api_code(err) == 'job-ended')
            or (err.status == 409 and api_code(err) in ('job-finished', 'job-taken', 'job-failed'))
            or (err.status == 404 and data.get('error') == 'Job not found'))


def core_fault(e: Optional[BaseException]) -> Optional[str]:
    """What a refusal of core (or a network error to it) in ``e`` means to a
    job: ``mine`` (the job is no longer this worker's, :func:`no_longer_mine`),
    ``passing`` (core busy, down or unreachable for a while: a 5xx, a network
    error, 423, 429, tried again), ``access`` (the job's token refused, or a
    403 that is not core's "names nothing": the starter's right to write is
    gone, :meth:`Job.access_lost`), or ``other`` (anything else core refused).
    None when ``e`` holds no refusal of core."""
    err = plaid_error(e)
    if err is None:
        return None
    if no_longer_mine(err):
        return 'mine'
    status = err.status or 0
    if status == 0 or status in (423, 429) or status >= 500:
        return 'passing'
    data = err.response_data if isinstance(err.response_data, dict) else {}
    if status == 401 or (status == 403 and not data.get('unresolved')):
        return 'access'
    return 'other'


#: The reason a job ends with when the worker meets an error it has no rule
#: for (added to CONTRACT 6 by J-FIX-B): never a skip, never a loop.
WORKER_ERROR = 'worker-error'


def error_line(e: BaseException) -> str:
    """The job's message for an error the worker has no rule for, at most
    the 300 characters core keeps. The error's own words, never Python's
    class name (test_error_text): the worker's log has the traceback."""
    return composed(f'The job worker met an error and stopped the job: {e}')[:300]


class Job:
    """The worker's hold on one claimed job: the job as claimed, its rows,
    the token to write with, the heartbeat that keeps the lease and learns of
    a stop, and the waits a stretch may make.

    ``admin`` is the worker's own client (an administrator's), which makes
    the worker's calls. ``client_for(token)`` builds a client that writes as
    the starter, from the latest job token. ``now`` and ``sleep`` are the
    clock (tests pass their own)."""

    def __init__(self, admin, claimed: Dict[str, Any], worker_id: str, *, client_for: Callable[[str], Any],
                 pool: Optional[str] = None, now: Callable[[], float] = time.time,
                 sleep: Callable[[float], None] = time.sleep, model: Optional[str] = None,
                 heartbeat_s: float = JOB_HEARTBEAT_S):
        self.admin = admin
        self.job = claimed['job']
        self.id = self.job['id']
        self.project_id = self.job['project']
        self.instructions = self.job.get('instructions') or ''
        #: What the job was set up to do, as the app wrote it at the start
        #: (core keeps it verbatim and knows none of its keys), or None for a
        #: job started with none (BRIEF-SU): the app reads it.
        self.setup = self.job.get('setup')
        #: kept in the report as the instructions were when the job started
        self.starter = self.job.get('started_by')
        self.starter_name = self.job.get('started_by_name') or self.starter
        self.worker_id = worker_id
        self.token = claimed.get('token')
        self.state = self.job.get('state')
        self.client_for = client_for
        self.pool = pool
        self.model = model
        self.now = now
        self._sleep = sleep
        self.heartbeat_s = heartbeat_s
        self.rows: Dict[str, Dict[str, Any]] = {r['document_id']: dict(r) for r in self.job.get('documents') or []}
        self.order: List[str] = [r['document_id'] for r in sorted(self.job.get('documents') or [],
                                                                 key=lambda r: r.get('position') or 0)]
        # What the heartbeat sends: the phase, the line, what it waits for, where it works.
        self.status: Dict[str, Any] = {'phase': self.job.get('phase'), 'message': self.job.get('message'),
                                       'waiting_for': None, 'current_document': None}
        #: the job's line as its work says it, before :data:`TAKING_TURNS`
        self.line: Optional[str] = self.job.get('message')
        #: when the job last paused for people, or None (:meth:`shown`)
        self.shared_at: Optional[float] = None
        self.lost: Optional[str] = None
        self.reason: Optional[str] = None
        #: seconds the job took turns with people on the model, waited for
        #: people to finish editing a document (an app's ``edits``, RPF3-D1)
        #: and waited for a model not answering
        self.paused = {'people': 0.0, 'model': 0.0, 'edits': 0.0}
        self.started_at = self.job.get('started_at')
        self._beat_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # --- the heartbeat -------------------------------------------------------

    def start(self) -> None:
        self._thread = threading.Thread(target=self._beating, name=f'job-{self.id}-heartbeat', daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)

    def _beating(self) -> None:
        while not self._stop.wait(self.heartbeat_s):
            self.beat()
            if self.lost:
                return

    def beat(self) -> None:
        """One heartbeat: the status out, the job's state and a fresh token
        back. What core refuses with says the job is lost to this worker."""
        if self.lost:
            return
        with self._beat_lock:
            try:
                answer = self.admin.jobs.heartbeat(self.id, self.worker_id, **self.status)
            except PlaidAPIError as e:
                code = api_code(e)
                if e.status == 404:
                    self.lost = 'gone'
                elif code == 'job-taken':
                    self.lost = 'taken'
                elif code == 'job-failed':
                    self.lost = 'failed'
                    self.reason = (getattr(e, 'response_data', None) or {}).get('reason') or 'starter-access'
                elif code == 'job-finished':
                    self.lost = 'finished'
                else:
                    logger.warning('Job %s: a heartbeat was refused: %s', self.id, e)
                return
            except Exception as e:  # noqa: BLE001 - a beat that did not get through is tried at the next
                logger.warning('Job %s: a heartbeat did not get through: %s', self.id, e)
                return
            if isinstance(answer, dict):
                self.state = answer.get('state') or self.state
                self.token = answer.get('token') or self.token

    def ended(self) -> JobStopped:
        """Core refused a write (:func:`no_longer_mine`): the job ended or
        moved to another worker before the heartbeat said so. Ask the
        heartbeat why, and stop as it says (a starter who can no longer write
        still gets the job's report). Nothing more is written."""
        self.beat()
        return JobStopped(self.lost or 'finished')

    def access_lost(self) -> JobStopped:
        """Core refused the starter's token its access (SPEC 12): the job
        ends failed, ``starter-access``, with its report, unless the heartbeat
        says it already ended otherwise. Nothing is called gone for it."""
        self.beat()
        if self.lost and self.lost != 'failed':
            return JobStopped(self.lost)
        self.reason = self.reason or 'starter-access'
        return JobStopped('failed')

    def shown(self, line: Optional[str]) -> Optional[str]:
        """The line as the heartbeat carries it: ``line``, and
        :data:`TAKING_TURNS` after it while the job takes turns with people
        (it paused for them within JOB_YIELD_STEADY_S), decided from the
        worker's own state."""
        if self.shared_at is None or self.now() - self.shared_at >= JOB_YIELD_STEADY_S:
            return line
        return f'{line} {TAKING_TURNS}' if line else TAKING_TURNS

    def set(self, **status) -> None:
        """Change what the heartbeat says (phase, message, waiting_for,
        current_document) and send it now. ``message`` is the job's
        :attr:`line`, carried as :meth:`shown` says."""
        if 'message' in status:
            self.line = status['message']
            status['message'] = self.shown(self.line)
        changed = any(self.status.get(k) != v for k, v in status.items())
        self.status.update(status)
        if changed:
            self.beat()

    def say(self, message: str) -> None:
        """Change the heartbeat's line without sending it: the next heartbeat
        carries it. For a line that changes with every model call (BRIEF
        LV), which must never send heartbeats more often."""
        self.line = message
        self.status['message'] = self.shown(message)

    # --- checkpoints ---------------------------------------------------------

    def check(self) -> None:
        """Raise :class:`JobStopped` when the job may not go on. Asked
        between steps, never inside a write."""
        if self.lost:
            raise JobStopped(self.lost)
        if self.state == 'stopping':
            raise JobStopped('cancelled')

    def cancelled(self) -> bool:
        """For the model loop, which stops a stretch between calls."""
        return bool(self.lost) or self.state == 'stopping'

    def sleep(self, seconds: float) -> None:
        """Wait, checking for a stop at least every half second."""
        end = self.now() + seconds
        while True:
            self.check()
            left = end - self.now()
            if left <= 0:
                return
            self._sleep(min(0.5, left))

    def client(self):
        """A client that writes as the starter, with the latest token."""
        return self.client_for(self.token)

    # --- waits ---------------------------------------------------------------

    def yield_to_people(self) -> None:
        """Before a model call: wait while anyone's request to a service on
        the same model key is in flight, and for a quiet minute after the last
        one (SPEC 4). A worker with no pool yields to nothing."""
        if not self.pool:
            return
        waited = None
        try:
            while True:
                self.check()
                load = self.admin.jobs.model_busy(self.pool) or {}
                last = _iso_seconds(load.get('last_finished_at'))
                if not load.get('in_flight') and (last is None or self.now() - last >= JOB_YIELD_QUIET_S):
                    return
                # The line keeps its words and says the job takes turns
                # with people, steady while it yields in bursts (RPF-A6).
                self.shared_at = self.now()
                if waited is None:
                    waited = self.now()
                    self.set(waiting_for='people', message=self.line)
                self.sleep(JOB_YIELD_POLL_S)
        finally:
            if waited is not None:
                self.paused['people'] += self.now() - waited
                self.shared_at = self.now()
                if not self.lost:
                    self.set(waiting_for=None, message=self.line)

    def wait_for_model(self) -> None:
        """The model did not answer: say so, wait :data:`JOB_MODEL_RETRY_S`
        and let the caller ask again (SPEC 3.7). A stop ends the wait."""
        began, said = self.now(), self.line
        self.set(waiting_for='model', message=not_answering_line(JOB_MODEL_RETRY_S))
        try:
            self.sleep(JOB_MODEL_RETRY_S)
        finally:
            self.paused['model'] += self.now() - began
            if not self.lost:
                self.set(waiting_for=None, message=said)

    # --- rows and decisions ---------------------------------------------------

    def update_row(self, document_id: str, **fields) -> None:
        """Write a document row's columns, and keep them here once core took
        them: a call core failed leaves the row as core holds it, so the step
        taken again writes it again (REV-JG3-2)."""
        self.admin.jobs.update_document(self.id, document_id, self.worker_id, **fields)
        self.rows.setdefault(document_id, {'document_id': document_id}).update(fields)

    def add_decisions(self, decisions: List[Dict[str, Any]]) -> None:
        for i in range(0, len(decisions), JOB_DECISIONS_PER_CALL):
            self.admin.jobs.add_decisions(self.id, self.worker_id, decisions[i:i + JOB_DECISIONS_PER_CALL])

    def lookup_decisions(self, forms: List[str]) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        forms = list(dict.fromkeys(f for f in forms if f))
        for i in range(0, len(forms), JOB_DECISIONS_PER_CALL):
            out.extend(self.admin.jobs.lookup_decisions(self.id, forms[i:i + JOB_DECISIONS_PER_CALL]) or [])
        return out

    def decisions(self) -> List[Dict[str, Any]]:
        return list(self.admin.jobs.decisions(self.id) or [])

    def landed(self, refs: List[str]) -> List[str]:
        """The keys (``<seed>.<n>``) of the writes made under each seed of
        ``refs`` that landed, as core's audit log holds them."""
        return list(self.admin.jobs.landed(self.id, refs) or [])


# --- the frame of a job ------------------------------------------------------------

CHECKING, PLANNING, HARMONIZING, REPORTING = 'checking', 'planning', 'harmonizing', 'reporting'

#: A document row's states that are final for the walk.
ROW_FINAL = ('done', 'in-use', 'gone')

#: The keys of a row's ``counts`` (CONTRACT 5.2), each a whole number.
#: ``analyzed`` counts the sentences the job wrote in, whatever it wrote
#: (added by J-FIX-B2, any write since JH): the report's "sentences".
#: ``proposed`` counts the staged changes the apply rule did not apply (added
#: by JG). ``changes`` counts the changes a write applied and ``deletions``
#: those of them that took something away (added by JH). ``repeated`` counts
#: the changes a piece staged again, after an interruption, in a sentence its
#: own write had landed in, which are left out (added by JH-FIX). A row holds
#: nothing of what is left blank: the report counts that from the documents
#: as they are at the end (BRIEF NW round 3, DF2).
#: ``peoples_values_changed`` counts the changes that changed or took away
#: something people wrote, by its provenance, and ``text_changes`` those that
#: changed the text or its words and sentences (DF2, REV-DAY-S-3).
#: ``words_added`` and ``tokens_changed`` count the words the job's text
#: edits made and the existing tokens (words and punctuation) they changed
#: or removed (RPF-A8).
COUNT_KEYS = ('translations', 'refreshed', 'words', 'links', 'entries', 'changed', 'proposed', 'analyzed',
              'changes', 'deletions', 'repeated', 'peoples_values_changed', 'text_changes', 'words_added',
              'tokens_changed')
#: What one change a job wrote is, as the report splits its ``changes``
#: (``totals.changes_parts``, an app's ``counts.changes_parts``, RPF-A3), in
#: this order: a value set or cleared, a word's analysis, a link, an entry,
#: a change of the text, anything else. The app sorts its changes.
CHANGE_KINDS = ('values', 'analyses', 'links', 'entries', 'text', 'other')
#: A row's count of the sentences skipped past the cap of its ``skipped``
#: list (core's JOB_SKIPPED_PER_DOCUMENT), which are counted and not listed.
SKIPPED_MORE = 'skipped_more'


def empty_counts() -> Dict[str, int]:
    return {k: 0 for k in COUNT_KEYS}


def run_job(job: Job, runner) -> Optional[Dict[str, Any]]:
    """A claimed job from its checks to its finish, in SPEC 3.1's order:
    the checks (unless the job resumes past them), the app's work on each
    document (``runner.WORK_PHASE``), the pass making the job's own work
    consistent and the entries pass, the report, finish. A stop seen at any
    checkpoint goes straight to the report with state ``cancelled``; a
    starter who lost the right to write ends the job ``failed``; a job lost
    to another worker or gone is dropped with nothing more written. Returns
    the job as finished, or None when it was dropped."""
    harmonize: Dict[str, Any] = {}
    entries: Dict[str, Any] = {}
    try:
        job.check()
        if job.status.get('phase') in (None, CHECKING):
            job.set(phase=CHECKING, message='Checking the project and its documents.')
            failure = through_core(job, lambda: runner.check(job))
            if failure is not None:
                reason, message = failure
                job.set(message=message)
                return _finish(job, 'failed', runner, harmonize, entries, reason=reason, said=True)
        if job.status.get('phase') in (CHECKING, PLANNING):
            # The job's plan, made once and kept: a resumed job reads it back.
            job.set(phase=PLANNING, message='Planning the work.')
            through_core(job, lambda: runner.plan(job))
        if job.status.get('phase') in (PLANNING, runner.WORK_PHASE):
            through_core(job, lambda: runner.plan(job))
            # A job whose plan names nothing to work ends here, writing
            # nothing (the runner's ``plan_failure``: planning ended with no
            # plan), a new job and a resumed one alike.
            failure = through_core(job, lambda: runner.plan_failure(job))
            if failure is not None:
                # A heartbeat first, which may be the first to hear of a stop:
                # a job stopped during its planning ends stopped (REV-DF4-3).
                job.beat()
                job.check()
                return _finish(job, 'failed', runner, harmonize, entries, reason=failure)
            job.set(phase=runner.WORK_PHASE)
            runner.work(job)
        job.check()
        # Each change of phase is a heartbeat, which may be the first to hear
        # of a stop: asked again before anything of the phase is written.
        job.set(phase=HARMONIZING, current_document=None, message='Making the job\'s analyses consistent.')
        job.check()
        harmonize = through_core(job, lambda: runner.harmonize(job))
        job.check()
        entries = through_core(job, lambda: runner.entries(job))
        job.set(phase=REPORTING, current_document=None, message='Writing the report.')
        return _finish(job, 'done', runner, harmonize, entries)
    except Exception as e:  # noqa: BLE001 - a stop, core saying the job is no longer this worker's, or a fault
        if core_fault(e) == 'access':
            e = job.access_lost()
        if not isinstance(e, JobStopped) and not no_longer_mine(e):
            # No rule covers it: the job fails with what happened, rather
            # than being skipped past or taken again to fail the same way.
            logger.exception('Job %s: ended on an error', job.id)
            job.set(message=error_line(e))
            return _finish(job, 'failed', runner, harmonize, entries, reason=WORKER_ERROR, said=True)
        stop = e if isinstance(e, JobStopped) else job.ended()
        if stop.why == 'cancelled':
            return _finish(job, 'cancelled', runner, harmonize, entries, reason='cancelled')
        if stop.why == 'failed':
            return _finish(job, 'failed', runner, harmonize, entries, reason=job.reason or 'starter-access')
        logger.warning('Job %s: dropped (%s)', job.id, stop.why)
        return None


def through_core(job: Job, step: Callable[[], Any], gave_up: Optional[Callable[[], Any]] = None):
    """THE way every call the worker makes to core is made (REV-J-B2 S3-4):
    ``step`` is a call, or a step of calls that is safe to make again from
    its start (each reads the documents and the job's record as they are,
    SPEC 3.8). While core is busy or out of reach (:func:`core_fault`
    ``passing``: a 5xx, a network error, 423, 429) it is made again,
    :data:`JOB_CORE_TRIES` times in all with a growing wait. When the trouble
    outlasts them, ``gave_up()`` answers where it is given, else the error
    goes up. Anything else goes up at once, for :func:`run_job` to sort: the
    job no longer this worker's, the starter's access gone, a fault."""
    for n in range(1, JOB_CORE_TRIES + 1):
        try:
            return step()
        except Exception as e:  # noqa: BLE001 - core's passing trouble is tried again, the rest goes up
            if core_fault(e) != 'passing':
                raise
            logger.warning('Job %s: core did not take a call (%s of %s): %s', job.id, n, JOB_CORE_TRIES, e)
            if n == JOB_CORE_TRIES:
                if gave_up is None:
                    raise
                return gave_up()
            job.sleep(JOB_CORE_WAIT_S * n)


def _stopped_parts(job: Job, runner, harmonize, entries):
    """What a job that stopped early reports of harmonize and of its
    entries: what harmonize wrote before the stop (``runner.harmonize_done``),
    and the entries the job made, read as at any end. Reads only, and a
    read that fails leaves its part empty."""
    harmonize = harmonize or getattr(runner, 'harmonize_done', None) or {}
    if not entries and job.status.get('phase') not in (None, CHECKING):
        try:
            entries = runner.entries(job)
        except Exception as e:  # noqa: BLE001 - a report without its entries rather than none
            logger.warning('Job %s: its entries could not be read for the report: %s', job.id, e)
            entries = {}
    return harmonize, entries


def _give_up(job: Job, e: BaseException) -> None:
    """End a job the worker could not take to its end, failed with the
    error and the smallest report, so it is not claimed again to fail the
    same way (REV-J-B S2-4). A refusal here too is logged and left to core."""
    if job.lost:
        return
    job.set(message=error_line(e))
    report = build_report(job, 'failed', WORKER_ERROR, [], {}, {})
    try:
        job.admin.jobs.finish(job.id, job.worker_id, 'failed', report, reason=WORKER_ERROR)
    except Exception as again:  # noqa: BLE001 - nothing more a worker can do
        logger.warning('Job %s: could not be ended as failed: %s', job.id, again)


def _finish(job: Job, state: str, runner, harmonize, entries, reason: Optional[str] = None, said: bool = False):
    """Store the report and end the job. ``said``: the job's message is the
    end's own sentence (a check that failed, the error met). Otherwise the
    last progress line ("Writing the report.") is cleared, so the app words
    the end by its state and reason."""
    if not said:
        job.set(message=None)
    if state != 'done':
        harmonize, entries = _stopped_parts(job, runner, harmonize, entries)
    # The app's part with nothing in it (``runner.NO_ENTRIES``), for a job
    # that never reached its entries.
    entries = entries or dict(getattr(runner, 'NO_ENTRIES', {}))
    report = build_report(job, state, reason, runner.document_reports(job), harmonize, entries,
                          nouns=getattr(runner, 'PEOPLE_NOUNS', None))
    parts = getattr(runner, 'report_parts', None)
    if parts is not None:
        report.update(parts(job))
        # One count of the proposed changes: the ones the report holds and
        # those it could not (a change proposed again on a piece taken again
        # is one change).
        report['totals']['proposed'] = len(report.get('proposed') or []) + (report.get('proposed_more') or 0)
    fit_report(report)
    if state == 'done' and getattr(runner, 'write_summary', False):
        report.update(_summary(job, runner, report))
        report.update(_findings(job, runner, report))
        fit_report(report)
    try:
        return job.admin.jobs.finish(job.id, job.worker_id, state, report, reason=reason)
    except PlaidAPIError as e:
        if state == 'done' and api_code(e) == 'job-state':
            # A stop came after the last check: the job ends as stopped, with
            # what it did.
            job.beat()
            if job.state == 'stopping':
                return _finish(job, 'cancelled', runner, harmonize, entries, reason='cancelled')
        if e.status == 400:
            # A report core will not take: the job still ends, with the error.
            raise
        logger.warning('Job %s: the finish was refused: %s', job.id, e)
        return None


def field_counts(rows, outside=()) -> List[Dict[str, Any]]:
    """The values a job set by target, as a document's ``counts.fields``
    and the report's ``totals.fields`` hold them (BRIEF EW): ``rows`` (an
    app's, each ``{field, id, values}``: ``id`` the target's id, ``field``
    the name the app shows for it) summed by id, each ``{field, id,
    values}``, with ``in_analyses`` summed where a row has it (how many of
    the values word analyses carried, REV-RPF-W-5), in the order of their
    names. A list, never a map keyed by a
    name or an id, which the clients would re-case. Two targets that share a
    name stay two rows (REV-SUFIX-2). A row whose id is among ``outside``
    (the ids of what the app counted as written outside the job's setup) is
    marked ``outside: true`` (REV-SU-B-4)."""
    by: Dict[Any, Dict[str, Any]] = {}
    for r in rows:
        s = by.setdefault(r.get('id'), {'field': r.get('field'), 'id': r.get('id'), 'values': 0})
        s['values'] += r.get('values') or 0
        if r.get('in_analyses'):
            s['in_analyses'] = s.get('in_analyses', 0) + r['in_analyses']
    outside = set(outside)
    return [{**s, **({'outside': True} if s['id'] in outside else {})}
            for s in sorted(by.values(), key=lambda s: (str(s['field']), str(s['id']))) if s['values']]


def fields_text(fields) -> str:
    """Rows of :func:`field_counts` as a line says them: "<name> 1 value,
    <name> 9 values (7 in word analyses)"."""
    return ', '.join(f'{f.get("field")} {f.get("values") or 0:,} value{"" if f.get("values") == 1 else "s"}'
                     + (f' ({f["in_analyses"]:,} in word analyses)' if f.get('in_analyses') else '')
                     for f in fields or [])


def blank_sums(documents: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """What is still blank of each thing the job fills, summed over the
    documents' ``counts.blank`` rows (an app's, ``{target, unit, left,
    not_reached, skipped}``), by target in the order they first come: the
    report's ``totals.blank``. A list by name, never a map keyed by a name."""
    out: Dict[str, Dict[str, Any]] = {}
    for d in documents:
        for b in (d.get('counts') or {}).get('blank') or []:
            row = out.setdefault(b.get('target'), {'target': b.get('target'), 'unit': b.get('unit'),
                                                   **{k: 0 for k in BLANK_WHERE}})
            for k in BLANK_WHERE:
                row[k] += b.get(k) or 0
            # Any other count an app's row holds is summed the same way
            # (an app's own, such as ``unsegmented``, RPF3-B).
            for k, v in b.items():
                if k not in BLANK_WHERE and isinstance(v, int) and not isinstance(v, bool):
                    row[k] = row.get(k, 0) + v
    return list(out.values())


#: Where a ``blank`` row counts what is blank: in the sentences the job
#: wrote in (Left blank lists those), in those it worked and wrote nothing in
#: (RPF-A9: the instructions may have told it to leave them), in those it did
#: not reach, and in those it skipped (REV-DF-D-9).
BLANK_WHERE = ('left', 'untouched', 'not_reached', 'skipped')


def blank_text(rows) -> str:
    """``counts.blank`` or ``totals.blank`` as a line says it: "segmentation
    left blank 6 words (4 more in sentences not reached, 2 more in skipped
    sentences), Translation left blank 0 sentences"."""
    def n(k, unit):
        return f'{k:,} {unit}{"" if k == 1 else "s"}'

    def more(b):
        said = [f'{b[k]:,} more in {where}' for k, where in (('untouched', 'sentences it wrote nothing in'),
                                                              ('not_reached', 'sentences not reached'),
                                                              ('skipped', 'skipped sentences')) if b.get(k)]
        return f' ({", ".join(said)})' if said else ''
    return ', '.join(f'{b.get("target")} left blank {n(b.get("left") or 0, b.get("unit") or "place")}'
                     + (f' and {n(b["unsegmented"], "word")} not segmented' if b.get('unsegmented') else '')
                     + more(b) for b in rows or [])


def report_bytes(value: Any) -> int:
    """The size of ``value`` as core measures a report: its JSON, every
    character written as itself (no escape for a letter outside ASCII), in
    UTF-8."""
    return len(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))


def _report_cuts(report: Dict[str, Any]):
    """The report's lists in the order they are cut when it does not fit:
    the tables, the notes and the proposed changes, then each document's
    blanks and skipped sentences from the last document up, then
    harmonize's lists and the entries', the plan's documents left out, the
    documents last. Each as (the
    list's holder, its key, what to count a cut row as)."""
    yield report, 'tables', ('tables_more',)
    yield report, 'notes', ('notes_more',)
    yield report, 'proposed', ('proposed_more',)
    for d in reversed(report.get('documents') or []):
        yield d, 'left', ('left_more',)
        yield d, 'skipped', ('skipped',)
    for part, keys in (('harmonize', ('changed', 'left')), ('entries', ('created', 'unlinked'))):
        for key in keys:
            yield report.get(part) or {}, key, (f'{key}_more',)
    # The plan's documents it left out, an app's part (REV-JG2-6).
    yield report.get('plan') or {}, 'left_out', ('left_out_more',)
    yield report, 'documents', ('documents_more',)


def fit_report(report: Dict[str, Any], budget: int = JOB_REPORT_BUDGET_BYTES) -> Dict[str, Any]:
    """Keep ``report`` within ``budget`` bytes as core measures it, so the
    finish is never refused for its size (REV-JG-2): rows are cut from the
    end of its lists in the order of :func:`_report_cuts` until it fits, and
    every row cut is counted where the report counts what it does not list
    (``tables_more``, ``notes_more``, ``proposed_more``, a document's
    ``left_more``, harmonize's and the entries' ``*_more``). A skipped
    sentence cut moves from its reason's total to ``skipped_more``, as one
    past the row's own cap is. The prose and the totals are never cut.
    ``tables_more`` is always set."""
    report['tables_more'] = report.get('tables_more') or 0
    for _ in range(8):
        over = report_bytes(report) - budget
        if over <= 0:
            return report
        for holder, key, (more,) in _report_cuts(report):
            rows = holder.get(key) or []
            cut = 0
            while rows and over > 0:
                row = rows.pop()
                over -= report_bytes(row) + 1
                cut += 1
                if more == 'skipped':
                    reason = f'skipped_{str(row.get("reason") or "").replace("-", "_")}'
                    totals = report['totals']
                    if totals.get(reason):
                        totals[reason] -= 1
                    totals['skipped_more'] = (totals.get('skipped_more') or 0) + 1
            if cut and more == 'skipped':
                holder['counts'] = {**(holder.get('counts') or {}),
                                    'skipped_more': ((holder.get('counts') or {}).get('skipped_more') or 0) + cut}
            elif cut:
                holder[more] = (holder.get(more) or 0) + cut
            if over <= 0:
                break
    return report


#: The summary of a job that wrote no change, proposed none and made no
#: table, the worker's own words: no model is asked to describe nothing
#: (BRIEF PF).
NOTHING_WRITTEN = 'The job wrote no change and proposed none.'


def wrote_nothing(report: Dict[str, Any]) -> bool:
    """Whether the job wrote no change, proposed none and made no table, by
    the worker's own counts and rows: no change written anywhere, none
    proposed, nothing harmonize changed, no table its code made (a job that
    reads and reports keeps the assistant's summary)."""
    totals = report.get('totals') or {}
    harmonize = report.get('harmonize') or {}
    return not (totals.get('changes') or totals.get('proposed') or harmonize.get('changed')
                or harmonize.get('changed_more') or report.get('tables') or report.get('tables_more'))


def _summary(job: Job, runner, report: Dict[str, Any]) -> Dict[str, Any]:
    """The report's prose, written by the job's final model context from the
    report's own sections (``runner.summarize``), ``summary_by`` model. A job
    that wrote nothing, proposed nothing and made no table gets the worker's fixed sentence
    instead, ``summary_by`` worker, and no model is asked. When the prose
    cannot be written the report has none and says so (``summary_failed``).
    A stop during it leaves it out. The line says nothing of the plan: the
    report's plan says it, and the job's page shows it (REV-L2-9)."""
    if wrote_nothing(report):
        return {'summary': NOTHING_WRITTEN, 'summary_by': 'worker', 'summary_failed': False}
    try:
        return {'summary': through_core(job, lambda: runner.summarize(job, report)), 'summary_by': 'model',
                'summary_failed': False}
    except JobStopped:
        return {'summary': None, 'summary_failed': False}
    except Exception as e:  # noqa: BLE001 - a report without its prose rather than none
        if no_longer_mine(e):
            raise
        logger.warning('Job %s: its summary could not be written: %s', job.id, e)
        return {'summary': None, 'summary_failed': True}


#: What an app's count of people's work names, one and many, when it names
#: nothing of its own (``runner.PEOPLE_NOUNS``).
PEOPLE_NOUNS = ('value or link', 'values or links')


def notice(totals: Dict[str, Any], nouns: Optional[Tuple[str, str]] = None) -> Optional[str]:
    """The worker's fixed top line of a report (the owner's R4 of
    2026-11-16), from its own counts, never a model's: what the job changed
    of people's work, in the app's nouns for what it counts (``nouns``, one
    and many, ``runner.PEOPLE_NOUNS``), and of the text, each said only
    when there is some. None when it changed neither."""
    def n(k: int, one: str, many: str) -> str:
        return f'{k:,} {one if k == 1 else many}'
    out = []
    people = totals.get('peoples_values_changed') or 0
    if people:
        out.append(f'People\'s work: {n(people, *(nouns or PEOPLE_NOUNS))} people '
                   f'wrote {"was" if people == 1 else "were"} changed or removed. What the job wrote in their place '
                   'is unverified.')
    added, changed = totals.get('words_added') or 0, totals.get('tokens_changed') or 0
    said = ([n(added, 'word', 'words') + ' added'] if added else []) + (
        [f'{n(changed, "existing word or punctuation mark", "existing words or punctuation marks")} changed or '
         'removed'] if changed else [])
    if said:
        out.append('Text: ' + ', '.join(said) + '.')
    elif totals.get('text_changes'):
        out.append(f'Text: {n(totals["text_changes"], "text edit", "text edits")}, no word added, changed or '
                   'removed.')
    one = totals.get('documents_in_one_step') or 0
    if one:
        # The documents the whole-selection piece covered, after which
        # nothing more is worked (the lead's ruling after RP4-5): what the
        # step did, and that it did not read every sentence where it did not.
        k = totals.get('documents_changed_in_one_step') or 0
        out.append(one_step_line(one, k, totals.get('documents_in_job') or one) + (' It did not read every sentence.'
                                            if totals.get('documents_not_all_read') else ''))
    for _value, key in RAN_OUT_TOTALS:
        if totals.get(key):
            out.append(ran_out_line(key, totals[key]))
    return ' '.join(out) or None


#: An app's ``counts.ran_out`` values, each with its total (REV-RW-R2-2):
#: what happened in a document a big piece did not finish and nothing walked
#: after it there.
RAN_OUT_TOTALS = (('written', 'documents_ran_out'), ('not-reached', 'documents_step_not_reached'),
                  ('failed', 'documents_step_failed'))


def ran_out_line(key: str, n: int) -> str:
    """The top line's sentence for the documents of one ``RAN_OUT_TOTALS``
    total, true of each of them."""
    one = n == 1
    count = f'{n:,} {"document" if one else "documents"}'
    if key == 'documents_ran_out':
        return (f'{count} ended before the job had done its work there: what it had staged there was written, and '
                'the rest was not done.')
    if key == 'documents_step_not_reached':
        return (f'{count} {"was" if one else "were"} not reached: the job\'s step over the documents ended before '
                f'{"it" if one else "them"}.')
    return f'{count} {"was" if one else "were"} not worked: the job\'s step over {"it" if one else "them"} failed.'


def one_step_totals(documents: List[Dict[str, Any]]) -> Dict[str, int]:
    """The top line's counts of the documents an app's row says the
    whole-selection step ended (``counts.one_step``), of those it changed and
    of those it was not shown all of (``counts.not_all_read``). Empty when
    there are none. Core's own report is counted the same way by an app."""
    stepped = [d for d in documents if d.get('state') == 'done' and (d.get('counts') or {}).get('one_step') is True]
    if not stepped:
        return {}
    return {'documents_in_one_step': len(stepped), 'documents_in_job': len(documents),
            'documents_changed_in_one_step': sum(1 for d in stepped if (d['counts'].get('changes') or 0) > 0),
            'documents_not_all_read': sum(1 for d in stepped if d['counts'].get('not_all_read') is True)}


def one_step_line(n: int, k: int, of: Optional[int] = None) -> str:
    """How the top line says a whole-selection job's one step: "The job
    worked on all 45 documents in one step and changed 24 of them." ("...
    and changed none of them.", "The job worked on its one document in one
    step and changed it." / "... and did not change it."). "All" and "its
    one" only when the step ended every document of the job (``of``):
    else "The job worked on 2 of its 3 documents in one step and changed 1
    of them." (REV-SF2-2: a write put off, a document deleted, a job stopped
    between the ends)."""
    if of is not None and of > n:
        did = ('changed it' if k else 'did not change it') if n == 1 else f'changed {f"{k:,}" if k else "none"} of them'
        return f'The job worked on {n:,} of its {of:,} documents in one step and {did}.'
    if n == 1:
        return f'The job worked on its one document in one step and {"changed it" if k else "did not change it"}.'
    return f'The job worked on all {n:,} documents in one step and changed {f"{k:,}" if k else "none"} of them.'


def _findings(job: Job, runner, report: Dict[str, Any]) -> Dict[str, Any]:
    """The one report of a job that fills nothing, written by the final
    context from its pieces' findings when several pieces kept some
    (``runner.merge_findings``, RPF-A5). Nothing changes when the runner has
    none to merge, when a stop comes, or when it cannot be written: the
    report keeps the pieces' findings as they were."""
    merge = getattr(runner, 'merge_findings', None)
    if merge is None or not report.get('findings'):
        return {}
    try:
        merged = through_core(job, lambda: merge(job, report))
    except JobStopped:
        return {}
    except Exception as e:  # noqa: BLE001 - the pieces' findings rather than none
        if no_longer_mine(e):
            raise
        logger.warning('Job %s: its findings could not be made one report: %s', job.id, e)
        return {}
    if not merged:
        return {}
    # The one report holds every piece's findings: no count of pieces cut
    # (REV-RPF-W-2).
    report.pop('findings_pieces', None)
    report.pop('findings_cut', None)
    return {'findings': merged}


def build_report(job: Job, state: str, reason: Optional[str], documents: List[Dict[str, Any]],
                 harmonize: Dict[str, Any], entries: Dict[str, Any],
                 nouns: Optional[Tuple[str, str]] = None) -> Dict[str, Any]:
    """The report of CONTRACT 5.3: lists, never maps keyed by an id, each cut
    at :data:`JOB_REPORT_LIST_MAX` with its ``-more`` count. ``documents`` is
    one entry per document in the job's order, from the app."""
    totals = {'documents_done': 0, 'documents_in_use': 0, 'documents_gone': 0, 'documents_not_reached': 0,
              'sentences': 0, 'translations': 0, 'refreshed': 0, 'words': 0, 'links': 0, 'entries': 0,
              'skipped_too_long': 0, 'skipped_failed': 0, 'skipped_changed': 0, 'skipped_interrupted': 0,
              'skipped_no_answer': 0, 'skipped_more': 0, 'changed': 0, 'proposed': 0, 'changes': 0, 'deletions': 0,
              'repeated': 0, 'peoples_values_changed': 0, 'text_changes': 0, 'words_added': 0, 'tokens_changed': 0}
    fields: List[Dict[str, Any]] = []
    outside: List[Dict[str, Any]] = []
    parts: Dict[str, int] = {}
    held: Dict[Tuple[str, str], int] = {}
    for d in documents:
        key = {'done': 'documents_done', 'in-use': 'documents_in_use', 'gone': 'documents_gone'}.get(
            d.get('state'), 'documents_not_reached')
        totals[key] += 1
        counts = d.get('counts') or {}
        # The sentences the job wrote in, never one finished with nothing
        # written, skipped or failed (REV-J-B2 S3-5): ``done`` counts those.
        totals['sentences'] += counts.get('analyzed') or 0
        for k in ('translations', 'refreshed', 'words', 'links', 'entries', 'changed', 'proposed', 'skipped_more',
                  'changes', 'deletions', 'repeated', 'peoples_values_changed', 'text_changes', 'words_added',
                  'tokens_changed'):
            totals[k] += counts.get(k) or 0
        for p in counts.get('changes_parts') or []:
            parts[p.get('kind')] = parts.get(p.get('kind'), 0) + (p.get('n') or 0)
            # What the analyses hold, morphemes and values (REV-RPF2-2).
            for k in ('morphemes', 'values'):
                if p.get(k):
                    held[(p.get('kind'), k)] = held.get((p.get('kind'), k), 0) + p[k]
        for s in d.get('skipped') or []:
            k = f'skipped_{str(s.get("reason") or "").replace("-", "_")}'
            if k in totals:
                totals[k] += 1
        fields += counts.get('fields') or []
        outside += counts.get('outside') or []
    if fields:
        totals['fields'] = field_counts(fields, {f.get('id') for f in outside})
    if outside:
        # What the job wrote outside its setup (an app's ``counts.outside``).
        totals['outside'] = field_counts(outside)
    if parts:
        # The changes by kind, summing to ``changes``, in CHANGE_KINDS'
        # order (an app's ``counts.changes_parts``, RPF-A3).
        totals['changes_parts'] = [
            {'kind': k, 'n': parts[k], **{x: held[(k, x)] for x in ('morphemes', 'values') if held.get((k, x))}}
            for k in sorted(parts, key=lambda k: (CHANGE_KINDS.index(k) if k in CHANGE_KINDS else len(CHANGE_KINDS),
                                                  str(k)))
            if parts[k]]
    blank = blank_sums(documents)
    if blank:
        totals['blank'] = blank
    # The documents an app's row says the whole-selection step ended (an
    # app's ``counts.one_step``), those of them it changed, and those it was
    # not shown all of (``counts.not_all_read``), for the top line.
    totals.update(one_step_totals(documents))
    # The documents a big piece did not finish, nothing walked after it there
    # (an app's ``counts.ran_out``, REV-RW-1, REV-RW-R2-2), by what happened,
    # for the top line.
    for value, key in RAN_OUT_TOTALS:
        k = sum(1 for d in documents if (d.get('counts') or {}).get('ran_out') == value)
        if k:
            totals[key] = k
    changed, changed_more = cut(harmonize.get('changed') or [])
    left, left_more = cut(harmonize.get('left') or [])
    lists = {}
    for name in ('created', 'unlinked'):
        lists[name], lists[f'{name}_more'] = cut(entries.get(name) or [])
    # The app's own keys of the part (what the job page links to), as the
    # app gave them, taken before the cut.
    lists.update({k: v for k, v in entries.items() if k not in ('created', 'unlinked')})
    return {
        'state': state, 'reason': reason, 'instructions': job.instructions, 'started_by': job.starter,
        'model': job.model, 'started_at': job.started_at,
        'finished_at': datetime.fromtimestamp(job.now(), timezone.utc).isoformat(timespec='seconds')
        .replace('+00:00', 'Z'),
        'paused_for_people_s': int(job.paused['people']), 'paused_for_model_s': int(job.paused['model']),
        # Apart from taking turns with people on the model (RPF3-D1).
        'paused_for_edits_s': int(job.paused['edits']),
        'stopped': None, 'totals': totals, 'notice': notice(totals, nouns), 'documents': documents, 'summary': None,
        'summary_by': None,
        'summary_failed': False,
        'harmonize': {'changed': changed, 'left': left, 'changed_more': changed_more, 'left_more': left_more},
        'entries': lists,
    }


# --- the worker ----------------------------------------------------------------------

class Worker:
    """The worker's loop: ask for a job every ``idle_s`` seconds, hold one
    with a heartbeat, run it with the runner of its app, finish, ask again.

    ``admin`` is the worker's client (an administrator's API token).
    ``runners`` maps an app to a function building its runner for a claimed
    job. ``client_for(token)`` builds a client writing with a job token."""

    def __init__(self, admin, runners: Dict[str, Callable[[Job], Any]], model: str, *,
                 client_for: Callable[[str], Any], pool: Optional[str] = None, idle_s: float = 30,
                 now: Callable[[], float] = time.time, sleep: Callable[[float], None] = time.sleep,
                 heartbeat_s: float = JOB_HEARTBEAT_S, worker_id: Optional[str] = None):
        self.admin = admin
        self.runners = runners
        self.model = model
        self.client_for = client_for
        self.pool = pool
        self.idle_s = idle_s
        self.now = now
        self.sleep = sleep
        self.heartbeat_s = heartbeat_s
        self.worker_id = worker_id or str(uuid.uuid4())

    def once(self) -> Optional[Dict[str, Any]]:
        """Ask for one job and run it. The claimed job's answer, or None when
        there was none to take."""
        claimed = self.admin.jobs.claim(self.worker_id, self.model, sorted(self.runners))
        if not claimed:
            return None
        job = Job(self.admin, claimed, self.worker_id, client_for=self.client_for, pool=self.pool, now=self.now,
                  sleep=self.sleep, model=self.model, heartbeat_s=self.heartbeat_s)
        logger.info('Claimed job %s on project %s', job.id, job.project_id)
        job.start()
        runner = None
        try:
            runner = self.runners[job.job['app']](job)
            if job.state == 'stopping':
                # Cancelled while a worker that crashed held it: what was written stands.
                _finish(job, 'cancelled', runner, {}, {}, reason='cancelled')
            else:
                run_job(job, runner)
        except Exception as e:  # noqa: BLE001 - a job the worker cannot finish is failed, never taken again
            logger.exception('Job %s: ended on an error of the worker\'s own', job.id)
            _give_up(job, e)
        finally:
            job.stop()
        return claimed

    def run_forever(self) -> None:
        while True:
            try:
                ran = self.once()
            except Exception:  # noqa: BLE001 - one job's failure must not stop the worker
                logger.exception('A job ended on an error of the worker\'s own')
                ran = None
            if not ran:
                self.sleep(self.idle_s)
