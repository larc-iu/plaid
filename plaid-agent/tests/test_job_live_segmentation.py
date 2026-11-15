"""A job that only segments, run twice on a real core (REV-DF3-4): the first
segments every word, a word of one morpheme as that one morpheme with its
form and no value. The second finds nothing empty for segmentation, asks no
piece and writes nothing.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import time

from job_fixtures import Model, call, plan_row, reply, use
from live import core_url
from test_job_live_delete_sentence import WORKER, _admin, _runner, _seeded

from plaid_client import PlaidClient
from plaid_agent.core.job import Job, run_job
from plaid_agent.igt import job as igt_job

SENTENCES = [{'words': ['ka', 'tuna']}, {'words': ['pele']}]
SEGMENTS = {'ka': ['ka'], 'tuna': ['tu', 'na'], 'pele': ['pele']}


def _job(admin, writer, s):
    made = writer.jobs.create(s.project_id, 'igt', 'Segment every word nobody has segmented.')
    claimed = admin.jobs.claim(WORKER, 'fake/m', ['igt'])
    assert claimed and claimed['job']['id'] == made['id']
    admin.jobs.add_decisions(made['id'], WORKER, [plan_row('sentences', ids=s.ids, fills=('segmentation',),
                                                           only_empty=True)])
    offset = {'s': 3600.0}

    def wait(sec):
        offset['s'] += sec
    return Job(admin, claimed, WORKER, client_for=lambda token: PlaidClient(core_url(), token), model='fake/m',
               sleep=wait, now=lambda: time.time() + offset['s'])


def _segment(asked, n, kwargs):
    if 'Your piece:' not in asked or n > 1:
        return reply('Segmented the piece.')
    calls = []
    for line in asked.splitlines():
        if not line.startswith('Empty in s'):
            continue
        sentence = line.split()[2].rstrip(':')
        named = line.split(': ', 1)[1].split(' in ', 1)[1].rstrip('.')
        for ref, form in [(p.split()[0], p.split('"')[1]) for p in named.split(', ')]:
            calls.append(call(len(calls) + 1, 'set_analysis', {
                'document': 'Alpha', 'ref': f'{sentence}.{ref}',
                'morphemes': [{'form': f} for f in SEGMENTS[form]]}))
    return reply(calls=calls)


def test_a_segmentation_job_run_again_finds_nothing_to_do(monkeypatch):
    admin = _admin()
    writer, s = _seeded(admin, 'job-segment-twice', SENTENCES)
    try:
        model = use(monkeypatch, Model(_segment))
        real, sent = igt_job.execute_plan, []

        def execute(c, ops, **kw):
            sent.append(len(ops))
            return real(c, ops, **kw)
        monkeypatch.setattr(igt_job, 'execute_plan', execute)
        job = _job(admin, writer, s)
        first = run_job(job, _runner(job))
        assert first['state'] == 'done', (first.get('reason'), job.status.get('message'))
        assert first['report']['totals']['words'] == 3, first['report']['totals']
        (doc,) = first['report']['documents']
        assert doc['counts']['blank'][0]['left'] == 0, doc['counts']['blank']
        asked_first = len(model.calls)
        assert asked_first and sent, 'the first job segmented'
        sent.clear()
        job = _job(admin, writer, s)
        again = run_job(job, _runner(job))
        assert again['state'] == 'done', (again.get('reason'), job.status.get('message'))
        assert [c for c in model.calls[asked_first:] if 'Your piece:' in c['asked']] == [], 'no piece asked'
        assert sent == [] and again['report']['totals']['changes'] == 0
        (doc,) = again['report']['documents']
        assert doc['counts']['blank'][0]['left'] == 0, doc['counts']['blank']
    finally:
        s.delete()
