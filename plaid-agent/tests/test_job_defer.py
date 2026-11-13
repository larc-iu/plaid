"""A document someone else is writing in is put off and taken again later
(SPEC 5.2, 5.3): a recent History entry that is not the job's, a lock refused
three times, a write refused twice for a moved version. Put off three times,
it ends ``in-use``."""

from datetime import datetime, timezone

from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_client import PlaidAPIError
from plaid_agent.core.limits import JOB_DEFER_WAIT_S, JOB_LOCK_WAIT_S, JOB_PERSON_QUIET_S
from plaid_agent.core.plan import PlanError
from plaid_agent.igt import job as igt_job

NOW = 1_800_000_000.0


class Clock:
    def __init__(self):
        self.t = NOW
        self.slept = []

    def now(self):
        return self.t

    def sleep(self, s):
        self.slept.append(s)
        self.t += s


def _iso(t):
    return datetime.fromtimestamp(t, timezone.utc).isoformat().replace('+00:00', 'Z')


def _job(n_docs=1):
    docs = {f'd{i}': document(f'd{i}', f'Story {i}', [{'words': ['blank']}]) for i in range(1, n_docs + 1)}
    client = JobClient(docs)
    clock = Clock()
    job = start(client, now=clock.now)
    job._sleep = clock.sleep
    # Made an hour ago: the edits these tests leave are the job's to see.
    job.job['created_at'] = _iso(NOW - 3600)
    return client, job, clock


def _edit(client, doc_id, at, ref=None):
    client._holder(doc_id)['audit'].append({'id': f'a{len(client._holder(doc_id)["audit"])}', 'time': _iso(at),
                                            'ref': ref, 'kind': None, 'documents': [{'id': doc_id}], 'ops': []})


def _model(monkeypatch):
    def answer(asked, n, kwargs):
        if n == 1:
            return reply(calls=[call(1, 'set_analysis', {'document': asked.split('"')[1], 'ref': 's1.w1',
                                                         'morphemes': [{'form': 'blank'}]})])
        return reply('Done.')
    return use(monkeypatch, Model(answer))


def test_a_recent_entry_by_someone_else_defers_and_the_jobs_own_does_not(monkeypatch):
    client, job, clock = _job()
    _model(monkeypatch)
    _edit(client, 'd1', NOW - 60)
    r = runner(job)
    assert r.document('d1') == 'deferred'
    assert job.rows['d1']['state'] == 'deferred' and job.rows['d1']['defers'] == 0, \
        'a defer counts only once the job has waited'
    client._holder('d1')['audit'].clear()
    _edit(client, 'd1', NOW - 60, ref=f'job:{job.id}/doc:d1/pass:gloss')
    assert r.document('d1') == 'done'


def test_a_unit_begun_before_the_job_and_ended_a_minute_ago_defers(monkeypatch):
    """REV-B4-4: core gives a History unit the time of its first member
    (``time``) and of its last (``end_time``), and places it by its last. A
    group a person began before the job was made and wrote in a minute ago
    is a person in the document now."""
    client, job, clock = _job()
    _model(monkeypatch)
    client._holder('d1')['audit'].append({'id': 'a0', 'time': _iso(NOW - 7200), 'end_time': _iso(NOW - 60),
                                          'ref': None, 'kind': None, 'documents': [{'id': 'd1'}], 'ops': []})
    assert runner(job).document('d1') == 'deferred'


def test_an_old_entry_does_not_defer(monkeypatch):
    client, job, clock = _job()
    _model(monkeypatch)
    _edit(client, 'd1', NOW - 601)
    assert runner(job).document('d1') == 'done'


def test_a_lock_refused_three_times_defers_and_writes_nothing(monkeypatch):
    client, job, clock = _job()
    _model(monkeypatch)
    tries = []

    def refuse(document_id, **kw):
        tries.append(document_id)
        raise PlaidAPIError('HTTP 423 locked', status=423)
    client.documents.locked = refuse
    assert runner(job).document('d1') == 'deferred'
    assert len(tries) == 3 and sum(clock.slept) == 2 * JOB_LOCK_WAIT_S
    assert not [k for k, _ in client.calls if k.startswith('tokens.')]


def _refusing(times):
    real = igt_job.execute_plan
    left = {'n': times}

    def execute(client, ops, **kw):
        if left['n']:
            left['n'] -= 1
            try:
                raise PlaidAPIError('HTTP 409 version', status=409)
            except PlaidAPIError as e:
                raise PlanError('moved', 0, len(ops)) from e
        return real(client, ops, **kw)
    return execute


def test_a_write_refused_for_a_moved_version_is_sent_once_more(monkeypatch):
    client, job, clock = _job()
    _model(monkeypatch)
    monkeypatch.setattr(igt_job, 'execute_plan', _refusing(1))
    assert runner(job).document('d1') == 'done'
    assert "'blank'" in str(client.calls)


def test_a_write_refused_twice_defers(monkeypatch):
    client, job, clock = _job()
    _model(monkeypatch)
    monkeypatch.setattr(igt_job, 'execute_plan', _refusing(2))
    assert runner(job).document('d1') == 'deferred'
    assert "'blank'" not in str([c for c in client.calls if c[0].startswith('tokens')])


def test_a_document_put_off_three_times_ends_in_use_after_the_waits(monkeypatch):
    client, job, clock = _job(2)
    model = _model(monkeypatch)
    for t in range(0, 4000, 100):
        _edit(client, 'd1', NOW + t)
    assert NOW + 3900 > NOW + 3 * JOB_DEFER_WAIT_S - JOB_PERSON_QUIET_S
    runner(job).work(job)
    assert job.rows['d1']['state'] == 'in-use' and job.rows['d1']['defers'] == 3
    assert job.rows['d2']['state'] == 'done'
    assert sum(clock.slept) == 3 * JOB_DEFER_WAIT_S, 'three waits of the interval before it ends in-use (SPEC 5.3)'
    assert all('Story 1' not in c['asked'] for c in model.calls)


# --- edits made before the job, and the wait before a pass (REV-J-B S3-5) ---------

def test_an_edit_made_before_the_job_was_created_does_not_put_the_document_off(monkeypatch):
    client, job, clock = _job()
    _model(monkeypatch)
    job.job['created_at'] = _iso(NOW - 30)
    _edit(client, 'd1', NOW - 31)
    assert runner(job).document('d1') == 'done', 'the starter edited, then started the job'


def test_an_edit_made_after_the_job_was_created_puts_the_document_off(monkeypatch):
    client, job, clock = _job()
    _model(monkeypatch)
    job.job['created_at'] = _iso(NOW - 30)
    _edit(client, 'd1', NOW - 29)
    assert runner(job).document('d1') == 'deferred'


def test_every_pass_over_put_off_documents_waits_first_and_says_for_what(monkeypatch):
    client, job, clock = _job(2)
    _model(monkeypatch)
    _edit(client, 'd1', NOW - 10)
    r = runner(job)
    r.work(job)
    assert job.rows['d1']['state'] == 'done' and job.rows['d1']['defers'] == 0
    assert sum(clock.slept) >= JOB_DEFER_WAIT_S, 'the second pass waited the quiet window'
    beats = [c[1] for c in client.jobs.calls if c[0] == 'heartbeat']
    waiting = [b['message'] for b in beats if (b.get('message') or '').startswith('Waiting for')]
    assert waiting == ['Waiting for people to finish in "Story 1". Trying again in 10 minutes.']
    told = next(b for b in beats if (b.get('message') or '').startswith('Waiting for'))
    assert told.get('current_document', 'unset') is None, 'not shown working in the document it waits on'
