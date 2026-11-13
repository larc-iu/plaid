"""What a History unit's times are on a real core (REV-B4-4): ``time`` is
its first member's and ``end_time`` its last's, and core places a unit by
its last. A group a person began before the job was made and wrote in
after it is someone in the document now, and the document is not quiet.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import time
import uuid

from job_fixtures import Model, reply, use
from test_job_live_reshape import _job, world  # noqa: F401 - the fixture

from plaid_agent.core.agent import ModelConfig
from plaid_agent.igt.job import IgtRunner
from plaid_agent.jobworker import count_chars


def test_a_group_begun_before_the_job_and_written_in_after_it_is_a_person_in_the_document(world, monkeypatch):
    admin, writer, s = world
    use(monkeypatch, Model(lambda asked, n, kwargs: reply('Done.')))
    d1 = s.ids['d1']
    group = str(uuid.uuid4())
    with writer.operation('first', group_id=group):
        writer.documents.set_metadata(d1, {'a': 1})
    time.sleep(1.5)
    job = _job(admin, writer, s)
    time.sleep(1.5)
    with writer.operation('later', group_id=group):
        writer.documents.set_metadata(d1, {'a': 2})
    runner = IgtRunner(job, ModelConfig(model='fake/m', stream=False, max_steps=1000), count=count_chars)
    newest = runner.newest_change(admin, d1)
    assert newest['time'] < job.job['created_at'] < newest['end_time'], (newest, job.job['created_at'])
    assert runner.in_use(newest, f'job:{job.id}/')
    assert not runner.quiet(newest, d1)
