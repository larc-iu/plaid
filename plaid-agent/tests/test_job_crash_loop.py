"""A job the worker cannot take to its end fails, and is never taken again
to fail the same way, so one job cannot hold the server's one slot forever
(REV-J-B S2-4). A document's skipped sentences past core's cap of its list
are counted, not listed, so the row core keeps never grows past what core
takes."""

from job_fixtures import JobClient, ModelConfig, document, planned, reply, runner, start, use, Model

from plaid_client import PlaidAPIError
from plaid_agent.core import agent
from plaid_agent.core.job import Worker
from plaid_agent.igt import job as igt_job
from plaid_agent.igt.job import IgtRunner, runner_factory


def _client(n_sentences=1):
    return JobClient({'d1': document('d1', 'Story', [{'words': [f'w{i}']} for i in range(n_sentences)])})


def _worker(client, factory):
    return Worker(client, {'igt': factory}, 'fake/m', client_for=lambda token: client, sleep=lambda s: None)


def test_a_job_whose_runner_breaks_is_failed_and_not_claimed_again(monkeypatch):
    client = _client()
    client.jobs.create('p1', 'igt', 'Gloss the words.')
    use(monkeypatch, Model(planned(lambda asked, n, kw: reply('Done.'))))
    cfg = ModelConfig(model='fake/m', stream=False, max_steps=1000)

    class Broken(IgtRunner):
        def work(self, job):
            raise RuntimeError('the runner broke')
    worker = _worker(client, lambda job: Broken(job, cfg, count=lambda v: 1))
    claimed = worker.once()
    row = client.jobs.rows[claimed['job']['id']]
    assert row['state'] == 'failed' and row['reason'] == 'worker-error'
    assert 'the runner broke' in row['message']
    assert worker.once() is None, 'nothing is taken again'


def test_a_finish_core_refuses_still_ends_the_job_failed(monkeypatch):
    client = _client()
    client.jobs.create('p1', 'igt', 'Gloss the words.')
    use(monkeypatch, Model(planned(lambda asked, n, kw: reply('Done.'))))
    real = client.jobs.finish
    refused = {'n': 0}

    def finish(job_id, worker_id, state, report, reason=None):
        if state == 'done':
            refused['n'] += 1
            raise PlaidAPIError('HTTP 400', status=400, response_data={'error': 'The report is too big.'})
        return real(job_id, worker_id, state, report, reason=reason)
    client.jobs.finish = finish
    worker = _worker(client, runner_factory(ModelConfig(model='fake/m', stream=False, max_steps=1000),
                                            count=lambda v: 1))
    claimed = worker.once()
    row = client.jobs.rows[claimed['job']['id']]
    assert refused['n'] == 1 and row['state'] == 'failed' and row['reason'] == 'worker-error'


def test_skipped_sentences_past_cores_cap_are_counted_and_not_listed(monkeypatch):
    monkeypatch.setattr(igt_job, 'JOB_SKIPPED_PER_DOCUMENT', 3)
    client = _client(6)
    job = start(client)

    def answer(asked, n, kwargs):
        raise agent.TurnFailed('The model wrote 32,768 tokens without finishing.')
    use(monkeypatch, Model(answer))
    assert runner(job).document('d1') == 'done'
    row = job.rows['d1']
    assert len(row['skipped']) == 3 and row['counts']['skipped_more'] == 3
    assert row['done'] == 6 and row['targets'] == 6
    sent = [c[1] for c in client.jobs.calls if c[0] == 'update_document']
    assert sent and all(len(p.get('skipped') or []) <= 3 for p in sent), 'core is never sent more than its cap'


def test_a_job_given_up_after_it_wrote_reports_the_counts_core_holds(monkeypatch):
    """D16 of the job review 2026-11-18: the report of a job the worker gives
    up on after it wrote (its report could not be built, twice) counts its
    documents from the rows core holds, as core's own report does, never
    "Documents done 0"."""
    from job_fixtures import call
    client = _client()
    client.jobs.create('p1', 'igt', 'Gloss the words.')

    def answer(asked, n, kw):
        if n == 1:
            return reply(calls=[call(1, 'set_analysis', {'document': 'Story', 'ref': 's1.w1',
                                                         'morphemes': [{'form': 'w0'}]})])
        return reply('Done.')
    use(monkeypatch, Model(planned(answer)))
    cfg = ModelConfig(model='fake/m', stream=False, max_steps=1000)

    class Broken(IgtRunner):
        def document_reports(self, job):
            raise RuntimeError('the report broke')
    worker = _worker(client, lambda job: Broken(job, cfg, count=lambda v: 1))
    claimed = worker.once()
    row = client.jobs.rows[claimed['job']['id']]
    assert row['state'] == 'failed' and row['reason'] == 'worker-error'
    totals = row['report']['totals']
    assert totals['documents_done'] == 1 and totals['words'] == 1, totals


def test_a_job_that_kills_its_worker_each_time_is_ended_and_frees_the_slot(monkeypatch):
    """S3-3 of the stress campaign 2026-11-18: a crash at the same point on
    every run (here in harmonize, as an out-of-memory kill would) is taken up
    again a fixed number of times (core's resumes-max), then the next claim
    ends it failed, worker-lost, and takes the next job."""
    from plaid_client.testing import _JOB_RESUMES_MAX

    class Killed(BaseException):
        """The worker's process killed."""
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['w0']}])})
    q = client.jobs.create('p1', 'igt', 'Gloss the words.')
    clock = {'t': 1000.0}
    client.jobs.now = lambda: clock['t']
    use(monkeypatch, Model(planned(lambda asked, n, kw: reply('Done.'))))
    cfg = ModelConfig(model='fake/m', stream=False, max_steps=1000)

    class Crashing(IgtRunner):
        def harmonize(self, job):
            if job.id == q['id']:
                raise Killed()
            return super().harmonize(job)
    worker = Worker(client, {'igt': lambda job: Crashing(job, cfg, count=lambda v: 1)}, 'fake/m',
                    client_for=lambda token: client, now=lambda: clock['t'], sleep=lambda s: None,
                    heartbeat_s=10 ** 6)
    runs = 0
    while True:
        try:
            claimed = worker.once()
        except Killed:
            runs += 1
            clock['t'] += 1000  # restarted after the lease lapsed
            continue
        break
    assert runs == _JOB_RESUMES_MAX + 1, runs
    assert claimed is None, 'nothing is taken up again'
    row = client.jobs.rows[q['id']]
    assert row['state'] == 'failed' and row['reason'] == 'worker-lost'
    p = client.jobs.create('p1', 'igt', 'Gloss these too.')
    assert worker.once()['job']['id'] == p['id'], 'the slot is free'
