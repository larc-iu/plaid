"""A resumed worker never asks the whole selection again over a document the
selection already put off to stretches (D18 of the job review 2026-11-18):
the selection's piece runs over the documents with no fallback row, and a
document with one is worked in stretches by the walk, as the first worker
would have."""

from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from fixtures import MGLOSS
from plaid_agent.core.job import run_job

J = 'JSR'


def test_a_resumed_selection_leaves_out_a_document_it_put_off(monkeypatch):
    client = JobClient({'d1': document('d1', 'Story 1', [{'words': ['ka']}]),
                        'd2': document('d2', 'Story 2', [{'words': ['mo']}])})
    job = start(client, 'Gloss the words.', id=J, plan='selection', fills=(MGLOSS,))
    # The first worker's selection ended d1 and put d2 off, then stopped.
    first = runner(job)
    first.plan(job)
    first.fall_back('d2', 'in-use')
    job.update_row('d1', state='done')
    job.update_row('d2', state='deferred')
    job.status['phase'] = 'working'

    def answer(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        if 'Your piece: the whole selection above.' in asked:
            return reply(calls=[call(1, 'set_field', {'document': 'Story 2', 'refs': ['s1.w1.m1'],
                                                      'field': 'Morph Gloss', 'value': 'whole'})])
        return reply(calls=[call(1, 'set_field', {'document': 'Story 2', 'refs': ['s1.w1.m1'],
                                                  'field': 'Morph Gloss', 'value': 'stretch'})])
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', finished.get('reason')
    asked = [c['asked'] for c in model.calls if c['n'] == 1]
    assert not any('Your piece: the whole selection above.' in a for a in asked), 'no second selection'
    assert asked, 'd2 worked in stretches'
