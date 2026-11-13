"""A document's lock lost in the middle of a write (core restarted, the
keeper's renewal refused) is a lock conflict like any other: the document
is put off and taken again, never the job's end (REV-J-B3 B3-4)."""

import contextlib

from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_client import DocumentLockLost, PlaidAPIError, testing
from plaid_agent.core.job import core_fault, run_job

J = 'JL'


def _lost(cause=None):
    return DocumentLockLost('The lock on document d1 lapsed: it could not be renewed.', document_id='d1',
                            cause=cause if cause is not None else PlaidAPIError('HTTP 423', status=423))


def _job(monkeypatch):
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['gam']}])})
    client.after_write['d1'] = document('d1', 'Story', [{'words': [('gam', [('gam', 'fish')], J)]}], version=2)
    job = start(client, ['gloss'], id=J)
    use(monkeypatch, Model(lambda asked, n, kw: reply(calls=[call(1, 'set_analysis', {
        'document': 'Story', 'ref': 's1.w1', 'morphemes': [{'form': 'gam', 'fields': {'Morph Gloss': 'fish'}}]})])
        if n == 1 else reply('Done.')))
    return client, job


def test_a_lock_lost_is_core_trouble_that_passes():
    assert core_fault(_lost()) == 'passing'
    assert core_fault(_lost(PlaidAPIError('connection reset', status=0))) == 'passing'
    assert core_fault(_lost(PlaidAPIError('HTTP 401', status=401, response_data={'code': 'job-ended'}))) == 'mine'


def test_a_lock_lost_during_the_write_puts_the_document_off_and_the_job_goes_on(monkeypatch):
    client, job = _job(monkeypatch)
    real, n = testing._Batch.submit, {'n': 0}

    def submit(self):
        n['n'] += 1
        if n['n'] == 1:
            raise _lost()
        return real(self)
    monkeypatch.setattr(testing._Batch, 'submit', submit)
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), client.jobs.rows[J].get('message'))
    assert client.jobs.get(J)['documents'][0]['counts']['words'] == 1


def test_a_lock_lost_as_the_write_ends_puts_the_document_off(monkeypatch):
    """The write landed and the lock lapsed before it was let go: the block
    ends with the lost lock. The document is put off and what landed is
    recorded when it comes back."""
    client, job = _job(monkeypatch)
    locked = client.documents.locked
    left = {'n': 1}

    @contextlib.contextmanager
    def losing(document_id, **kwargs):
        with locked(document_id, **kwargs) as held:
            yield held
        if left['n']:
            left['n'] -= 1
            raise _lost()
    client.documents.locked = losing
    assert runner(job).document('d1') == 'deferred'
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), client.jobs.rows[J].get('message'))
    assert client.jobs.get(J)['documents'][0]['counts']['words'] == 1


def test_a_lock_lost_in_harmonizes_write_takes_the_document_again(monkeypatch):
    from job_fixtures import recorded
    client = JobClient({'d1': document('d1', 'Story', [{'words': [
        ('ka', [('ka', 'go')], J), ('ka', [('ka', 'go')], J), ('ka', [('ka', 'come')], J)]}])})
    job = start(client, ['gloss'], id=J)
    job.update_row('d1', state='done')
    recorded(job)
    real, n = testing._Batch.submit, {'n': 0}

    def submit(self):
        n['n'] += 1
        if n['n'] == 1:
            raise _lost()
        return real(self)
    monkeypatch.setattr(testing._Batch, 'submit', submit)
    out = runner(job).harmonize(job)
    assert [c['form'] for c in out['changed']] == ['ka'] and out['left'] == []
