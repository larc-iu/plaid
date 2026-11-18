"""A core outage that outlasts the worker's tries (S4-1 of the stress
campaign 2026-11-18): core busy or out of reach is passing trouble, so the
worker drops the job as it stands, never fails it ``worker-error``. Its lease
lapses, and the next claim, once core answers, takes it up again from what
core holds and ends it done, whatever phase the outage met."""

import pytest

from job_fixtures import JobClient, Model, call, document, planned, reply, use

from plaid_client import PlaidAPIError
from plaid_agent.core.agent import ModelConfig
from plaid_agent.core.job import Worker
from plaid_agent.core.limits import JOB_CORE_TRIES
from plaid_agent.igt.job import runner_factory


def _client():
    return JobClient({f'd{i}': document(f'd{i}', f'Story {i}', [{'words': ['ka']}]) for i in (1, 2)})


def _analyse(asked, n, kwargs):
    if n > 1:
        return reply('Done.')
    doc = asked.split('"')[1]
    return reply(calls=[call(1, 'set_analysis', {'document': doc, 'ref': 's1.w1',
                                                 'morphemes': [{'form': 'ka', 'type': 'stem'}]})])


class Outage:
    """Core down from the first call named ``at`` for ``calls`` refused
    calls (heartbeats refused and not counted): every call of the job's own
    to core is refused 502 meanwhile. Long enough for the worker to give up
    on its step and on the step's fallback, and back before the finish, as a
    restart of a few minutes is (the campaign's runs o3 and op3)."""

    def __init__(self, client, at, calls=2 * JOB_CORE_TRIES, error=None):
        self.error = error or (lambda: PlaidAPIError('HTTP 502 core unreachable', status=502))
        self.down = False
        self.at = at
        self.left = calls
        self.was_down = False
        documents, jobs = client.documents, client.jobs
        for obj, names in ((documents, ('get', 'locked', 'audit_page')),
                           (jobs, ('update_document', 'heartbeat', 'finish', 'add_decisions', 'lookup_decisions',
                                   'decisions', 'landed'))):
            for name in names:
                if hasattr(obj, name):
                    setattr(obj, name, self.wrap(f'{name}', getattr(obj, name)))

    def wrap(self, name, fn):
        def wrapped(*a, **kw):
            if name == self.at and not self.down and self.at is not None:
                self.down = self.was_down = True
                self.at = None
            if self.down:
                if name != 'heartbeat':
                    self.left -= 1
                    if self.left <= 0:
                        self.down = False
                raise self.error()
            return fn(*a, **kw)
        return wrapped


UNREACHABLE = {
    '502': lambda: PlaidAPIError('HTTP 502 core unreachable', status=502),
    '503': lambda: PlaidAPIError('HTTP 503', status=503),
    '504': lambda: PlaidAPIError('HTTP 504', status=504),
    'network': lambda: PlaidAPIError('Connection refused', status=0, original_error=ConnectionError('refused')),
}


@pytest.mark.parametrize('how', sorted(UNREACHABLE))
@pytest.mark.parametrize('at', ['decisions', 'get', 'update_document'])
def test_an_outage_past_the_tries_drops_the_job_and_the_next_claim_ends_it_done(monkeypatch, at, how):
    client = _client()
    made = client.jobs.create('p1', 'igt', 'Gloss the words.')
    clock = {'t': 1000.0}
    client.jobs.now = lambda: clock['t']

    def sleep(s):
        clock['t'] += s
    use(monkeypatch, Model(planned(_analyse)))
    outage = Outage(client, at, error=UNREACHABLE[how])
    worker = Worker(client, {'igt': runner_factory(ModelConfig(model='fake/m', stream=False, max_steps=1000),
                                                   count=lambda v: 1)},
                    'fake/m', client_for=lambda token: client, now=lambda: clock['t'], sleep=sleep,
                    heartbeat_s=10 ** 6)
    assert worker.once()
    assert outage.was_down, 'core went down during the job'
    outage.down = False
    row = client.jobs.rows[made['id']]
    assert row['state'] == 'running', (row['state'], row.get('reason'), row.get('message'))
    assert row.get('reason') is None
    # The lease lapses, and the job is taken up again.
    clock['t'] += 1000
    assert worker.once()
    row = client.jobs.rows[made['id']]
    assert row['state'] == 'done', (row['state'], row.get('reason'), row.get('message'))
    assert row['report']['totals']['documents_done'] == 2


#: Core answered, or the client refused before sending: not core out of
#: reach (REV-SJ1-2). Each fails the job with its own words, as at the base.
ANSWERED = {
    '500': lambda: PlaidAPIError('HTTP 500 Internal error in the query', status=500),
    '423': lambda: PlaidAPIError('HTTP 423 Locked by a save', status=423),
    'client': lambda: PlaidAPIError('A batch ref names no earlier op', status=0),
}


@pytest.mark.parametrize('how', sorted(ANSWERED))
def test_a_refusal_core_answers_past_the_tries_fails_the_job_with_its_words(monkeypatch, how):
    client = _client()
    made = client.jobs.create('p1', 'igt', 'Gloss the words.')
    use(monkeypatch, Model(planned(_analyse)))
    Outage(client, 'decisions', calls=3 * JOB_CORE_TRIES, error=ANSWERED[how])
    clock = {'t': 1000.0}
    client.jobs.now = lambda: clock['t']
    Worker(client, {'igt': runner_factory(ModelConfig(model='fake/m', stream=False, max_steps=1000),
                                          count=lambda v: 1)},
           'fake/m', client_for=lambda token: client, now=lambda: clock['t'],
           sleep=lambda s: clock.__setitem__('t', clock['t'] + s), heartbeat_s=10 ** 6).once()
    row = client.jobs.rows[made['id']]
    assert row['state'] == 'failed' and row['reason'] == 'worker-error', (row['state'], row.get('reason'))
    words = str(ANSWERED[how]()).replace('HTTP 500 ', '').replace('HTTP 423 ', '')
    assert words in row['message'], row['message']
