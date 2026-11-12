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
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

import litellm
from plaid_client import PlaidAPIError
from plaid_client.workflows.llm import did_not_answer, is_busy, is_timeout, transient_errors

from .agent import REPEATING_LINE, TurnCancelled, TurnFailed, token_counter, too_long
from .limits import (HARMONIZE_MAJORITY, JOB_CALL_DECIDE_AT_TOKENS, JOB_CALL_MAX_PROMPT_TOKENS,
                     JOB_HEARTBEAT_S, JOB_MODEL_RETRY_S, JOB_REPORT_LIST_MAX, JOB_STRETCH_DECIDE_AT_ROUNDS,
                     JOB_STRETCH_MAX_ROUNDS, JOB_STRETCH_MAX_SENT_TOKENS, JOB_YIELD_POLL_S, JOB_YIELD_QUIET_S)
from .prompt import JOB_DECIDE_NOW

logger = logging.getLogger(__name__)

#: How a stretch fails (CONTRACT 5.2 ``kind``).
BUDGET, CONTEXT, OUTPUT, REPEATING = 'budget', 'context', 'output', 'repeating'

#: The job's message while it waits for people, and for a model that does not answer.
PAUSED_FOR_PEOPLE = 'Paused while people use the model.'


def not_answering_line(at: datetime) -> str:
    return f'The model is not answering. Trying again at {at.strftime("%H:%M")}.'


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
    (a stop, a model that does not answer): a budget spent, a context the
    endpoint refused, a call that reached the output cap, a model repeating
    itself. Any other refusal of the model is told as the output's."""
    if isinstance(e, StretchFailed):
        return e.kind
    if isinstance(e, TurnCancelled) or not_answering(e):
        return None
    if too_long(e):
        return CONTEXT
    if isinstance(e, TurnFailed) and str(e) == REPEATING_LINE:
        return REPEATING
    return OUTPUT


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
    on. ``before_call`` runs last, just before the call: the wait for people
    on the model key, which may raise to stop the job."""

    def __init__(self, model: str, before_call: Callable[[], None] = lambda: None,
                 count: Optional[Callable[[Any], int]] = None, decided: Callable[[], None] = lambda: None):
        self.count = count or token_counter(model)
        self.before_call = before_call
        self.decided = decided
        self.told = False
        self.sent = 0
        self.calls = 0
        self.largest = 0

    def _prompt(self, kwargs: Dict[str, Any]) -> int:
        return self.count(kwargs.get('messages') or []) + (self.count(kwargs['tools']) if kwargs.get('tools') else 0)

    def note(self, rounds: int, kwargs: Dict[str, Any]) -> Optional[str]:
        if rounds >= JOB_STRETCH_MAX_ROUNDS:
            raise StretchFailed(BUDGET, f'more than {JOB_STRETCH_MAX_ROUNDS} model calls')
        if self.told:
            return None
        if rounds + 1 >= JOB_STRETCH_DECIDE_AT_ROUNDS or self._prompt(kwargs) >= JOB_CALL_DECIDE_AT_TOKENS:
            self.told = True
            self.decided()
            return JOB_DECIDE_NOW
        return None

    def sending(self, kwargs: Dict[str, Any]) -> None:
        n = self._prompt(kwargs)
        if n > JOB_CALL_MAX_PROMPT_TOKENS:
            raise StretchFailed(BUDGET, f'a prompt of {n} tokens')
        if self.sent + n > JOB_STRETCH_MAX_SENT_TOKENS:
            raise StretchFailed(BUDGET, f'{self.sent + n} tokens sent')
        self.before_call()
        self.sent += n
        self.calls += 1
        self.largest = max(self.largest, n)


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


def canonical(value: Any) -> str:
    """JSON with sorted keys and no spaces: the one spelling of a decision."""
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


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


def no_longer_mine(e: Optional[BaseException]) -> bool:
    """Was ``e``, or what caused it, core saying the job is no longer this
    worker's to work: its token refused because the job ended or another
    worker took it (401 ``job-ended``), or a row or decision refused for the
    same reasons (409 ``job-finished``, ``job-taken``)?"""
    while e is not None:
        if isinstance(e, PlaidAPIError):
            return ((e.status == 401 and api_code(e) == 'job-ended')
                    or (e.status == 409 and api_code(e) in ('job-finished', 'job-taken')))
        e = e.__cause__ or e.__context__
    return False


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
        self.tasks = list(self.job.get('tasks') or [])
        self.note = self.job.get('note')
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
        self.lost: Optional[str] = None
        self.reason: Optional[str] = None
        self.paused = {'people': 0.0, 'model': 0.0}
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

    def set(self, **status) -> None:
        """Change what the heartbeat says (phase, message, waiting_for,
        current_document) and send it now."""
        changed = any(self.status.get(k) != v for k, v in status.items())
        self.status.update(status)
        if changed:
            self.beat()

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
                if waited is None:
                    waited = (self.now(), self.status.get('message'))
                    self.set(waiting_for='people', message=PAUSED_FOR_PEOPLE)
                self.sleep(JOB_YIELD_POLL_S)
        finally:
            if waited is not None:
                self.paused['people'] += self.now() - waited[0]
                if not self.lost:
                    self.set(waiting_for=None, message=waited[1])

    def wait_for_model(self) -> None:
        """The model did not answer: say so, wait :data:`JOB_MODEL_RETRY_S`
        and let the caller ask again (SPEC 3.7). A stop ends the wait."""
        began, said = self.now(), self.status.get('message')
        at = datetime.fromtimestamp(began + JOB_MODEL_RETRY_S).astimezone()
        self.set(waiting_for='model', message=not_answering_line(at))
        try:
            self.sleep(JOB_MODEL_RETRY_S)
        finally:
            self.paused['model'] += self.now() - began
            if not self.lost:
                self.set(waiting_for=None, message=said)

    # --- rows and decisions ---------------------------------------------------

    def update_row(self, document_id: str, **fields) -> None:
        """Write a document row's columns, and keep them here."""
        self.rows.setdefault(document_id, {'document_id': document_id}).update(fields)
        self.admin.jobs.update_document(self.id, document_id, self.worker_id, **fields)

    def add_decisions(self, decisions: List[Dict[str, Any]]) -> None:
        for i in range(0, len(decisions), 1000):
            self.admin.jobs.add_decisions(self.id, self.worker_id, decisions[i:i + 1000])

    def lookup_decisions(self, forms: List[str]) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        forms = list(dict.fromkeys(f for f in forms if f))
        for i in range(0, len(forms), 1000):
            out.extend(self.admin.jobs.lookup_decisions(self.id, forms[i:i + 1000]) or [])
        return out

    def decisions(self) -> List[Dict[str, Any]]:
        return list(self.admin.jobs.decisions(self.id) or [])


