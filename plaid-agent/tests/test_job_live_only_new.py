"""RP-6 on a real core (RPF-A7, the owner's R3): a job set up to fill only
the words it adds inserts a zero subject, gives it a Gloss, and is refused
the Gloss it also stages on an existing word. The inserted word has its
value, no existing word has one, and the report lists the refusal as
``not-added``.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import time

from fixtures import GLOSS
from job_fixtures import Model, call, plan_row, reply, text_edits, use
from live import core_url
from test_retype_word_refs_live import WORKER, _admin, _seeded

import pytest

from plaid_agent.core.agent import ModelConfig
from plaid_agent.core.job import Job, run_job
from plaid_agent.igt.job import IgtRunner
from plaid_agent.jobworker import count_chars


@pytest.fixture(autouse=True)
def _text_edits(monkeypatch):
    text_edits(monkeypatch)


def test_rp6_a_job_that_fills_only_the_words_it_adds_fills_the_inserted_word_alone(monkeypatch):
    from plaid_client import PlaidClient
    admin = _admin()
    _email, writer, s = _seeded(admin, 'only-new', [{'words': ['sc', 'tqmc']}, {'words': ['kx', 'naope']}])
    try:
        def answer(asked, n, kwargs):
            if 'Your piece: the whole document' not in asked or n > 1:
                return reply('Inserted the zero subject and glossed it.')
            return reply(calls=[
                call(1, 'retype_sentence', {'document': 'Alpha', 'ref': 's1', 'text': 'sc ∅ tqmc.'}),
                call(2, 'set_field', {'document': 'Alpha', 'refs': ['s1.w2 "∅"'], 'field': 'Gloss', 'value': 'he'}),
                call(3, 'set_field', {'document': 'Alpha', 'refs': ['s2.w2'], 'field': 'Gloss', 'value': 'go'})])
        use(monkeypatch, Model(answer))
        made = writer.jobs.create(s.project_id, 'igt', 'Insert a zero subject before each verb with none, and give '
                                  'it the Gloss "he".',
                                  setup={'fills': [{'id': s.ids[GLOSS], 'name': 'Gloss'}], 'text': True,
                                         'conversation': '0193a5c0-0000-7000-8000-00000000c0c0', 'onlynew': True})
        claimed = admin.jobs.claim(WORKER, 'fake/m', ['igt'])
        assert claimed and claimed['job']['id'] == made['id']
        admin.jobs.add_decisions(made['id'], WORKER, [plan_row('document', fills=(GLOSS,), ids=s.ids)])
        offset = {'s': 3600.0}

        def wait(sec):
            offset['s'] += sec
        job = Job(admin, claimed, WORKER, client_for=lambda token: PlaidClient(core_url(), token), model='fake/m',
                  sleep=wait, now=lambda: time.time() + offset['s'])
        finished = run_job(job, IgtRunner(job, ModelConfig(model='fake/m', stream=False, max_steps=1000),
                                          count=count_chars, write_summary=False))
        assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
        words = _all_glosses(admin, s)
        assert words == [('sc', None), ('∅', 'he'), ('tqmc', None), ('kx', None), ('naope', None)], words
        refused = finished['report']['documents'][0].get('refused') or []
        assert [(r['sentence'], r['code']) for r in refused] == [('s2', 'not-added')], refused
        totals = finished['report']['totals']
        assert totals['words_added'] == 1 and totals['tokens_changed'] == 0, totals
    finally:
        s.delete()


def _all_glosses(admin, s):
    """Every word of the document with its Gloss, in order."""
    from fixtures import WORD_LAYER
    raw = admin.documents.get(s.ids['dA'], include_body=True)
    tl = raw['text_layers'][0]
    body = tl['text']['body']
    layers = {tk['id']: tk for tk in tl['token_layers']}
    words = sorted(layers[s.ids[WORD_LAYER]]['tokens'], key=lambda t: t['begin'])
    spans = {sp['tokens'][0]: sp['value'] for sl in layers[s.ids[WORD_LAYER]].get('span_layers') or []
             if sl['id'] == s.ids[GLOSS] for sp in sl.get('spans') or []}
    return [(body[t['begin']:t['end']], spans.get(t['id'])) for t in words if body[t['begin']:t['end']].strip('.')]
