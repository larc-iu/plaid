"""A job applies what it plans, under a real core (the owner's rulings 17 to
20 of 2026-11-13): what kept a job off a word or a translation before (a
comment, a person's multi-word expression or link, an empty value, a
person's translation) keeps it off no longer, and every value it writes is
its unverified machine proposal. A deletion and a merge whose answer was lost
are sent again and delete or merge nothing more.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import time
import uuid

import pytest

from fixtures import GLOSS, MORPH_LAYER, TEXT_ID, TRANS, WORD_LAYER
from job_fixtures import plan_row, Model, call, document, job_project, reply, use
from live import _skip_or_fail, core_url, login, seed

from plaid_client import PlaidAPIError
from plaid_agent.core.agent import ModelConfig
from plaid_agent.core.job import Job, run_job
from plaid_agent.core.plan import PlanError
from plaid_agent.igt import job as igt_job
from plaid_agent.igt.job import IgtRunner
from plaid_agent.jobworker import count_chars

WORKER = '0193a5c0-0000-7000-8000-0000000000f4'
#: How a person marked the blank word of each sentence before the job: under
#: the withdrawn rule all but the first three kept the job off.
MARKS = ['sentence-comment', 'translation-comment', 'nothing', 'word-comment', 'mwe', 'word-link',
         'morpheme-comment', 'empty-word-gloss']


def _admin():
    try:
        return login()
    except Exception as e:  # noqa: BLE001
        _skip_or_fail(f'no core: {e}')


def _writer(admin, prefix, maintainer=False):
    from plaid_client import PlaidClient
    email = f'{prefix}-{uuid.uuid4().hex[:8]}@example.org'
    admin.users.create(email, 'job-applies-pass-1', False)
    return email, PlaidClient.login(core_url(), email, 'job-applies-pass-1')


def _job(admin, writer, s, instructions, pieces):
    from plaid_client import PlaidClient
    made = writer.jobs.create(s.project_id, 'igt', instructions)
    claimed = admin.jobs.claim(WORKER, 'fake/m', ['igt'])
    assert claimed and claimed['job']['id'] == made['id']
    admin.jobs.add_decisions(made['id'], WORKER, [plan_row(pieces)])
    offset = {'s': 3600.0}

    def wait(sec):
        offset['s'] += sec
    return Job(admin, claimed, WORKER, client_for=lambda token: PlaidClient(core_url(), token), model='fake/m',
               sleep=wait, now=lambda: time.time() + offset['s'])


def _runner(job):
    return IgtRunner(job, ModelConfig(model='fake/m', stream=False, max_steps=1000), count=count_chars,
                     write_summary=False)


def _raw(admin, s, d='dA'):
    return admin.documents.get(s.ids[d], include_body=True)


def _tokens(raw, layer_id):
    return [t for tl in raw['text_layers'] for tk in tl['token_layers'] if tk['id'] == layer_id
            for t in tk.get('tokens') or []]


def _spans(raw):
    return [sp for tl in raw['text_layers'] for tk in tl['token_layers'] for sl in tk.get('span_layers') or []
            for sp in sl.get('spans') or []]


def _machine(md, job_id):
    return (md or {}).get('prov') == 'inferred' and ((md or {}).get('provDetail') or {}).get('job') == job_id \
        and not (md or {}).get('provConfirmed')


def test_what_kept_a_job_off_a_word_or_a_translation_keeps_it_off_no_longer(monkeypatch):
    admin = _admin()
    email, writer = _writer(admin, 'job-applies')
    sentences = [{'words': [f'bw{i}', f'nx{i}'], 'translation': ('A person wrote this.', 'human')}
                 for i in range(len(MARKS))]
    s = seed(admin, job_project(), {'dA': document('dA', 'Alpha', sentences)},
             {'v1': {'id': 'v1', 'name': 'Lexicon', 'project': 'p1', 'items': []}},
             name=f'job applies {uuid.uuid4().hex[:6]}')
    try:
        admin.projects.add_writer(s.project_id, email)
        item = writer.vocab_items.create(s.ids['v1'], 'expr')['id']
        raw = _raw(admin, s)
        words = _tokens(raw, s.ids[WORD_LAYER])
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
                return reply('Glossed and translated.')
            return reply(calls=[call(i, 'set_analysis', {'document': 'Alpha', 'ref': f's{i}.w1', 'morphemes': [
                {'form': f'bw{i - 1}', 'fields': {'Morph Gloss': 'JOB'}}]}) for i in range(1, len(MARKS) + 1)]
                + [call(100, 'set_field', {'document': 'Alpha', 'refs': [f's{i}' for i in range(1, len(MARKS) + 1)],
                                           'field': 'Translation', 'value': 'MACHINE'})])
        use(monkeypatch, Model(answer))
        job = _job(admin, writer, s, 'Gloss the first word of every sentence and translate every sentence again.',
                   'document')
        finished = run_job(job, _runner(job))
        assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
        assert finished['report']['proposed'] == []
        raw = _raw(admin, s)
        morphs = {m['id']: m['begin'] for m in _tokens(raw, s.ids[MORPH_LAYER])}
        glossed = {morphs.get(sp['tokens'][0]): sp for sp in _spans(raw) if sp.get('value') == 'JOB'}
        for i, mark in enumerate(MARKS, start=1):
            b = next(w['begin'] for w in _tokens(raw, s.ids[WORD_LAYER]) if w['id'] == s.ids[f'dA-s{i}w1'])
            assert b in glossed, mark
            assert _machine(glossed[b].get('metadata'), job.id), (mark, glossed[b].get('metadata'))
        translations = [sp for sp in _spans(raw) if sp['tokens'][0] in {s.ids[f'dA-s{i}'] for i in
                                                                        range(1, len(MARKS) + 1)}
                        and sp.get('value') not in (None, '') and sp.get('id') not in glossed]
        assert {sp.get('value') for sp in translations if sp['tokens'][0] in trans} >= {'MACHINE'}
        assert all(_machine(sp.get('metadata'), job.id) for sp in translations if sp.get('value') == 'MACHINE')
        assert not [sp for sp in translations if sp.get('value') == 'A person wrote this.'], \
            'every person\'s translation replaced'
        totals = finished['report']['totals']
        assert totals['changes'] >= len(MARKS) + 1 and totals['sentences'] == len(MARKS)
    finally:
        s.delete()


def test_a_deletion_and_a_merge_sent_again_after_a_lost_answer_delete_and_merge_nothing_more(monkeypatch):
    """BRIEF-JH item 10, on a real core. A selection deletes the doubled ka
    of s1, analyses sa in s2, deletes the entry old and merges gam#2 into
    gam. The write's last try, the lexicon's, lands and its answer is lost
    (a proxy's 502), so the same write is taken again from the gate, which
    asks core: every try landed, so nothing of it is sent again. One word
    deleted, two entries gone, every other entry and word as it was."""
    admin = _admin()
    email, writer = _writer(admin, 'job-lost')
    lexicon = {'id': 'v1', 'name': 'Lexicon', 'project': 'p1', 'items': [
        {'id': 'e-old', 'form': 'old', 'metadata': {'gloss': 'OLD'}},
        {'id': 'e-gam', 'form': 'gam', 'metadata': {'gloss': 'fish'}},
        {'id': 'e-gam2', 'form': 'gam', 'metadata': {'gloss': 'fish'}},
        {'id': 'e-keep', 'form': 'keep', 'metadata': {'gloss': 'KEEP'}}]}
    s = seed(admin, job_project(), {'dA': document('dA', 'Alpha', [{'words': ['ka', 'ka', 'ta']},
                                                                    {'words': ['sa']}])},
             {'v1': lexicon}, name=f'job lost {uuid.uuid4().hex[:6]}')
    try:
        admin.projects.add_maintainer(s.project_id, email)
        ids = {'old': s.ids['e-old'], 'gam': s.ids['e-gam'], 'gam2': s.ids['e-gam2'], 'keep': s.ids['e-keep']}

        def answer(asked, n, kwargs):
            if 'Your piece: the whole selection above.' not in asked:
                return reply('Nothing more to do.')
            if n == 1:
                return reply(calls=[call(1, 'read_document', {'document': 'Alpha'})])
            if n == 2:
                return reply(calls=[
                    call(2, 'delete_word', {'document': 'Alpha', 'refs': ['s1.w2']}),
                    call(3, 'set_analysis', {'document': 'Alpha', 'ref': 's2.w1',
                                             'morphemes': [{'form': 'sa', 'fields': {'Morph Gloss': 'go'}}]}),
                    call(4, 'delete_entry', {'entry_id': ids['old']}),
                    call(5, 'merge_entries', {'keep_id': ids['gam'], 'remove_id': ids['gam2']})])
            return reply('Deleted the doubled ka, glossed sa, cleaned the lexicon.')
        use(monkeypatch, Model(answer))
        real, lost, sent = igt_job.execute_plan, [], []

        def execute(c, ops, **kw):
            sent.append([o['kind'] for o in ops])
            out = real(c, ops, **kw)
            if not lost and any(o['kind'] == 'delete_entry' for o in ops):
                lost.append([o['kind'] for o in ops])
                cause = PlaidAPIError('HTTP 502 Bad Gateway', status=502, method='POST')
                try:
                    raise cause
                except PlaidAPIError as e:
                    # The lexicon's try landed, its answer lost.
                    raise PlanError('the answer was lost', len(ops), len(ops), unknown=True) from e
            return out
        monkeypatch.setattr(igt_job, 'execute_plan', execute)
        job = _job(admin, writer, s, 'Delete the doubled ka, gloss sa as go, delete the entry old and merge the two '
                                     'gam entries.', 'selection')
        finished = run_job(job, _runner(job))
        assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
        assert lost and sorted(lost[0]) == ['delete_entry', 'merge_entries'], lost
        assert [sorted(x) for x in sent] == [['delete_word', 'set_analysis'], ['delete_entry', 'merge_entries']], \
            f'each try sent once, nothing sent again from the gate: {sent}'
        assert finished['report']['totals']['repeated'] == 4, 'all four left out when taken again'
        items = admin.vocab_layers.get(s.ids['v1'], include_items=True).get('items') or []
        assert sorted(it['id'] for it in items) == sorted([ids['gam'], ids['keep']]), items
        raw = _raw(admin, s)
        body = raw['text_layers'][0]['text']['body']
        words = sorted((w['begin'], body[w['begin']:w['end']]) for w in _tokens(raw, s.ids[WORD_LAYER]))
        assert [w for _, w in words] == ['ka', 'ta', 'sa'], words
        assert finished['report']['proposed'] == []
    finally:
        s.delete()
