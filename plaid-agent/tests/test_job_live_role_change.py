"""A starter whose role changes while their job works (S9-1 of the stress
campaign 2026-11-18), on a real core. A maintainer made a writer may still
run a job: what a writer may not do (delete, rename or merge the lexicon's
entries) is refused by core, and the job takes that document again with the
starter's role as it now is, so such a change is proposed, never applied, and
the rest is written. The job ends done, never failed for an access the
starter still has. A starter made a reader can no longer write: that job
ends failed, ``starter-access``.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import time
import uuid

import pytest

from job_fixtures import Model, call, document, job_project, plan_row, reply, use
from live import _skip_or_fail, core_url, login, seed

from plaid_client import PlaidClient
from plaid_agent.core.agent import ModelConfig
from plaid_agent.core.job import Job, run_job
from plaid_agent.igt.job import IgtRunner
from plaid_agent.jobworker import count_chars

WORKER = '0193a5c0-0000-7000-8000-0000000000f9'


def _admin():
    try:
        return login()
    except Exception as e:  # noqa: BLE001
        _skip_or_fail(f'no core: {e}')


def _world(admin):
    email = f'job-role-{uuid.uuid4().hex[:8]}@example.org'
    admin.users.create(email, 'job-role-pass-1', False)
    starter = PlaidClient.login(core_url(), email, 'job-role-pass-1')
    lexicon = {'id': 'v1', 'name': 'Lexicon', 'project': 'p1', 'items': [
        {'id': 'e-kai', 'form': 'kai', 'metadata': {'gloss': 'go'}},
        {'id': 'e-nima', 'form': 'nima', 'metadata': {'gloss': 'five'}}]}
    s = seed(admin, job_project(), {'dA': document('dA', 'Alpha', [{'words': ['zor']}]),
                                    'dB': document('dB', 'Beta', [{'words': ['meri']}])},
             {'v1': lexicon}, name=f'job role {uuid.uuid4().hex[:6]}')
    admin.projects.add_maintainer(s.project_id, email)
    return email, starter, s


def _job(admin, starter, s):
    made = starter.jobs.create(s.project_id, 'igt', 'Gloss every word and delete the entries kai and nima.')
    claimed = admin.jobs.claim(WORKER, 'fake/m', ['igt'])
    assert claimed and claimed['job']['id'] == made['id']
    admin.jobs.add_decisions(made['id'], WORKER, [plan_row('document', ids=s.ids)])
    offset = {'s': 3600.0}

    def wait(sec):
        offset['s'] += sec
    return Job(admin, claimed, WORKER, client_for=lambda token: PlaidClient(core_url(), token), model='fake/m',
               sleep=wait, now=lambda: time.time() + offset['s'])


@pytest.mark.parametrize('to', ['writer', 'reader'])
def test_a_maintainer_made_a_writer_keeps_their_job_and_one_made_a_reader_loses_it(monkeypatch, to):
    admin = _admin()
    email, starter, s = _world(admin)
    try:
        demoted = []

        def answer(asked, n, kwargs):
            doc = 'Beta' if '"Beta"' in asked else 'Alpha'
            if n > 1:
                return reply(f'{doc} glossed.')
            if doc == 'Beta' and not demoted:
                # Before Beta's piece answers, an admin changes the starter's role.
                (admin.projects.add_writer if to == 'writer' else admin.projects.add_reader)(s.project_id, email)
                demoted.append(to)
            form, entry = ('zor', 'e-kai') if doc == 'Alpha' else ('meri', 'e-nima')
            return reply(calls=[
                call(1, 'set_analysis', {'document': doc, 'ref': 's1.w1',
                                         'morphemes': [{'form': form, 'fields': {'Morph Gloss': f'{form}-JOB'}}]}),
                call(2, 'delete_entry', {'entry_id': s.ids[entry]})])
        use(monkeypatch, Model(answer))
        job = _job(admin, starter, s)
        finished = run_job(job, IgtRunner(job, ModelConfig(model='fake/m', stream=False, max_steps=1000),
                                          count=count_chars, write_summary=False))
        assert demoted
        items = {it['form'] for it in admin.vocab_layers.get(s.ids['v1'], include_items=True).get('items') or []}
        if to == 'reader':
            assert finished['state'] == 'failed' and finished['reason'] == 'starter-access', finished.get('reason')
            return
        assert finished['state'] == 'done', (finished['state'], finished.get('reason'), job.status.get('message'))
        assert items == {'nima'}, 'kai deleted while a maintainer, nima kept once a writer'
        rows = {r['document_id']: r for r in admin.jobs.get(finished['id'])['documents']}
        assert rows[s.ids['dB']]['state'] == 'done', rows[s.ids['dB']]
        proposed = finished['report'].get('proposed') or []
        assert any(p.get('kind') == 'delete_entry' for p in proposed), proposed
        raw = admin.documents.get(s.ids['dB'], include_body=True)
        glosses = [sp.get('value') for tl in raw['text_layers'] for tk in tl['token_layers']
                   for sl in tk.get('span_layers') or [] for sp in sl.get('spans') or []]
        assert 'meri-JOB' in glosses, glosses
    finally:
        s.delete()
