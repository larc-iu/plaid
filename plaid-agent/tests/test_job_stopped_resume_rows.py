"""A job stopped while its worker was dead, then ended by the next worker
(S3-2 of the stress campaign 2026-11-18): the worker that claims the
stopping job counts what landed (core's audit log) for its report AND writes
each document's row as counted, so the job's Documents table and its totals
say the same."""

from job_fixtures import JobClient, Model, call, document, planned, reply, use

from plaid_client import testing
from plaid_agent.core.agent import ModelConfig
from plaid_agent.core.job import Worker
from plaid_agent.igt.job import runner_factory


class Killed(BaseException):
    """The worker's process killed: nothing of it runs on."""


def _analyse(asked, n, kwargs):
    if n > 1:
        return reply('Done.')
    doc = asked.split('"')[1]
    return reply(calls=[call(i, 'set_analysis', {'document': doc, 'ref': f's{i}.w1',
                                                 'morphemes': [{'form': 'ka', 'type': 'stem'}]})
                        for i in (1, 2)])


def test_the_worker_ending_a_stopped_job_writes_the_rows_its_report_counts(monkeypatch):
    client = JobClient({f'd{i}': document(f'd{i}', f'Story {i}', [{'words': ['ka']}, {'words': ['ka']}])
                        for i in (1, 2)})
    made = client.jobs.create('p1', 'igt', 'Gloss the words.')
    clock = {'t': 1000.0}
    client.jobs.now = lambda: clock['t']
    use(monkeypatch, Model(planned(_analyse)))
    landed = {'n': 0}
    submit = testing._Batch.submit

    def submitted(self):
        out = submit(self)
        landed['n'] += 1
        return out
    monkeypatch.setattr(testing._Batch, 'submit', submitted)
    update = client.jobs.update_document

    def dies(job_id, document_id, worker_id, **fields):
        # Killed right after the first write landed, before its row.
        if landed['n'] and not killed['done']:
            killed['done'] = True
            raise Killed()
        return update(job_id, document_id, worker_id, **fields)
    killed = {'done': False}
    client.jobs.update_document = dies

    def worker():
        return Worker(client, {'igt': runner_factory(ModelConfig(model='fake/m', stream=False, max_steps=1000),
                                                     count=lambda v: 1)},
                      'fake/m', client_for=lambda token: client, now=lambda: clock['t'],
                      sleep=lambda s: clock.__setitem__('t', clock['t'] + s), heartbeat_s=10 ** 6)
    try:
        worker().once()
    except Killed:
        pass
    assert killed['done'], 'the worker died after its first write'
    client.jobs.cancel(made['id'])
    assert client.jobs.rows[made['id']]['state'] == 'stopping'
    clock['t'] += 1000
    assert worker().once()
    job = client.jobs.get(made['id'])
    assert job['state'] == 'cancelled'
    report = {d['document_id']: d for d in job['report']['documents']}
    assert job['report']['totals']['changes'] > 0
    for row in job['documents']:
        counted = report[row['document_id']]
        assert row['done'] == counted['done'], (row, counted)
        assert (row.get('counts') or {}).get('changes', 0) == counted['counts'].get('changes', 0), (row, counted)


def test_a_job_stopped_with_its_worker_dead_reads_as_having_written(monkeypatch):
    """REV-SJ1-4 and S3-1: the worker dies right after its first write, and
    the Stop comes with no worker running: core writes the report from the
    rows, which count nothing. The job's read says History holds its
    writes (``wrote``, the fake's as core's), and read_job says so."""
    from plaid_agent.igt import jobread
    client = JobClient({f'd{i}': document(f'd{i}', f'Story {i}', [{'words': ['ka']}, {'words': ['ka']}])
                        for i in (1, 2)})
    made = client.jobs.create('p1', 'igt', 'Gloss the words.')
    clock = {'t': 1000.0}
    client.jobs.now = lambda: clock['t']
    use(monkeypatch, Model(planned(_analyse)))
    landed = {'n': 0}
    submit = testing._Batch.submit

    def submitted(self):
        out = submit(self)
        landed['n'] += 1
        return out
    monkeypatch.setattr(testing._Batch, 'submit', submitted)
    update = client.jobs.update_document

    def dies(job_id, document_id, worker_id, **fields):
        if landed['n']:
            raise Killed()
        return update(job_id, document_id, worker_id, **fields)
    client.jobs.update_document = dies
    try:
        Worker(client, {'igt': runner_factory(ModelConfig(model='fake/m', stream=False, max_steps=1000),
                                              count=lambda v: 1)},
               'fake/m', client_for=lambda token: client, now=lambda: clock['t'],
               sleep=lambda s: clock.__setitem__('t', clock['t'] + s), heartbeat_s=10 ** 6).once()
    except Killed:
        pass
    assert landed['n'], 'a write landed before the worker died'
    clock['t'] += 1000
    client.jobs.cancel(made['id'])
    job = client.jobs.get(made['id'])
    assert job['state'] == 'cancelled' and job['report']['stopped'] == 'without-worker'
    assert job['report']['totals'].get('changes', 0) == 0, 'the rows count nothing'
    assert job['wrote'] is True
    assert ('Stopped with no worker running. The counts are what its worker recorded before it stopped, and History '
            'holds every change it wrote.') in '\n'.join(jobread.summary(job))
