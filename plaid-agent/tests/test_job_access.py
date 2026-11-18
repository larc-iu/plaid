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
    # Core also says so at the heartbeat the refusal is checked by (S9-1).
    client.jobs.can_write = lambda user_id, project_id: False
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
    job = start(client, id='JA')
    job.update_row('d1', state='done')
    recorded(job)
    job.status['phase'] = 'harmonizing'
    _refuse_lock(client, PlaidAPIError('HTTP 403', status=403, response_data={'error': 'Write access required.'}))
    client.jobs.can_write = lambda user_id, project_id: False
    finished = run_job(job, runner(job))
    assert finished['state'] == 'failed' and finished['reason'] == 'starter-access'
    assert finished['report']['harmonize']['changed'] == []


def test_a_403_while_the_starter_still_writes_is_the_refusal_itself_never_access_lost(monkeypatch):
    """S9-1: core answers the heartbeat, the starter still writes: the job
    fails with the refusal's own words, never "can no longer write"."""
    client = _client()
    job = start(client)
    use(monkeypatch, Model(_analyse))
    _refuse_lock(client, PlaidAPIError('HTTP 403 Only a maintainer may do this. at http://core.internal:8085/api/v1/x',
                                       status=403, url='http://core.internal:8085/api/v1/x',
                                       response_data={'error': 'Only a maintainer may do this.'}))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'failed' and finished['reason'] == 'worker-error', finished.get('reason')
    assert 'Only a maintainer may do this.' in client.jobs.rows[job.id]['message']
    # Core's address never reaches a reader (REV-SJ1-5).
    assert 'core.internal' not in client.jobs.rows[job.id]['message']


def test_a_lexicon_deleted_during_the_job_is_said_as_deleted_never_as_access(monkeypatch):
    """REV-SJ1-R2-4, S5-2's path: the next stretch reads the lexicon a
    maintainer deleted, and core refuses 403 ``unresolved`` with words that
    say the starter lacks read access. The job's line says something it was
    reading was deleted, with no email and no id."""
    from plaid_agent.igt import workspace
    client = _client()
    job = start(client)
    use(monkeypatch, Model(_analyse))
    gone = PlaidAPIError('HTTP 403 User sam@ex.org lacks read access to vocab layer 01a1-lex', status=403,
                         response_data={'error': 'User sam@ex.org lacks read access to vocab layer 01a1-lex',
                                        'unresolved': True})

    def lexicon(self, vocab):
        raise gone
    monkeypatch.setattr(workspace.Workspace, 'lexicon', lexicon)
    finished = run_job(job, runner(job))
    message = client.jobs.rows[job.id]['message']
    assert finished['state'] == 'failed' and finished['reason'] == 'worker-error', finished.get('reason')
    assert message == 'The job worker stopped the job: something it was reading was deleted during the job.', message
