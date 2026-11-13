"""The entries a job makes, under a real core: a job deletes none of them
(the lead's ruling on REV-JG2-1), whatever a person did to its draft while
it ran, and one entry a selection links in two documents is created once
(REV-JG2-2).

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import time
import uuid

import pytest

from fixtures import MORPH_LAYER
from job_fixtures import plan_row, Model, call, document, job_project, reply, use
from live import _skip_or_fail, core_url, login, seed

from plaid_agent.core.agent import ModelConfig
from plaid_agent.core.job import Job, run_job
from plaid_agent.igt.job import IgtRunner
from plaid_agent.jobworker import count_chars

WORKER = '0193a5c0-0000-7000-8000-0000000000f2'


@pytest.fixture
def world():
    try:
        admin = login()
    except Exception as e:  # noqa: BLE001
        _skip_or_fail(f'no core: {e}')
    from plaid_client import PlaidClient
    email = f'job-entries-{uuid.uuid4().hex[:8]}@example.org'
    admin.users.create(email, 'job-entries-pass-1', False)
    writer = PlaidClient.login(core_url(), email, 'job-entries-pass-1')
    made = {}

    def make(docs, maintainer=False):
        lexicon = {'id': 'v1', 'name': 'Lexicon', 'project': 'p1', 'items': []}
        s = seed(admin, job_project(), docs, {'v1': lexicon}, name=f'job entries {uuid.uuid4().hex[:6]}')
        (admin.projects.add_maintainer if maintainer else admin.projects.add_writer)(s.project_id, email)
        made['s'] = s
        return s
    yield admin, writer, make
    if 's' in made:
        made['s'].delete()


def _job(admin, writer, s, pieces):
    from plaid_client import PlaidClient
    made = writer.jobs.create(s.project_id, 'igt', 'Gloss every word nobody analysed.')
    claimed = admin.jobs.claim(WORKER, 'fake/m', ['igt'])
    assert claimed and claimed['job']['id'] == made['id']
    admin.jobs.add_decisions(made['id'], WORKER, [plan_row(pieces)])
    offset = {'s': 0.0}

    def wait(sec):
        offset['s'] += sec
    return Job(admin, claimed, WORKER, client_for=lambda token: PlaidClient(core_url(), token), model='fake/m',
               sleep=wait, now=lambda: time.time() + offset['s'])


def _runner(job):
    return IgtRunner(job, ModelConfig(model='fake/m', stream=False, max_steps=1000), count=count_chars,
                     write_summary=False)


def _items(admin, s):
    return admin.vocab_layers.get(s.ids['v1'], include_items=True).get('items') or []


def _links(admin, s, d):
    raw = admin.documents.get(s.ids[d], include_body=True)
    return [link for tl in raw['text_layers'] for tk in tl['token_layers'] for v in tk.get('vocabs') or []
            for link in v.get('vocab_links') or []]


def _morphs(admin, s, d):
    raw = admin.documents.get(s.ids[d], include_body=True)
    return [t for tl in raw['text_layers'] for tk in tl['token_layers'] if tk['id'] == s.ids[MORPH_LAYER]
            for t in tk.get('tokens') or []]


@pytest.mark.parametrize('edit', ['unlink', 'status', 'gloss', 'comment'])
def test_a_draft_a_person_unlinks_during_the_job_is_never_deleted(world, monkeypatch, edit):
    """The job makes and links the entry tok. The starter, a maintainer
    reviewing the job's work as it goes, unlinks it as the job reaches
    harmonize, and may also set its Status, correct its gloss or comment on
    it. The job ends done with the entry where it was, as the starter left
    it, listed with no links, and nothing deleted."""
    admin, writer, make = world
    s = make({'dA': document('dA', 'Alpha', [{'words': ['tok', 'ta']}])}, maintainer=True)

    def answer(asked, n, kwargs):
        if n == 1:
            return reply(calls=[
                call(1, 'set_analysis', {'document': 'Alpha', 'ref': 's1.w1',
                                         'morphemes': [{'form': 'tok', 'fields': {'Morph Gloss': 'stone'}}]}),
                call(2, 'create_entry', {'form': 'tok', 'fields': {'gloss': 'stone'}})])
        if n == 2:
            return reply(calls=[call(3, 'link_entry', {'document': 'Alpha', 'refs': ['s1.w1.m1'],
                                                       'entry_form': 'tok'})])
        return reply('Glossed tok.')
    use(monkeypatch, Model(answer))
    job = _job(admin, writer, s, 'document')
    real = IgtRunner.harmonize
    item = {}

    def harmonize(self, job_):
        item['id'] = [x for x in _items(admin, s) if x.get('form') == 'tok'][0]['id']
        for link in _links(admin, s, 'dA'):
            writer.vocab_links.delete(link['id'])
        if edit == 'status':
            writer.vocab_items.patch_metadata(item['id'], [{'op': 'set', 'path': ['status'], 'value': 'reviewed'}])
        elif edit == 'gloss':
            writer.vocab_items.patch_metadata(item['id'], [{'op': 'set', 'path': ['gloss'], 'value': 'rock'}])
        elif edit == 'comment':
            writer.comments.create('vocab-item', item['id'], 'Keep this one.')
        return real(self, job_)
    monkeypatch.setattr(IgtRunner, 'harmonize', harmonize)
    finished = run_job(job, _runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
    left = [x for x in _items(admin, s) if x['id'] == item['id']]
    assert left, f'the draft the person unlinked ({edit}) was deleted by the job'
    md = left[0].get('metadata') or {}
    assert md.get('status') == ('reviewed' if edit == 'status' else 'machine')
    assert md.get('gloss') == ('rock' if edit == 'gloss' else 'stone')
    entries = finished['report']['entries']
    assert [e['id'] for e in entries['unlinked']] == [item['id']] and not entries.get('deleted')
