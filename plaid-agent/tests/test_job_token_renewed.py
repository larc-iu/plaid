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


def _job_client():
    client = _client()
    return client, start(client)


def test_a_401_is_not_renewed_where_the_step_may_not_be_made_again():
    """REV-JR1-2: the renewal keeps ``retry=``. A write whose earlier try
    landed (``first_request`` says no) is not made again from its gate after
    a 401: the error goes up, for the walk to take the piece again over what
    is left."""
    import pytest
    from plaid_agent.core.job import through_core
    client, job = _job_client()
    calls = []

    def step():
        calls.append(1)
        raise _revoked()
    with pytest.raises(PlaidAPIError):
        through_core(job, step, retry=lambda e: False)
    assert calls == [1], 'made once'
    calls.clear()
    with pytest.raises(PlaidAPIError):
        through_core(job, step)
    assert calls == [1, 1], 'made again once with the renewed token, then refused again'


def test_a_tool_call_that_staged_before_a_401_is_not_made_twice():
    """REV-JR1-2, a tool call: item 1 staged, item 2's read refused 401. The
    call is not made again (item 1 would be staged twice): the error goes up."""
    import pytest
    from types import SimpleNamespace
    from plaid_agent.core.job import tool_through_core
    client, job = _job_client()
    ws = SimpleNamespace(ops=[], tables=[])
    calls = []

    def call():
        calls.append(1)
        ws.ops.append({'kind': 'set_span'})
        raise _revoked()
    with pytest.raises(PlaidAPIError):
        tool_through_core(job, ws, call)
    assert calls == [1] and len(ws.ops) == 1
