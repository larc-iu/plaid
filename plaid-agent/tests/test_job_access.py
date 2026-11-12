"""A starter who loses the right to write while the job works (SPEC 12,
REV-J-B S3-1): the job ends failed, starter-access, with its report, and no
document is called gone for it. A document core no longer finds is gone."""

import pytest

from job_fixtures import JobClient, Model, call, document, recorded, reply, runner, start, use

from plaid_client import PlaidAPIError
from plaid_agent.core.job import run_job


def _client():
    return JobClient({f'd{i}': document(f'd{i}', f'Story {i}', [{'words': ['blank']}]) for i in (1, 2)})


def _analyse(asked, n, kwargs):
    if n == 1:
        doc = asked.split('"')[1]
        return reply(calls=[call(1, 'set_analysis', {'document': doc, 'ref': 's1.w1', 'morphemes': [{'form': 'blank'}]})])
    return reply('Done.')


def _refuse_lock(client, error):
    def locked(document_id, **kw):
        raise error
    client.documents.locked = locked


@pytest.mark.parametrize('where', ['lock', 'read'])
def test_a_starter_who_lost_access_mid_stretch_fails_the_job_and_no_document_is_gone(monkeypatch, where):
    client = _client()
    job = start(client)
    use(monkeypatch, Model(_analyse))
    refused = PlaidAPIError('HTTP 403', status=403, response_data={'error': 'Write access required.'})
    if where == 'lock':
        _refuse_lock(client, refused)
    else:
        real = client.documents.get
        seen = {'n': 0}

        def get(document_id, **kw):
            seen['n'] += 1
            if seen['n'] > 2:
                raise refused
            return real(document_id, **kw)
        client.documents.get = get
    finished = run_job(job, runner(job))
    assert finished['state'] == 'failed' and finished['reason'] == 'starter-access'
    states = [r['state'] for r in client.jobs.rows[job.id]['documents']]
    assert 'gone' not in states, states


def test_a_document_core_no_longer_finds_is_gone(monkeypatch):
    client = _client()
    job = start(client)
    use(monkeypatch, Model(_analyse))
    _refuse_lock(client, PlaidAPIError('HTTP 403', status=403, response_data={'error': 'x', 'unresolved': True}))
    assert runner(job).document('d1') == 'gone'


def test_harmonize_refused_access_ends_the_job_failed_and_not_done(monkeypatch):
    w = lambda g: ('ka', [('ka', g)], 'JA')  # noqa: E731
    client = JobClient({'d1': document('d1', 'A', [{'words': [w('go'), w('go'), w('come')]}])})
    job = start(client, ['gloss'], id='JA')
    job.update_row('d1', state='done')
    recorded(job)
    job.status['phase'] = 'harmonizing'
    _refuse_lock(client, PlaidAPIError('HTTP 403', status=403, response_data={'error': 'Write access required.'}))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'failed' and finished['reason'] == 'starter-access'
    assert finished['report']['harmonize']['changed'] == []
