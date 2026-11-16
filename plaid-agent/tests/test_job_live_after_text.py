"""RP2-2 on a real core (RPF3-B): a job set up to fill only the words it adds
inserts a word and stages its analysis in the same piece. Staging refuses
the analysis (the plan retypes its sentence) and says the true next step.
The retyped sentence is then taken once more, as the edit left it, by a
piece offered no text tool: it analyses the added word. Never a loop.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import time

from fixtures import MGLOSS, MORPH_LAYER
from job_fixtures import Model, call, plan_row, reply, text_edits, use
from live import core_url
from test_retype_word_refs_live import WORKER, _admin, _seeded

import pytest

from plaid_agent.core.agent import ModelConfig
from plaid_agent.core.job import Job, run_job
from plaid_agent.core.prompt import JOB_TEXT_THEN_FILL
from plaid_agent.igt.job import AFTER_TEXT_LINE, IgtRunner
from plaid_agent.jobworker import count_chars


@pytest.fixture(autouse=True)
def _text_edits(monkeypatch):
    text_edits(monkeypatch)


def _morphemes(admin, s):
    """``[(word, [(morpheme form, gloss)])]`` of the document, in text order."""
    raw = admin.documents.get(s.ids['dA'], include_body=True)
    tl = raw['text_layers'][0]
    body = tl['text']['body']
    from fixtures import WORD_LAYER
    layers = {tk['id']: tk for tk in tl['token_layers']}
    glosses = {t: sp['value'] for sl in layers[s.ids[MORPH_LAYER]].get('span_layers') or []
               if sl['id'] == s.ids[MGLOSS] for sp in sl.get('spans') or [] for t in sp['tokens']}
    morphs = layers[s.ids[MORPH_LAYER]].get('tokens') or []
    out = []
    for w in sorted(layers[s.ids[WORD_LAYER]]['tokens'], key=lambda t: t['begin']):
        mine = sorted((m for m in morphs if w['begin'] <= m['begin'] and m['end'] <= w['end']),
                      key=lambda m: (m['begin'], m.get('precedence') or 0))
        out.append((body[w['begin']:w['end']], [((m.get('metadata') or {}).get('form'), glosses.get(m['id']))
                                                 for m in mine]))
    return out


def test_rp2_2_a_word_the_job_adds_is_analysed_by_the_same_job(monkeypatch):
    from plaid_client import PlaidClient
    admin = _admin()
    _email, writer, s = _seeded(admin, 'after-text', [{'words': ['sa', 'jut']}, {'words': ['ka', 'mi']}])
    refusals, asked, offered = [], [], []
    try:
        def answer(text, n, kwargs):
            if 'Instructions from' not in text:
                return reply('Done.')
            if n == 1:
                asked.append(text)
            if AFTER_TEXT_LINE in text:
                offered.append({t['function']['name'] for t in kwargs.get('tools') or []})
                if n == 1:
                    return reply(calls=[call(5, 'set_analysis', {'document': 'Alpha', 'ref': 's1.w2 "xosan"',
                                                                 'morphemes': [{'form': 'xosan',
                                                                                'fields': {'Morph Gloss': 'good'}}]})])
                return reply('Analysed xosan.')
            if n == 1:
                return reply(calls=[
                    call(1, 'retype_sentence', {'document': 'Alpha', 'ref': 's1', 'text': 'sa xosan jut.'}),
                    call(2, 'set_analysis', {'document': 'Alpha', 'ref': 's1.w2 "xosan"', 'morphemes': [
                        {'form': 'xosan', 'fields': {'Morph Gloss': 'good'}}]})])
            if n == 2:
                refusals.extend(m['content'] for m in kwargs['messages'] if m['role'] == 'tool')
            return reply('Inserted xosan.')
        use(monkeypatch, Model(answer))
        made = writer.jobs.create(s.project_id, 'igt', 'Insert xosan between sa and jut in s1, and segment and '
                                  'gloss it.',
                                  setup={'fills': [{'id': 'segmentation', 'name': 'segmentation'},
                                                   {'id': s.ids[MGLOSS], 'name': 'Morph Gloss'}], 'text': True,
                                         'onlynew': True})
        claimed = admin.jobs.claim(WORKER, 'fake/m', ['igt'])
        assert claimed and claimed['job']['id'] == made['id']
        admin.jobs.add_decisions(made['id'], WORKER, [plan_row('document', fills=('segmentation', MGLOSS),
                                                               ids=s.ids)])
        offset = {'s': 3600.0}

        def wait(sec):
            offset['s'] += sec
        job = Job(admin, claimed, WORKER, client_for=lambda token: PlaidClient(core_url(), token), model='fake/m',
                  sleep=wait, now=lambda: time.time() + offset['s'])
        finished = run_job(job, IgtRunner(job, ModelConfig(model='fake/m', stream=False, max_steps=1000),
                                          count=count_chars, write_summary=False))
        assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
        assert any(JOB_TEXT_THEN_FILL in r for r in refusals), refusals
        assert len(asked) == 2 and AFTER_TEXT_LINE in asked[1], 'the piece, then once the sentence after the edit'
        assert offered and 'retype_sentence' not in offered[0], 'no text tool after the text edit'
        words = _morphemes(admin, s)
        assert words[:3] == [('sa', []), ('xosan', [('xosan', 'good')]), ('jut', [])], words
        doc = finished['report']['documents'][0]
        assert not doc.get('refused'), doc.get('refused')
        rows = [p['piece'] for p in admin.jobs.pieces(made['id']) if p['piece'].get('document')]
        assert [r.get('after_text') for r in rows] == ['added', None], rows  # newest first
    finally:
        s.delete()
