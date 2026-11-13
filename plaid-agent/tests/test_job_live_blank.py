"""THE blank word under a real core (the lead's rulings on REV-JG and
REV-JG2-4): a word with no analysis and no value is the job's to fill only
when nothing anyone but the job made hangs on it or on its morphemes. Each
sentence holds a blank word marked one way by a person: the job fills those
marked on the sentence or its translation, and proposes the rest.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import time
import uuid

import pytest

from fixtures import GLOSS, MORPH_LAYER, TEXT_ID, WORD_LAYER
from job_fixtures import plan_row, Model, call, document, job_project, reply, use
from live import _skip_or_fail, core_url, login, seed

from plaid_agent.core.agent import ModelConfig
from plaid_agent.core.job import Job, run_job
from plaid_agent.igt.job import IgtRunner
from plaid_agent.jobworker import count_chars

WORKER = '0193a5c0-0000-7000-8000-0000000000f3'
#: How a person marked the blank word of each sentence, and whether the job
#: fills it (True) or proposes what it staged there (False).
MARKS = {'sentence-comment': True, 'translation-comment': True, 'nothing': True,
         'word-comment': False, 'mwe': False, 'word-link': False, 'morpheme-comment': False,
         'empty-word-gloss': False}


@pytest.fixture
def world():
    try:
        admin = login()
    except Exception as e:  # noqa: BLE001
        _skip_or_fail(f'no core: {e}')
    from plaid_client import PlaidClient
    email = f'job-blank-{uuid.uuid4().hex[:8]}@example.org'
    admin.users.create(email, 'job-blank-pass-1', False)
    writer = PlaidClient.login(core_url(), email, 'job-blank-pass-1')
    sentences = [{'words': [f'bw{i}', f'nx{i}'], 'translation': ('A person wrote this.', 'human')}
                 for i in range(len(MARKS))]
    lexicon = {'id': 'v1', 'name': 'Lexicon', 'project': 'p1', 'items': []}
    s = seed(admin, job_project(), {'dA': document('dA', 'Alpha', sentences)}, {'v1': lexicon},
             name=f'job blank {uuid.uuid4().hex[:6]}')
    admin.projects.add_writer(s.project_id, email)
    yield admin, writer, s
    s.delete()


def _layer(admin, s, layer):
    raw = admin.documents.get(s.ids['dA'], include_body=True)
    return [t for tl in raw['text_layers'] for tk in tl['token_layers'] if tk['id'] == s.ids[layer]
            for t in tk.get('tokens') or []], raw


def _spans(raw):
    return [sp for tl in raw['text_layers'] for tk in tl['token_layers'] for sl in tk.get('span_layers') or []
            for sp in sl.get('spans') or []]


def test_what_keeps_a_job_off_a_blank_word(world, monkeypatch):
    admin, writer, s = world
    item = writer.vocab_items.create(s.ids['v1'], 'expr')['id']
    words, raw = _layer(admin, s, WORD_LAYER)
    trans = {sp['tokens'][0]: sp['id'] for sp in _spans(raw) if sp.get('value') == 'A person wrote this.'}
    for i, mark in enumerate(MARKS, start=1):
        sid, w1, w2 = s.ids[f'dA-s{i}'], s.ids[f'dA-s{i}w1'], s.ids[f'dA-s{i}w2']
        word = next(w for w in words if w['id'] == w1)
        if mark == 'sentence-comment':
            writer.comments.create('token', sid, 'Leave this sentence to me.')
        elif mark == 'word-comment':
            writer.comments.create('token', w1, 'Not sure about this word.')
        elif mark == 'translation-comment':
            writer.comments.create('span', trans[sid], 'Check the first word.')
        elif mark == 'mwe':
            writer.vocab_links.create(item, [w1, w2])
        elif mark == 'word-link':
            writer.vocab_links.create(item, [w1])
        elif mark == 'morpheme-comment':
            m = writer.tokens.create(s.ids[MORPH_LAYER], s.ids[f'{TEXT_ID}-dA'], word['begin'], word['end'],
                                     precedence=1, metadata={'form': f'bw{i - 1}'})
            writer.comments.create('token', m['id'], 'Unsure.')
        elif mark == 'empty-word-gloss':
            writer.spans.create(s.ids[GLOSS], [w1], '')

    def answer(asked, n, kwargs):
        if n > 1:
            return reply('Glossed.')
        return reply(calls=[call(i, 'set_analysis', {'document': 'Alpha', 'ref': f's{i}.w1', 'morphemes': [
            {'form': f'bw{i - 1}', 'fields': {'Morph Gloss': 'JOB'}}]}) for i in range(1, len(MARKS) + 1)])
    use(monkeypatch, Model(answer))
    from plaid_client import PlaidClient
    made = writer.jobs.create(s.project_id, 'igt', 'Gloss every word nobody analysed.')
    claimed = admin.jobs.claim(WORKER, 'fake/m', ['igt'])
    assert claimed and claimed['job']['id'] == made['id']
    admin.jobs.add_decisions(made['id'], WORKER, [plan_row('document')])
    # The marks are older than the job's quiet window.
    job = Job(admin, claimed, WORKER, client_for=lambda token: PlaidClient(core_url(), token), model='fake/m',
              sleep=lambda sec: None, now=lambda: time.time() + 3600)
    finished = run_job(job, IgtRunner(job, ModelConfig(model='fake/m', stream=False, max_steps=1000),
                                      count=count_chars, write_summary=False))
    assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
    morphs, raw = _layer(admin, s, MORPH_LAYER)
    begin_of = {m['id']: m['begin'] for m in morphs}
    glossed = {begin_of.get(sp['tokens'][0]) for sp in _spans(raw) if sp.get('value') == 'JOB'}
    filled, proposed = {}, {c.get('ref') for c in finished['report']['proposed']}
    for i, mark in enumerate(MARKS, start=1):
        b = next(w['begin'] for w in _layer(admin, s, WORD_LAYER)[0] if w['id'] == s.ids[f'dA-s{i}w1'])
        filled[mark] = b in glossed
        assert (f's{i}.w1' in proposed) != filled[mark], (mark, proposed)
    assert filled == MARKS, filled
