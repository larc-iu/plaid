"""S6-2, on a real core: a job that deletes or merges a lexicon entry takes or
moves every link to it, people's links in documents outside the job too. The
report counts each link people made that it took or moved as people's work,
and says how many of them are outside the job's documents.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import time
import uuid

import pytest

from job_fixtures import plan_row, Model, call, document, job_project, reply, use
from live import _skip_or_fail, core_url, login, seed

from plaid_agent.core.agent import ModelConfig
from plaid_agent.core.job import Job, run_job
from plaid_agent.igt.job import IgtRunner
from plaid_agent.jobworker import count_chars

WORKER = '0193a5c0-0000-7000-8000-0000000000f6'


def _admin():
    try:
        return login()
    except Exception as e:  # noqa: BLE001
        _skip_or_fail(f'no core: {e}')


def _maintainer(admin, s):
    from plaid_client import PlaidClient
    email = f'job-entry-{uuid.uuid4().hex[:8]}@example.org'
    admin.users.create(email, 'job-entry-pass-1', False)
    admin.projects.add_maintainer(s.project_id, email)
    return PlaidClient.login(core_url(), email, 'job-entry-pass-1')


def _job(admin, starter, s, instructions, documents):
    from plaid_client import PlaidClient
    made = starter.jobs.create(s.project_id, 'igt', instructions, documents)
    claimed = admin.jobs.claim(WORKER, 'fake/m', ['igt'])
    assert claimed and claimed['job']['id'] == made['id']
    admin.jobs.add_decisions(made['id'], WORKER, [plan_row('document', ids=s.ids)])
    offset = {'s': 3600.0}

    def wait(sec):
        offset['s'] += sec
    return Job(admin, claimed, WORKER, client_for=lambda token: PlaidClient(core_url(), token), model='fake/m',
               sleep=wait, now=lambda: time.time() + offset['s'])


def _seed(admin):
    lexicon = {'id': 'v1', 'name': 'Lex', 'project': 'p1', 'items': [
        {'id': 'e-kai', 'form': 'kai', 'metadata': {'gloss': 'go'}},
        {'id': 'e-ka', 'form': 'ka', 'metadata': {'gloss': 'go'}}]}
    docs = {'dA': document('dA', 'Long story', [{'words': [('kai', [('kai', 'go', 'e-kai')], 'human'), 'lo']}]),
            'dB': document('dB', 'Second', [{'words': [('kai', [('kai', 'go', 'e-kai')], 'human'), 'lo']}])}
    return seed(admin, job_project(), docs, {'v1': lexicon}, name=f'job entry people {uuid.uuid4().hex[:6]}')


@pytest.mark.parametrize('how', ['delete', 'merge'])
def test_an_entry_taken_or_merged_counts_peoples_links_and_those_outside_the_job(monkeypatch, how):
    admin = _admin()
    s = _seed(admin)
    try:
        starter = _maintainer(admin, s)
        kai, ka = s.ids['e-kai'], s.ids['e-ka']
        step = (call(1, 'delete_entry', {'entry_id': kai}) if how == 'delete'
                else call(1, 'merge_entries', {'keep_id': ka, 'remove_id': kai}))

        def answer(asked, n, kwargs):
            if 'Instructions from' in asked and n == 1:
                return reply(calls=[step])
            return reply('Done.')
        use(monkeypatch, Model(answer))
        job = _job(admin, starter, s, 'Clean the lexicon.', [s.ids['dA']])
        finished = run_job(job, IgtRunner(job, ModelConfig(model='fake/m', stream=False, max_steps=1000),
                                          count=count_chars, write_summary=False))
        assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
        totals = finished['report']['totals']
        assert totals['peoples_values_changed'] == 2, totals
        assert totals['peoples_outside'] == 1, totals
        assert finished['report']['notice'].startswith(
            "People's work: 2 values, morphemes or links people wrote were changed or removed, 1 of them outside "
            "the job's documents."), finished['report']['notice']
    finally:
        s.delete()
