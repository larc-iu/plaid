"""A job edits the text only when its plan says so (FX, the owner's ruling of
2026-11-15), under a real core: a piece that calls retype_sentence anyway
in a job whose plan does not set edits_text is refused and the text stays,
and the same piece in a job whose plan sets it retypes the sentence.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import time

import pytest

from job_fixtures import Model, call, plan_row, reply, use
from live import core_url
from test_job_live_delete_sentence import WORKER, _admin, _read, _runner, _seeded

from plaid_agent.core.job import Job, run_job

REFUSED = "that tool is not one of this job's"


def _job(admin, writer, s, edits_text):
    from plaid_client import PlaidClient
    made = writer.jobs.create(s.project_id, 'igt', 'Gloss the words.')
    claimed = admin.jobs.claim(WORKER, 'fake/m', ['igt'])
    assert claimed and claimed['job']['id'] == made['id']
    admin.jobs.add_decisions(made['id'], WORKER, [plan_row('document', edits_text=edits_text)])
    offset = {'s': 3600.0}

    def wait(sec):
        offset['s'] += sec
    return Job(admin, claimed, WORKER, client_for=lambda token: PlaidClient(core_url(), token), model='fake/m',
               sleep=wait, now=lambda: time.time() + offset['s'])


@pytest.mark.parametrize('edits_text', [False, True], ids=['plan-leaves-the-text', 'plan-edits-the-text'])
def test_a_piece_retypes_only_when_the_plan_edits_the_text(monkeypatch, edits_text):
    admin = _admin()
    writer, s = _seeded(admin, 'job-text-edits', [{'words': ['ka', 'ta']}, {'words': ['sa', 'ta']}])
    try:
        answers = []

        def answer(asked, n, kwargs):
            if 'Your piece: the whole document' not in asked:
                return reply('Done.')
            if n == 1:
                return reply(calls=[call(1, 'retype_sentence', {'document': 'Alpha', 'ref': 's1', 'text': 'ka tax.'})])
            answers.extend(m['content'] for m in kwargs['messages'] if m['role'] == 'tool')
            return reply('Done.')
        model = use(monkeypatch, Model(answer))
        before, _sents, _words = _read(admin, s)
        job = _job(admin, writer, s, edits_text)
        finished = run_job(job, _runner(job))
        assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
        offered = {t['function']['name'] for c in model.calls if 'Your piece' in c['asked']
                   for t in c['kwargs']['tools']}
        body, _sents, _words = _read(admin, s)
        if edits_text:
            assert 'retype_sentence' in offered
            assert body == 'ka tax. sa ta.', body
        else:
            assert 'retype_sentence' not in offered
            assert answers and REFUSED in answers[0], answers
            assert body == before == 'ka ta. sa ta.', body
    finally:
        s.delete()
