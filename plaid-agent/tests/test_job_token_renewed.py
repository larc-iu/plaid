"""A job token core no longer takes while the starter still writes (D5, D6
of the job review 2026-11-18): the starter changed their password or logged
out everywhere, which revokes every token minted for them (CONTRACT 4), or a
piece ran past the token's hour. The next heartbeat mints a valid token, and
the job carries on with it: a step refused 401 is made again with it, and
every client the job handed out sends the latest token. Only a heartbeat that
answers the job failed ends it ``starter-access``."""

from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_client import PlaidAPIError
from plaid_agent.core.job import run_job


def _client():
    return JobClient({f'd{i}': document(f'd{i}', f'Story {i}', [{'words': ['blank']}]) for i in (1, 2)})


def _analyse(asked, n, kwargs):
    if n == 1:
        doc = asked.split('"')[1]
        return reply(calls=[call(1, 'set_analysis', {'document': doc, 'ref': 's1.w1', 'morphemes': [{'form': 'blank'}]})])
    return reply('Done.')


def _revoked():
    return PlaidAPIError('HTTP 401', status=401, response_data={'error': 'Token invalid because password has changed.'})


def _refuse_reads(client, which):
    """The document reads numbered in ``which`` are refused 401."""
    real = client.documents.get
    seen = {'n': 0}

    def get(document_id, **kw):
        seen['n'] += 1
        if seen['n'] in which:
            raise _revoked()
        return real(document_id, **kw)
    client.documents.get = get


def test_a_token_revoked_while_the_starter_still_writes_is_renewed_and_the_job_ends_done(monkeypatch):
    client = _client()
    job = start(client)
    use(monkeypatch, Model(_analyse))
    _refuse_reads(client, {3})
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', (finished['state'], finished.get('reason'))
    assert [r['state'] for r in client.jobs.rows[job.id]['documents']] == ['done', 'done']


def test_a_token_refused_again_after_its_renewal_fails_the_job_starter_access(monkeypatch):
    client = _client()
    job = start(client)
    use(monkeypatch, Model(_analyse))
    _refuse_reads(client, set(range(3, 1000)))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'failed' and finished['reason'] == 'starter-access'


class _Client:
    def __init__(self, token):
        self.token = token


def test_every_client_the_job_handed_out_sends_the_token_of_the_latest_heartbeat():
    client = _client()
    job = start(client)
    made = []
    job.client_for = lambda token: made.append(_Client(token)) or made[-1]
    piece = job.client()
    job.beat()
    assert job.token and piece.token == job.token
    later = job.client()
    job.beat()
    assert piece.token == later.token == job.token
