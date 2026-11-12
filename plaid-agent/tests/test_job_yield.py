"""A job is the lowest priority on the model key (SPEC 4): before every model
call it waits while anyone's request to a service of the same pool is in
flight, and for a quiet minute after the last one. With no pool it waits for
nobody."""

from datetime import datetime, timezone

from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_agent.core.job import PAUSED_FOR_PEOPLE
from plaid_agent.core.limits import JOB_YIELD_QUIET_S


def _iso(t):
    return datetime.fromtimestamp(t, timezone.utc).isoformat().replace('+00:00', 'Z')


def _job(pool):
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['blank']}])})
    job = start(client)
    job.pool = pool
    return client, job


def _model(monkeypatch, client, job, load):
    seen = []

    def answer(asked, n, kwargs):
        seen.append((job.now(), dict(client.jobs.model_load.get('reallms') or {})))
        if n == 1:
            return reply(calls=[call(1, 'set_analysis', {'document': 'Story', 'ref': 's1.w1',
                                                         'morphemes': [{'form': 'blank'}]})])
        return reply('Done.')
    use(monkeypatch, Model(answer))
    return seen


def test_requests_in_flight_pause_the_job_before_a_model_call(monkeypatch):
    client, job = _job('reallms')
    client.jobs.model_load = {'reallms': {'in_flight': 2, 'last_finished_at': None}}
    start_t = job.now()
    real_sleep = job._sleep

    def sleep(s):
        real_sleep(s)
        if job.now() - start_t > 30:
            client.jobs.model_load = {'reallms': {'in_flight': 0, 'last_finished_at': _iso(start_t - 600)}}
    job._sleep = sleep
    seen = _model(monkeypatch, client, job, None)
    runner(job).document('d1')
    assert seen[0][0] - start_t >= 30, 'no call while people used the model'
    beats = [c[1] for c in client.jobs.calls if c[0] == 'heartbeat']
    assert any(b.get('waiting_for') == 'people' and b.get('message') == PAUSED_FOR_PEOPLE for b in beats)
    assert beats[-1].get('waiting_for') is None
    assert job.paused['people'] >= 30


def test_the_job_waits_for_a_quiet_minute_after_the_last_request(monkeypatch):
    client, job = _job('reallms')
    t0 = job.now()
    client.jobs.model_load = {'reallms': {'in_flight': 0, 'last_finished_at': _iso(t0 - 20)}}
    seen = _model(monkeypatch, client, job, None)
    runner(job).document('d1')
    assert seen[0][0] - (t0 - 20) >= JOB_YIELD_QUIET_S


def test_no_pool_means_no_pause(monkeypatch):
    client, job = _job(None)
    client.jobs.model_load = {'reallms': {'in_flight': 5, 'last_finished_at': None}}
    t0 = job.now()
    seen = _model(monkeypatch, client, job, None)
    runner(job).document('d1')
    assert seen[0][0] == t0
    assert not [c for c in client.jobs.calls if c[0] == 'model_busy']
