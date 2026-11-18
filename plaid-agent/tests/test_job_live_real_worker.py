"""The real job worker, started as prod starts it (``python -m
plaid_agent.jobworker --once``) with a scripted model, runs a small job to
done on a real core (REV-JR1-1): its own construction path, with no counter
or client injected by a test, is exercised by a test. A runner built without
the counter every other test injects failed every real job in planning.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names.
"""

import json
import os
import subprocess
import sys
import tempfile
import uuid

import pytest

from job_fixtures import GLOSSING_PLAN, document, job_project
from live import _skip_or_fail, core_url, login, seed


@pytest.fixture(scope='module')
def world():
    try:
        admin = login()
    except Exception as e:  # noqa: BLE001
        _skip_or_fail(f'no core: {e}')
    from plaid_client import PlaidClient
    email = f'job-real-{uuid.uuid4().hex[:8]}@example.org'
    admin.users.create(email, 'job-real-pass-1', False)
    writer = PlaidClient.login(core_url(), email, 'job-real-pass-1')
    docs = {'d1': document('d1', 'One', [{'words': ['ka']}])}
    lexicon = {'id': 'v1', 'name': 'Lexicon', 'project': 'p1', 'items': []}
    s = seed(admin, job_project(), docs, {'v1': lexicon}, name=f'job real worker {uuid.uuid4().hex[:6]}')
    admin.projects.add_writer(s.project_id, email)
    yield admin, writer, s
    s.delete()


def test_the_real_worker_module_runs_a_job_to_done(world):
    admin, writer, s = world
    made = writer.jobs.create(s.project_id, 'igt', 'Gloss the words.')
    script = [{'calls': [{'name': 'plan_work', 'arguments': GLOSSING_PLAN}]}, {'content': 'Planned.'},
              {'calls': [{'name': 'set_analysis', 'arguments': {
                  'document': 'One', 'ref': 's1.w1', 'morphemes': [
                      {'form': 'ka', 'type': 'stem', 'fields': {'Morph Gloss': 'go'}}]}}]},
              {'content': 'Done.'}]
    with tempfile.TemporaryDirectory() as dir_:
        with open(os.path.join(dir_, '.token'), 'w') as fh:
            fh.write(admin.token)
        with open(os.path.join(dir_, 'script.json'), 'w') as fh:
            json.dump(script, fh)
        # The checkout's own packages, as bb sets them for every Python step.
        env = {**os.environ, 'PYTHONPATH': os.environ.get('PYTHONPATH') or os.pathsep.join(
            p for p in sys.path if p.endswith(os.sep + 'src'))}
        run = subprocess.run([sys.executable, '-m', 'plaid_agent.jobworker', '--url', core_url(), '--model',
                              'openai/e2e-scripted', '--scripted-model', os.path.join(dir_, 'script.json'),
                              '--once'], cwd=dir_, env=env, capture_output=True, text=True, timeout=600)
    job = admin.jobs.get(made['id'])
    assert job['state'] == 'done', (job['state'], job.get('reason'), job.get('message'), run.stdout[-3000:],
                                    run.stderr[-3000:])
    assert job['report']['totals']['documents_done'] == 1
