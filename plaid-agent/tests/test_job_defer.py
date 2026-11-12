"""A document someone else is writing in is put off and taken again later
(SPEC 5.2, 5.3): a recent History entry that is not the job's, a lock refused
three times, a write refused twice for a moved version. Put off three times,
it ends ``in-use``."""

from datetime import datetime, timezone

from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_client import PlaidAPIError
from plaid_agent.core.limits import JOB_DEFER_WAIT_S, JOB_LOCK_WAIT_S
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
    job = start(client, ['gloss'], now=clock.now)
    job._sleep = clock.sleep
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
    assert job.rows['d1']['state'] == 'deferred' and job.rows['d1']['defers'] == 1
    client._holder('d1')['audit'].clear()
    _edit(client, 'd1', NOW - 60, ref=f'job:{job.id}/doc:d1/pass:gloss')
    assert r.document('d1') == 'done'


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
    runner(job).work(job)
    assert job.rows['d1']['state'] == 'in-use' and job.rows['d1']['defers'] == 3
    assert job.rows['d2']['state'] == 'done'
    assert sum(clock.slept) == JOB_DEFER_WAIT_S, 'one wait, after the pass of put-off documents that found it in use'
    assert all('Story 1' not in c['asked'] for c in model.calls)
