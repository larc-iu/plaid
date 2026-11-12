"""A job the worker cannot take to its end fails, and is never taken again
to fail the same way, so one job cannot hold the server's one slot forever
(REV-J-B S2-4). A document's skipped sentences past core's cap of its list
are counted, not listed, so the row core keeps never grows past what core
takes."""

from job_fixtures import JobClient, ModelConfig, document, reply, runner, start, use, Model

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
    client.jobs.create('p1', 'igt', ['gloss'])
    cfg = ModelConfig(model='fake/m', stream=False, max_steps=1000)

    class Broken(IgtRunner):
        def work(self, job):
            raise RuntimeError('the runner broke')
    worker = _worker(client, lambda job: Broken(job, cfg, count=lambda v: 1))
    claimed = worker.once()
    row = client.jobs.rows[claimed['job']['id']]
    assert row['state'] == 'failed' and row['reason'] == 'worker-error'
    assert 'RuntimeError: the runner broke' in row['message']
    assert worker.once() is None, 'nothing is taken again'


def test_a_finish_core_refuses_still_ends_the_job_failed(monkeypatch):
    client = _client()
    client.jobs.create('p1', 'igt', ['gloss'])
    use(monkeypatch, Model(lambda asked, n, kw: reply('Done.')))
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
