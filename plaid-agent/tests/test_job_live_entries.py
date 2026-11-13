"""The entries a job makes, under a real core: a job runs no cleanup of its
own entries, whatever a person did to its draft while it ran, one entry a
selection links in two documents is created once (REV-JG2-2), and an entry
of the job's a person took away is made again when a later piece links one
of its form and gloss (rulings 17 and 20, withdrawing the lead's ruling on
REV-JG3-5).

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


class Crash(BaseException):
    """The worker's process dies here."""


def _tok_in_both(asked, n, kwargs):
    """The selection analyses tok in both documents, makes one entry for it
    and links both, by its form."""
    if n == 1:
        return reply(calls=[
            call(1, 'set_analysis', {'document': 'Alpha', 'ref': 's1.w1',
                                     'morphemes': [{'form': 'tok', 'fields': {'Morph Gloss': 'stone'}}]}),
            call(2, 'set_analysis', {'document': 'Beta', 'ref': 's1.w1',
                                     'morphemes': [{'form': 'tok', 'fields': {'Morph Gloss': 'stone'}}]}),
            call(3, 'create_entry', {'form': 'tok', 'fields': {'gloss': 'stone'}})])
    if n == 2:
        return reply(calls=[call(4 + i, 'link_entry', {'document': d, 'refs': ['s1.w1.m1'], 'entry_form': 'tok'})
                            for i, d in enumerate(['Alpha', 'Beta'])])
    return reply('Glossed tok in both.')


@pytest.mark.parametrize('crash', [False, True])
def test_a_selection_links_one_new_entry_in_two_documents_and_creates_it_once(world, monkeypatch, crash):
    """REV-JG2-2: one entry, made with the first document's write, and the
    second document's link names it. With a crash between the two documents'
    writes, the job taken up again by a new worker creates nothing again and
    links the second document to the entry the first write made."""
    admin, writer, make = world
    s = make({'dA': document('dA', 'Alpha', [{'words': ['tok']}]), 'dB': document('dB', 'Beta', [{'words': ['tok']}])})
    use(monkeypatch, Model(_tok_in_both))
    job = _job(admin, writer, s, 'selection')
    if crash:
        real = IgtRunner.write

        def write(self, project, d, *a, **kw):
            if d == s.ids['dB']:
                raise Crash()
            return real(self, project, d, *a, **kw)
        monkeypatch.setattr(IgtRunner, 'write', write)
        with pytest.raises(Crash):
            run_job(job, _runner(job))
        monkeypatch.setattr(IgtRunner, 'write', real)
        assert len([x for x in _items(admin, s) if x.get('form') == 'tok']) == 1, 'the first write made it'
        job.rows = {x['document_id']: dict(x) for x in admin.jobs.get(job.id)['documents']}
    finished = run_job(job, _runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
    made = [x for x in _items(admin, s) if x.get('form') == 'tok']
    assert len(made) == 1, made
    for d in ('dA', 'dB'):
        assert [link['vocab_item']['id'] if isinstance(link['vocab_item'], dict) else link['vocab_item']
                for link in _links(admin, s, d)] == [made[0]['id']], d
        assert len(_morphs(admin, s, d)) == 1
    # REV-JG2-11: the entry taken up again is never proposed as a new one.
    assert not [c for c in finished['report']['proposed'] if c['kind'] == 'create_entry'], finished['report']['proposed']


def _tok_alone(doc):
    """A piece's model: analyse tok in ``doc``, make its entry, link it."""
    def answer(asked, n, kwargs):
        if f'"{doc}"' not in asked:
            return reply('Nothing for me here.')
        if n == 1:
            return reply(calls=[
                call(1, 'set_analysis', {'document': doc, 'ref': 's1.w1',
                                         'morphemes': [{'form': 'tok', 'fields': {'Morph Gloss': 'stone'}}]}),
                call(2, 'create_entry', {'form': 'tok', 'fields': {'gloss': 'stone'}})])
        if n == 2:
            return reply(calls=[call(3, 'link_entry', {'document': doc, 'refs': ['s1.w1.m1'],
                                                       'entry_form': 'tok'})])
        return reply('Glossed tok.')
    return answer


@pytest.mark.parametrize('edit', ['crash-then-delete', 'merge'])
def test_a_draft_a_person_took_away_is_made_again_by_a_later_piece(world, monkeypatch, edit):
    """The job makes tok 'stone' with Alpha and links it. Then a person
    takes the draft away: deletes it while the worker is down (a crash, a
    new worker takes the job up), or merges it into an entry of their own,
    toka 'rock'. Beta's piece makes tok 'stone' afresh, as nothing fits it
    now: it is made and linked, a machine draft, and nothing is proposed.
    After the merge, the job's link in Alpha names the person's entry, as
    core's merge moves every link of the entry merged away."""
    admin, writer, make = world
    s = make({'dA': document('dA', 'Alpha', [{'words': ['tok']}]), 'dB': document('dB', 'Beta', [{'words': ['tok']}])})
    job = _job(admin, writer, s, 'document')
    use(monkeypatch, Model(_tok_alone('Alpha')))
    real = IgtRunner.document

    def document_(self, d):
        if d == s.ids['dB']:
            raise Crash()
        return real(self, d)
    monkeypatch.setattr(IgtRunner, 'document', document_)
    with pytest.raises(Crash):
        run_job(job, _runner(job))
    monkeypatch.setattr(IgtRunner, 'document', real)
    draft = [x for x in _items(admin, s) if x.get('form') == 'tok']
    assert len(draft) == 1 and [link['vocab_item'] if not isinstance(link['vocab_item'], dict)
                                else link['vocab_item']['id'] for link in _links(admin, s, 'dA')] == [draft[0]['id']]
    survivor = None
    if edit == 'merge':
        survivor = admin.vocab_items.create(s.ids['v1'], 'toka', {'gloss': 'rock'})['id']
        admin.vocab_items.merge(survivor, [draft[0]['id']])
    else:
        admin.vocab_items.delete(draft[0]['id'])
    job.rows = {x['document_id']: dict(x) for x in admin.jobs.get(job.id)['documents']}
    use(monkeypatch, Model(_tok_alone('Beta')))
    finished = run_job(job, _runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
    again = [x for x in _items(admin, s) if x.get('form') == 'tok']
    assert len(again) == 1 and again[0]['id'] != draft[0]['id'], f'tok made again ({edit})'
    assert (again[0].get('metadata') or {}).get('status') == 'machine'
    beta = [link['vocab_item'] if not isinstance(link['vocab_item'], dict) else link['vocab_item']['id']
            for link in _links(admin, s, 'dB')]
    assert beta == [again[0]['id']], beta
    assert finished['report']['proposed'] == []
    alpha = [link['vocab_item'] if not isinstance(link['vocab_item'], dict) else link['vocab_item']['id']
             for link in _links(admin, s, 'dA')]
    assert alpha == ([survivor] if survivor else []), alpha
