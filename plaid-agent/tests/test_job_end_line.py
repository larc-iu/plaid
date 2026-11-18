"""The line a job ends with reaches core with its finish (S4-2 of the stress
campaign 2026-11-18): a heartbeat refused while the end's line is set (core
down for a moment) never leaves the last progress line ("Planning the work.")
as the reason a failed job shows. The finish sends the line once more just
before it, and a job ended with no line of its own ends with none."""

from job_fixtures import JobClient, ModelConfig, Model, document, planned, reply, use

from plaid_client import PlaidAPIError
from plaid_agent.core.job import Worker
from plaid_agent.igt.job import IgtRunner


def _run(monkeypatch, refuse_line):
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka']}])})
    made = client.jobs.create('p1', 'igt', 'Gloss the words.')
    use(monkeypatch, Model(planned(lambda asked, n, kw: reply('Done.'))))
    cfg = ModelConfig(model='fake/m', stream=False, max_steps=1000)
    beat = client.jobs.heartbeat

    def heartbeat(job_id, worker_id, **status):
        # The beat that carries the end's line is refused: core is down for
        # it and back for the finish.
        if refuse_line(status.get('message')):
            refuse_line.done = True
            raise PlaidAPIError('HTTP 502', status=502)
        return beat(job_id, worker_id, **status)
    client.jobs.heartbeat = heartbeat
    return client, made, cfg


def test_a_failed_jobs_error_line_is_stored_though_its_heartbeat_was_refused(monkeypatch):
    def refuse_line(message):
        return not getattr(refuse_line, 'done', False) and 'the runner broke' in (message or '')
    client, made, cfg = _run(monkeypatch, refuse_line)

    class Broken(IgtRunner):
        def work(self, job):
            raise RuntimeError('the runner broke')
    Worker(client, {'igt': lambda job: Broken(job, cfg, count=lambda v: 1)}, 'fake/m',
           client_for=lambda token: client, sleep=lambda s: None, heartbeat_s=10 ** 6).once()
    row = client.jobs.rows[made['id']]
    assert getattr(refuse_line, 'done', False), 'the line\'s heartbeat was refused'
    assert row['state'] == 'failed' and row['reason'] == 'worker-error'
    assert 'the runner broke' in (row['message'] or ''), row['message']


def test_a_job_that_ends_with_no_line_keeps_no_progress_line(monkeypatch):
    def refuse_line(message):
        return not getattr(refuse_line, 'done', False) and message is None
    client, made, cfg = _run(monkeypatch, refuse_line)
    Worker(client, {'igt': lambda job: IgtRunner(job, cfg, count=lambda v: 1)}, 'fake/m',
           client_for=lambda token: client, sleep=lambda s: None, heartbeat_s=10 ** 6).once()
    row = client.jobs.rows[made['id']]
    assert getattr(refuse_line, 'done', False), 'the heartbeat clearing the line was refused'
    assert row['state'] == 'done'
    assert row['message'] is None, row['message']


def test_a_done_job_with_its_report_written_keeps_no_progress_line(monkeypatch):
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka']}])})
    made = client.jobs.create('p1', 'igt', 'Gloss the words.')
    use(monkeypatch, Model(planned(lambda asked, n, kw: reply('Done.'))))
    cfg = ModelConfig(model='fake/m', stream=False, max_steps=1000)
    Worker(client, {'igt': lambda job: IgtRunner(job, cfg, count=lambda v: 1, write_summary=True)}, 'fake/m',
           client_for=lambda token: client, sleep=lambda s: None, heartbeat_s=10 ** 6).once()
    row = client.jobs.rows[made['id']]
    assert row['state'] == 'done'
    assert row['message'] is None, row['message']
