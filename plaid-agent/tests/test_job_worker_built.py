"""A job's runner built as the real worker builds it for a real model
(REV-JR1-1): ``runner_factory(cfg, count=None)``, the counter tests always
inject left out. Planning and the whole-document gate count with the
model's own tokenizer, the one the piece's budget counts with, and a job
runs to done. Every other test injects a counter, which is how a runner with
none failed every real job in planning without a test seeing it."""

import pytest

from job_fixtures import JobClient, Model, planned, start, use
from test_job_core_blips import J, _analyse, _docs

from plaid_agent.core.agent import ModelConfig
from plaid_agent.core.job import Worker, run_job
from plaid_agent.igt.job import runner_factory


@pytest.mark.parametrize('pieces', [None, 'sentences', 'document', 'selection'])
def test_a_runner_built_with_no_counter_runs_a_job_to_done(monkeypatch, pieces):
    client = JobClient(_docs())
    job = start(client, id=J, plan=pieces)
    use(monkeypatch, Model(planned(_analyse)))
    r = runner_factory(ModelConfig(model='fake/m', stream=False, max_steps=1000), count=None)(job)
    finished = run_job(job, r)
    assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))


def test_the_workers_own_construction_runs_a_job_to_done(monkeypatch):
    """Worker.once, as jobworker.main calls it, with the runners it builds."""
    client = JobClient(_docs())
    made = client.jobs.create('p1', 'igt', 'Gloss the words.')
    use(monkeypatch, Model(planned(_analyse)))
    cfg = ModelConfig(model='fake/m', stream=False, max_steps=1000)
    worker = Worker(client, {'igt': runner_factory(cfg, count=None)}, cfg.model, client_for=lambda token: client,
                    sleep=lambda s: None)
    assert worker.once()
    row = client.jobs.rows[made['id']]
    assert row['state'] == 'done', (row.get('reason'), row.get('message'))
