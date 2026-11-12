"""Every request the job worker makes to core goes through the one helper
that tries core's passing trouble again (REV-J-B2 S3-4): one 502 at any call
of a whole job, the checks, the walk, the row of a document put off or gone,
harmonize and the entries pass, never ends the job ``worker-error``.

The test counts every call a job makes to the fake core, then runs the job
again once per call with a 502 at that call alone."""

import pytest

from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_client import PlaidAPIError, testing
from plaid_agent.core.job import run_job
from plaid_agent.core.limits import JOB_LOCK_TRIES

J = 'JB'
#: the calls a worker makes that are never retried by design: the finish (a
#: finish core does not take leaves the job to a later claim) and the setup's
CALLS_OUT = {'jobs.finish', 'jobs.create', 'jobs.claim'}
RESOURCES = ('documents', 'projects', 'jobs', 'comments', 'guidelines', 'vocab_items', 'vocab_links', 'spans',
             'tokens', 'texts', 'users')


def _job_word(form, gloss):
    return (form, [(form, gloss)], J)


def _docs():
    # d1 and d2 hold the job's own words of "ka" two ways (harmonize has a
    # rewrite to make) and one blank word each (the walk has a stretch).
    return {'d1': document('d1', 'Story 1', [{'words': [_job_word('ka', 'go'), _job_word('ka', 'go')]},
                                             {'words': ['mo']}]),
            'd2': document('d2', 'Story 2', [{'words': [_job_word('ka', 'come')]}, {'words': ['zu']}])}


def _analyse(asked, n, kwargs):
    if n > 1:
        return reply('Done.')
    doc = asked.split('"')[1]
    form = 'mo' if doc == 'Story 1' else 'zu'
    return reply(calls=[call(1, 'set_analysis', {'document': doc, 'ref': 's2.w1', 'morphemes': [
        {'form': form, 'type': 'stem', 'fields': {'Morph Gloss': 'G'}}]})])


class Blips:
    """Counts every call to core and fails the ``at``-th with a 502."""

    def __init__(self, at=None):
        self.at = at
        self.n = 0
        self.names = []

    def wrap(self, name, fn):
        def wrapped(*a, **kw):
            if name not in CALLS_OUT:
                self.n += 1
                self.names.append(name)
                if self.n == self.at:
                    raise PlaidAPIError('HTTP 502', status=502)
            return fn(*a, **kw)
        return wrapped


def _install(monkeypatch, client, blips):
    for res in RESOURCES:
        obj = getattr(client, res, None)
        if obj is None:
            continue
        for name in dir(obj):
            if name.startswith('_') or name == 'now':  # the fake's clock, not a call
                continue
            fn = getattr(obj, name)
            if callable(fn) and not isinstance(fn, type):
                setattr(obj, name, blips.wrap(f'{res}.{name}', fn))
    client.query = blips.wrap('query', client.query)
    real_layers = type(client).vocab_layers.fget

    class Layers:
        def __init__(self, inner):
            self.inner = inner

        def __getattr__(self, name):
            return blips.wrap(f'vocab_layers.{name}', getattr(self.inner, name))
    monkeypatch.setattr(type(client), 'vocab_layers', property(lambda self: Layers(real_layers(self))))
    submit = testing._Batch.submit
    monkeypatch.setattr(testing._Batch, 'submit', lambda self: blips.wrap('batch.submit', submit)(self))


def _trouble(client, how):
    """Besides the 502: ``lock`` refuses d1's lock (a person's save holds
    it) until the document is put off, ``gone`` deletes d2 after the checks
    read it."""
    if how == 'lock':
        locked, left = client.documents.locked, {'n': JOB_LOCK_TRIES}

        def refusing(document_id, **kw):
            if document_id == 'd1' and left['n']:
                left['n'] -= 1
                raise PlaidAPIError('HTTP 423', status=423)
            return locked(document_id, **kw)
        client.documents.locked = refusing
    elif how == 'gone':
        get, reads = client.documents.get, {'n': 0}

        def going(document_id, **kw):
            if document_id == 'd2':
                reads['n'] += 1
                if reads['n'] > 1:
                    raise PlaidAPIError('HTTP 404', status=404)
            return get(document_id, **kw)
        client.documents.get = going


def _run(monkeypatch, at, how=None):
    client = JobClient(_docs())
    job = start(client, ['gloss', 'link'], id=J)
    _trouble(client, how)
    blips = Blips(at)
    _install(monkeypatch, client, blips)
    use(monkeypatch, Model(_analyse))
    finished = run_job(job, runner(job))
    return finished, blips, client


def _count(monkeypatch, how=None):
    with monkeypatch.context() as m:
        finished, blips, client = _run(m, None, how)
    assert finished['state'] == 'done', finished
    if how == 'lock':
        assert any(c[0] == 'update_document' and c[1].get('state') == 'deferred' for c in client.jobs.calls), \
            'd1 was put off'
    if how == 'gone':
        assert client.jobs.rows[J]['report']['totals']['documents_gone'] == 1
    return blips.n, blips.names



def test_the_whole_job_is_counted(monkeypatch):
    n, names = _count(monkeypatch)
    # Every phase's calls are among those the next test fails one by one.
    for name in ('projects.get', 'documents.get', 'documents.audit_page', 'documents.locked',
                 'jobs.update_document', 'jobs.add_decisions', 'jobs.lookup_decisions', 'batch.submit'):
        assert name in names, (name, sorted(set(names)))
    assert n > 30


@pytest.mark.parametrize('how', [None, 'lock', 'gone'])
def test_one_502_at_any_call_never_fails_the_job(monkeypatch, how):
    n, names = _count(monkeypatch, how)
    bad = []
    for at in range(1, n + 1):
        with monkeypatch.context() as m:
            finished, blips, client = _run(m, at, how)
        assert blips.n >= at, 'the 502 was sent'
        if finished['state'] != 'done' or finished.get('reason') is not None:
            bad.append((at, names[at - 1], finished['state'], finished.get('reason'),
                        client.jobs.rows[J].get('message')))
    assert not bad, bad