# --- the frame of a job ------------------------------------------------------------

CHECKING, HARMONIZING, REPORTING = 'checking', 'harmonizing', 'reporting'

#: A document row's states that are final for the walk.
ROW_FINAL = ('done', 'in-use', 'gone')

#: The keys of a row's ``counts`` (CONTRACT 5.2), each a whole number.
COUNT_KEYS = ('translations', 'refreshed', 'words', 'links', 'entries', 'left', 'changed', 'protected')


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
            failure = runner.check(job)
            if failure is not None:
                reason, message = failure
                job.set(message=message)
                return _finish(job, 'failed', runner, harmonize, entries, reason=reason)
        if job.status.get('phase') in (CHECKING, runner.WORK_PHASE):
            job.set(phase=runner.WORK_PHASE)
            runner.work(job)
        job.check()
        # Each change of phase is a heartbeat, which may be the first to hear
        # of a stop: asked again before anything of the phase is written.
        job.set(phase=HARMONIZING, current_document=None, message='Making the job\'s analyses consistent.')
        job.check()
        harmonize = runner.harmonize(job)
        job.check()
        entries = runner.entries(job)
        job.set(phase=REPORTING, current_document=None, message='Writing the report.')
        return _finish(job, 'done', runner, harmonize, entries)
    except Exception as e:  # noqa: BLE001 - a stop, or core saying the job is no longer this worker's
        if not isinstance(e, JobStopped) and not no_longer_mine(e):
            raise
        stop = e if isinstance(e, JobStopped) else job.ended()
        if stop.why == 'cancelled':
            return _finish(job, 'cancelled', runner, harmonize, entries, reason='cancelled')
        if stop.why == 'failed':
            return _finish(job, 'failed', runner, harmonize, entries, reason=job.reason or 'starter-access')
        logger.warning('Job %s: dropped (%s)', job.id, stop.why)
        return None


