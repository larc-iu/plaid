"""A job's piece analyses five sentences with analyze_sentence, on a real
core (AS, 2026-11-14): every word is analysed on its own word, linked to the
entry that fits or to the one new_entries made, the write lands in
one-request tries, and the report counts what core holds. Run as a writer,
whom core lets create entries in the project's own lexicon.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import uuid

from fixtures import MORPH_LAYER, WORD_LAYER
from job_fixtures import Model, blank, call, document, job_project, reply, use
from live import core_url, seed
from test_job_live_delete_sentence import _admin, _job, _runner

from plaid_client import PlaidClient
from plaid_agent.core.job import run_job
from plaid_agent.igt import job as igt_job


def _world(admin):
    email = f'job-lines-{uuid.uuid4().hex[:8]}@example.org'
    admin.users.create(email, 'job-lines-pass-1', False)
    writer = PlaidClient.login(core_url(), email, 'job-lines-pass-1')
    s = seed(admin, job_project(), {'dA': document('dA', 'Alpha', blank(5))},
             {'v1': {'id': 'v1', 'name': 'Lexicon', 'project': 'p1',
                     'items': [{'id': 'e-ta', 'form': 'ta', 'metadata': {'gloss': 'that'}}]}},
             name=f'job lines {uuid.uuid4().hex[:6]}')
    admin.projects.add_writer(s.project_id, email)
    return writer, s


def test_a_piece_analyses_five_sentences_and_core_holds_each_word_on_its_own(monkeypatch):
    admin = _admin()
    writer, s = _world(admin)
    try:
        def answer(asked, n, kwargs):
            if 'Your piece:' not in asked or n > 1:
                return reply('Glossed the piece.')
            return reply(calls=[call(1, 'analyze_sentence', {
                'document': 'Alpha', 'new_entries': True,
                'sentences': [{'ref': f's{t}', 'words': [f'ka-{t} go-X{t}', 'ta that']}
                              for t in range(1, 6)]})])
        use(monkeypatch, Model(answer))
        real, sent = igt_job.execute_plan, []

        def execute(c, ops, **kw):
            sent.append(sorted({o['kind'] for o in ops}))
            return real(c, ops, **kw)
        monkeypatch.setattr(igt_job, 'execute_plan', execute)
        job = _job(admin, writer, s, 'Segment, gloss and link.', 'document')
        finished = run_job(job, _runner(job))
        assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
        assert sent == [['create_entry', 'link', 'set_analysis']], sent
        raw = admin.documents.get(s.ids['dA'], include_body=True)
        tl = raw['text_layers'][0]
        body = tl['text']['body']
        layers = {tk['id']: tk for tk in tl['token_layers']}
        words = {(t['begin'], t['end']): body[t['begin']:t['end']] for t in layers[s.ids[WORD_LAYER]]['tokens']}
        morphs = layers[s.ids[MORPH_LAYER]]
        on = {}
        for t in sorted(morphs['tokens'], key=lambda t: (t['begin'], t.get('precedence') or 0)):
            on.setdefault(words[(t['begin'], t['end'])], []).append(t['metadata']['form'])
        assert on == {**{f'ka{t}': ['ka', str(t)] for t in range(1, 6)}, 'ta': ['ta'] * 5}, on
        linked = [l for v in morphs.get('vocabs') or [] for l in v.get('vocab_links') or []]
        assert len(linked) == 15, 'every morpheme of every word is linked'
        items = admin.vocab_layers.get(s.ids['v1'], include_items=True)['items']
        assert sorted(it['form'] for it in items) == sorted(['ta', 'ka', '1', '2', '3', '4', '5'])
        totals = finished['report']['totals']
        assert (totals['words'], totals['links'], totals['entries'], totals['changes']) == (10, 15, 6, 31), totals
        assert totals['proposed'] == 0
    finally:
        s.delete()
