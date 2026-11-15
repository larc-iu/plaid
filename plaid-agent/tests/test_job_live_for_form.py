"""set_analysis_for_form in a job (REV-DAY-S-2), on a real core: it stages a
change at each occurrence, so in a piece's own document they are applied,
and elsewhere they are listed as proposed. The job's prompt says so, and the
report counts each write once: a proposed change its document holds by the
time the report is written (a later piece of the job wrote it) is not listed
as proposed.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import time

from fixtures import MORPH_LAYER
from job_fixtures import Model, call, document, plan_row, reply, use
from test_job_live_entries import WORKER, _runner, world  # noqa: F401 - the fixture

from plaid_agent.core.job import Job, run_job


def _bulk(k, document=None):
    args = {'form': 'ka', 'morphemes': [{'form': 'ka', 'fields': {'Morph Gloss': 'fish'}}]}
    if document:
        args['document'] = document
    return call(k, 'set_analysis_for_form', args)


def _glossed(admin, s, d):
    raw = admin.documents.get(s.ids[d], include_body=True)
    layers = {tk['id']: tk for tl in raw['text_layers'] for tk in tl['token_layers']}
    return sum(1 for t in layers[s.ids[MORPH_LAYER]].get('tokens') or [] if (t.get('metadata') or {}).get('prov'))


def _job(admin, writer, s, documents):
    from plaid_client import PlaidClient
    from live import core_url
    made = writer.jobs.create(s.project_id, 'igt', 'Gloss ka as fish everywhere.', [s.ids[d] for d in documents])
    claimed = admin.jobs.claim(WORKER, 'fake/m', ['igt'])
    assert claimed and claimed['job']['id'] == made['id']
    admin.jobs.add_decisions(made['id'], WORKER, [plan_row('document')])
    offset = {'s': 0.0}

    def wait(sec):
        offset['s'] += sec
    return Job(admin, claimed, WORKER, client_for=lambda token: PlaidClient(core_url(), token), model='fake/m',
               sleep=wait, now=lambda: time.time() + offset['s'])


def test_its_own_documents_occurrences_are_applied_and_no_write_is_also_proposed(world, monkeypatch):
    """A plan in documents over Alpha and Beta. Alpha's piece glosses ka
    everywhere: Alpha's ka is written, Beta's and Gamma's are proposed.
    Beta's piece does the same in Beta, which writes it. Gamma is not the
    job's, and its ka stays proposed. So the report proposes Gamma's alone."""
    admin, writer, make = world
    s = make({'dA': document('dA', 'Alpha', [{'words': ['ka', 'mi']}]),
              'dB': document('dB', 'Beta', [{'words': ['pa', 'ka']}]),
              'dC': document('dC', 'Gamma', [{'words': ['ka', 'sa']}])})

    def answer(asked, n, kwargs):
        if n > 1:
            return reply('Glossed ka.')
        if 'the whole document "Alpha"' in asked:
            return reply(calls=[_bulk(1)])
        if 'the whole document "Beta"' in asked:
            return reply(calls=[_bulk(1, 'Beta')])
        return reply('Done.')
    use(monkeypatch, Model(answer))
    job = _job(admin, writer, s, ['dA', 'dB'])
    finished = run_job(job, _runner(job))
    assert finished['state'] == 'done', finished.get('reason')
    assert _glossed(admin, s, 'dA') == 1 and _glossed(admin, s, 'dB') == 1 and _glossed(admin, s, 'dC') == 0
    proposed = finished['report']['proposed']
    assert {c['document'] for c in proposed} == {'Gamma'}, proposed