def _stopped_parts(job: Job, runner, harmonize, entries):
    """What a job that stopped early reports of harmonize and of its
    entries: what harmonize wrote before the stop (``runner.harmonize_done``),
    and the entries the job made, read and never deleted. Reads only, and a
    read that fails leaves its part empty."""
    harmonize = harmonize or getattr(runner, 'harmonize_done', None) or {}
    if not entries and job.status.get('phase') not in (None, CHECKING):
        try:
            entries = runner.entries(job, delete=False)
        except Exception as e:  # noqa: BLE001 - a report without its entries rather than none
            logger.warning('Job %s: its entries could not be read for the report: %s', job.id, e)
            entries = {}
    return harmonize, entries


def _finish(job: Job, state: str, runner, harmonize, entries, reason: Optional[str] = None):
    if state != 'done':
        harmonize, entries = _stopped_parts(job, runner, harmonize, entries)
    # The app's part with nothing in it (``runner.NO_ENTRIES``), for a job
    # that never reached its entries.
    entries = entries or dict(getattr(runner, 'NO_ENTRIES', {}))
    report = build_report(job, state, reason, runner.document_reports(job), harmonize, entries)
    try:
        return job.admin.jobs.finish(job.id, job.worker_id, state, report, reason=reason)
    except PlaidAPIError as e:
        if state == 'done' and api_code(e) == 'job-state':
            # A stop came after the last check: the job ends as stopped, with
            # what it did.
            job.beat()
            if job.state == 'stopping':
                return _finish(job, 'cancelled', runner, harmonize, entries, reason='cancelled')
        logger.warning('Job %s: the finish was refused: %s', job.id, e)
        return None


def build_report(job: Job, state: str, reason: Optional[str], documents: List[Dict[str, Any]],
                 harmonize: Dict[str, Any], entries: Dict[str, Any]) -> Dict[str, Any]:
    """The report of CONTRACT 5.3: lists, never maps keyed by an id, each cut
    at :data:`JOB_REPORT_LIST_MAX` with its ``-more`` count. ``documents`` is
    one entry per document in the job's order, from the app."""
    totals = {'documents_done': 0, 'documents_in_use': 0, 'documents_gone': 0, 'documents_not_reached': 0,
              'sentences': 0, 'translations': 0, 'refreshed': 0, 'words': 0, 'links': 0, 'entries': 0,
              'skipped_too_long': 0, 'skipped_failed': 0, 'skipped_changed': 0, 'changed': 0, 'protected': 0}
    for d in documents:
        key = {'done': 'documents_done', 'in-use': 'documents_in_use', 'gone': 'documents_gone'}.get(
            d.get('state'), 'documents_not_reached')
        totals[key] += 1
        counts = d.get('counts') or {}
        totals['sentences'] += d.get('done') or 0
        for k in ('translations', 'refreshed', 'words', 'links', 'changed', 'protected'):
            totals[k] += counts.get(k) or 0
        for s in d.get('skipped') or []:
            k = f'skipped_{str(s.get("reason") or "").replace("-", "_")}'
            if k in totals:
                totals[k] += 1
    created = list(entries.get('created') or [])
    totals['entries'] = len(created)
    changed, changed_more = cut(harmonize.get('changed') or [])
    left, left_more = cut(harmonize.get('left') or [])
    lists = {}
    for name in ('created', 'deleted', 'unlinked'):
        lists[name], lists[f'{name}_more'] = cut(entries.get(name) or [])
    # The app's own keys of the part (what the job page links to), as the
    # app gave them, taken before the cut.
    lists.update({k: v for k, v in entries.items() if k not in ('created', 'deleted', 'unlinked')})
    return {
        'state': state, 'reason': reason, 'tasks': job.tasks, 'note': job.note, 'started_by': job.starter,
        'model': job.model, 'started_at': job.started_at,
        'finished_at': datetime.fromtimestamp(job.now(), timezone.utc).isoformat(timespec='seconds')
        .replace('+00:00', 'Z'),
        'paused_for_people_s': int(job.paused['people']), 'paused_for_model_s': int(job.paused['model']),
        'stopped': None, 'totals': totals, 'documents': documents,
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
        try:
            if job.state == 'stopping':
                # Cancelled while a worker that crashed held it: what was written stands.
                runner = self.runners[job.job['app']](job)
                _finish(job, 'cancelled', runner, {}, {}, reason='cancelled')
            else:
                run_job(job, self.runners[job.job['app']](job))
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
