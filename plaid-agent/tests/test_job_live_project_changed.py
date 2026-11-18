"""People changing the project under a running job (S5-1 and S5-2 of the
stress campaign 2026-11-18), on a real core: a field deleted (one the job
fills or another) or the project's lexicon deleted while a piece is in
flight. The job never fails for it as an error of its own, and never says
its starter lost access: the document is taken again with the project as it
now is, and the job ends done.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import time
import uuid

import pytest

from fixtures import GLOSS, MGLOSS, TRANS
from job_fixtures import Model, call, document, job_project, plan_row, reply, targets_named, use
from live import _skip_or_fail, core_url, login, seed

from plaid_client import PlaidClient
from plaid_agent.core.agent import ModelConfig
from plaid_agent.core.job import Job, run_job
from plaid_agent.igt.job import IgtRunner
from plaid_agent.jobworker import count_chars

WORKER = '0193a5c0-0000-7000-8000-0000000000fa'


def _admin():
    try:
        return login()
    except Exception as e:  # noqa: BLE001
        _skip_or_fail(f'no core: {e}')


def _world(admin):
    email = f'job-change-{uuid.uuid4().hex[:8]}@example.org'
    admin.users.create(email, 'job-change-pass-1', False)
    starter = PlaidClient.login(core_url(), email, 'job-change-pass-1')
    lexicon = {'id': 'v1', 'name': 'Lexicon', 'project': 'p1', 'items': [
        {'id': 'e-kai', 'form': 'kai', 'metadata': {'gloss': 'go'}}]}
    # Story A is two stretches: the second is worked with the project as the
    # walk read it before the change.
    s = seed(admin, job_project(), {'dA': document('dA', 'Story A', [{'words': [w]} for w in
                                                                     ('kai', 'pele', 'tuna', 'lo', 'mo', 'sa', 'kai')]),
                                    'dB': document('dB', 'Story B', [{'words': ['lo']}])},
             {'v1': lexicon}, name=f'job change {uuid.uuid4().hex[:6]}')
    admin.projects.add_writer(s.project_id, email)
    return starter, s


def _job(admin, starter, s):
    made = starter.jobs.create(s.project_id, 'igt', 'Gloss every word.')
    claimed = admin.jobs.claim(WORKER, 'fake/m', ['igt'])
    assert claimed and claimed['job']['id'] == made['id']
    admin.jobs.add_decisions(made['id'], WORKER, [plan_row('sentences', ids=s.ids, fills=(MGLOSS,))])
    offset = {'s': 3600.0}

    def wait(sec):
        offset['s'] += sec
    return Job(admin, claimed, WORKER, client_for=lambda token: PlaidClient(core_url(), token), model='fake/m',
               sleep=wait, now=lambda: time.time() + offset['s'])


@pytest.mark.parametrize('change', ['translation-field', 'gloss-field', 'lexicon'])
def test_a_project_changed_under_a_piece_never_fails_the_job(monkeypatch, change):
    admin = _admin()
    starter, s = _world(admin)
    try:
        changed = []

        def answer(asked, n, kwargs):
            doc = 'Story B' if '"Story B"' in asked else 'Story A'
            if n > 1:
                return reply(f'{doc} glossed.')
            if not changed:
                # While the first piece is in flight, a maintainer changes the project.
                if change == 'lexicon':
                    admin.vocab_layers.delete(s.ids['v1'])
                else:
                    admin.span_layers.delete(s.ids[TRANS if change == 'translation-field' else GLOSS])
                changed.append(change)
            calls = []
            for line in asked.splitlines():
                if line.startswith('Empty in s'):
                    sid = line.split()[2].rstrip(':')
                    for w, form in __import__('re').findall(r'\bw(\d+) "([^"]*)"', line):
                        calls.append(call(len(calls) + 1, 'set_analysis', {
                            'document': doc, 'ref': f'{sid}.w{w}',
                            'morphemes': [{'form': form, 'type': 'stem', 'fields': {'Morph Gloss': 'G'}}]}))
            return reply(calls=calls or None, content=None if calls else 'Nothing to do.')
        use(monkeypatch, Model(answer))
        job = _job(admin, starter, s)
        finished = run_job(job, IgtRunner(job, ModelConfig(model='fake/m', stream=False, max_steps=1000),
                                          count=count_chars, write_summary=False))
        assert changed
        assert finished['state'] == 'done', (finished['state'], finished.get('reason'), job.status.get('message'))
        states = {r['document_id']: r['state'] for r in admin.jobs.get(finished['id'])['documents']}
        assert set(states.values()) == {'done'}, states
    finally:
        s.delete()


def test_a_lexicon_deleted_under_a_piece_that_links_never_fails_the_job(monkeypatch):
    """S5-2, the campaign's run dv1: the piece glosses and links each word's
    morpheme to the lexicon, which a maintainer deletes while it answers."""
    admin = _admin()
    email = f'job-change-{uuid.uuid4().hex[:8]}@example.org'
    admin.users.create(email, 'job-change-pass-1', False)
    starter = PlaidClient.login(core_url(), email, 'job-change-pass-1')
    forms = ('kai', 'pele', 'tuna', 'lo', 'mo', 'sa', 'kai')
    lexicon = {'id': 'v1', 'name': 'Lexicon', 'project': 'p1', 'items': [
        {'id': f'e-{f}', 'form': f, 'metadata': {'gloss': f.upper()}} for f in sorted(set(forms))]}
    s = seed(admin, job_project(), {
        'dA': document('dA', 'Story A', [{'words': [(f, [(f, None)], 'human')]} for f in forms]),
        'dB': document('dB', 'Story B', [{'words': [('lo', [('lo', None)], 'human')]}])},
        {'v1': lexicon}, name=f'job change {uuid.uuid4().hex[:6]}')
    admin.projects.add_writer(s.project_id, email)
    try:
        changed = []

        def answer(asked, n, kwargs):
            doc = 'Story B' if '"Story B"' in asked else 'Story A'
            if n > 1:
                return reply(f'{doc} glossed.')
            if not changed:
                admin.vocab_layers.delete(s.ids['v1'])
                changed.append(True)
            calls = []
            for si in targets_named(asked):
                sid = f's{si}'
                form = forms[si - 1] if doc == 'Story A' else 'lo'
                calls.append(call(len(calls) + 1, 'set_field', {'document': doc, 'refs': [f'{sid}.w1.m1'],
                                                               'field': 'Morph Gloss', 'value': form.upper()}))
                calls.append(call(len(calls) + 1, 'link_entry', {'document': doc, 'refs': [f'{sid}.w1.m1'],
                                                                'entry_form': form}))
            return reply(calls=calls)
        use(monkeypatch, Model(answer))
        job = _job(admin, starter, s)
        finished = run_job(job, IgtRunner(job, ModelConfig(model='fake/m', stream=False, max_steps=1000),
                                          count=count_chars, write_summary=False))
        assert changed
        assert finished['state'] == 'done', (finished['state'], finished.get('reason'), job.status.get('message'))
    finally:
        s.delete()
