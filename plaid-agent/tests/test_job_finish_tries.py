"""A finish that meets core's passing trouble (a 502, a network error) is
sent again, as every other call to core is (D13 of the job review
2026-11-18): the job ends with its report, never left running for its lease
to lapse and another run to report what the first did as nothing."""

import pytest

from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_client import PlaidAPIError
from plaid_agent.core.job import run_job


def _client():
    return JobClient({'d1': document('d1', 'Story 1', [{'words': ['blank']}])})


def _analyse(asked, n, kwargs):
    if n == 1:
        return reply(calls=[call(1, 'set_analysis', {'document': 'Story 1', 'ref': 's1.w1',
                                                     'morphemes': [{'form': 'blank'}]})])
    return reply('Done.')


def _fail_finish_once(client, error):
    real = client.jobs.finish
    seen = []

    def finish(job_id, worker_id, state, report, reason=None):
        seen.append(state)
        if len(seen) == 1:
            raise error
        return real(job_id, worker_id, state, report, reason=reason)
    client.jobs.finish = finish
    return seen


@pytest.mark.parametrize('status', [502, 0])
def test_a_finish_met_by_passing_trouble_is_sent_again_and_the_job_ends_done(monkeypatch, status):
    client = _client()
    job = start(client)
    use(monkeypatch, Model(_analyse))
    seen = _fail_finish_once(client, PlaidAPIError('core away', status=status))
    finished = run_job(job, runner(job))
    assert seen == ['done', 'done']
    assert finished and finished['state'] == 'done'
    assert client.jobs.rows[job.id]['state'] == 'done'


def test_a_stopped_jobs_finish_met_by_passing_trouble_is_sent_again(monkeypatch):
    client = _client()
    job = start(client)
    use(monkeypatch, Model(_analyse))
    job.beat()
    client.jobs.cancel(job.id)
    job.beat()
    assert job.state == 'stopping'
    seen = _fail_finish_once(client, PlaidAPIError('Bad gateway', status=502))
    finished = run_job(job, runner(job))
    assert seen == ['cancelled', 'cancelled']
    assert finished and finished['state'] == 'cancelled'
