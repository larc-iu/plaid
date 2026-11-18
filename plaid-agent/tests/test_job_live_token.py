"""A starter who logs out everywhere while their job works (D5 of the job
review 2026-11-18), under a real core: the logout revokes the job token the
worker holds (CONTRACT 4), the worker's next call is refused 401, a heartbeat
mints a valid token, and the job carries on to its end, done.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names.
"""

import re
import uuid

import pytest

from job_fixtures import Model, call, document, job_project, planned, reply, use
from live import _skip_or_fail, core_url, login, seed

from plaid_agent.core.agent import ModelConfig
from plaid_agent.core.job import Worker
from plaid_agent.igt.job import runner_factory
from plaid_agent.jobworker import count_chars


@pytest.fixture(scope='module')
def world():
    try:
        admin = login()
    except Exception as e:  # noqa: BLE001
        _skip_or_fail(f'no core: {e}')
    from plaid_client import PlaidClient
    email = f'job-logout-{uuid.uuid4().hex[:8]}@example.org'
    admin.users.create(email, 'job-logout-pass-1', False)
    writer = PlaidClient.login(core_url(), email, 'job-logout-pass-1')
    docs = {'d1': document('d1', 'One', [{'words': ['ka']}]), 'd2': document('d2', 'Two', [{'words': ['ka']}])}
    lexicon = {'id': 'v1', 'name': 'Lexicon', 'project': 'p1', 'items': []}
    s = seed(admin, job_project(), docs, {'v1': lexicon}, name=f'job logout {uuid.uuid4().hex[:6]}')
    admin.projects.add_writer(s.project_id, email)
    yield admin, writer, s
    s.delete()


def test_a_starter_who_logs_out_everywhere_mid_job_still_gets_a_done_job(world, monkeypatch):
    admin, writer, s = world
    made = writer.jobs.create(s.project_id, 'igt', 'Gloss the words.')
    logged_out = []

    def model(asked, n, kwargs):
        doc = asked.split('"')[1]
        if not logged_out:
            # The starter logs out everywhere while the piece works: the
            # token the worker holds is revoked before it writes.
            writer.auth.logout_everywhere()
            logged_out.append(doc)
        if n > 1:
            return reply('Done.')
        calls = []
        for line in asked.splitlines():
            if line.startswith('Empty in s'):
                sid = line.split()[2].rstrip(':')
                for w, form in re.findall(r'\bw(\d+) "([^"]*)"', line):
                    calls.append(call(len(calls) + 1, 'set_analysis', {'document': doc, 'ref': f'{sid}.w{w}',
                                                                      'morphemes': [{'form': form, 'type': 'stem'}]}))
        return reply(calls=calls)
    use(monkeypatch, Model(planned(model)))
    from plaid_client import PlaidClient
    worker = Worker(admin, {'igt': runner_factory(ModelConfig(model='fake/m', stream=False, max_steps=1000),
                                                  count=count_chars)},
                    'fake/m', client_for=lambda token: PlaidClient(core_url(), token))
    assert worker.once()
    job = admin.jobs.get(made['id'])
    assert logged_out, 'the starter logged out during the job'
    assert job['state'] == 'done', (job['state'], job.get('reason'))
    assert job['report']['totals']['documents_done'] == 2
