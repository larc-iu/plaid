"""RW round 4 (REV-RW-R3-1): under a plan that fills nothing the walk never
works a document in stretches, whatever fallback row it carries but
too-long: a document put off for a person, or one a worker that died while
ending a failed selection's documents left live, is ended, and the top line
counts it. Reads are scripted with calls that need no core."""

import pytest

from job_fixtures import JobClient, Model, blank, call, document, reply, runner, start, targets_named, use

from plaid_agent.core.job import run_job
from plaid_agent.igt import job as igt_job

J = 'JFE'
WHOLE = 'Your piece: the whole document'
SELECTION = 'Your piece: the whole selection'


def _stretches(model):
    return [c for c in model.calls if c['n'] == 1 and WHOLE not in c['asked'] and SELECTION not in c['asked']]


def test_a_failed_check_selection_whose_worker_died_ending_its_documents_walks_nothing_on_resume(monkeypatch):
    """The reviewer's P12."""
    client = JobClient({'d1': document('d1', 'Story', blank(3)), 'd2': document('d2', 'Tale', blank(3))})
    job = start(client, 'Check every gloss.', id=J, plan='selection', fills=())

    def answer(asked, n, kwargs):
        if SELECTION in asked:
            return reply(calls=[call(100 + n, 'no_such_tool', {'n': n})])
        return reply('Found nothing odd.')
    model = use(monkeypatch, Model(answer))
    real, seen = igt_job.IgtRunner.end_unworked, {'n': 0}

    def dying(self, project, d, how):
        seen['n'] += 1
        if seen['n'] == 2:
            raise KeyboardInterrupt('the worker dies')
        return real(self, project, d, how)
    monkeypatch.setattr(igt_job.IgtRunner, 'end_unworked', dying)
    with pytest.raises(KeyboardInterrupt):
        run_job(job, runner(job))
    finished = run_job(job, runner(job))
    assert not _stretches(model)
    assert all(d['state'] == 'done' for d in finished['report']['documents'])
    assert '2 documents were not worked: the job\'s step over them failed.' in finished['report']['notice']


def test_a_check_by_documents_whose_write_is_put_off_is_ended_not_walked(monkeypatch):
    """The reviewer's P13: the whole piece stages s1 and its write is put off
    for a person once. After the wait the document is ended, said, and never
    walked in stretches (one note, not three)."""
    client = JobClient({'d1': document('d1', 'Story', blank(7))})
    job = start(client, 'Check every gloss.', id=J, plan='document', fills=())

    def answer(asked, n, kwargs):
        if n == 1:
            return reply(calls=[call(10, 'set_analysis', {'document': 'Story', 'ref': 's1.w1', 'morphemes': [
                {'form': 'ka1', 'type': 'stem', 'fields': {'Morph Gloss': 'go'}}]})])
        return reply('Checked: one odd gloss.')
    model = use(monkeypatch, Model(answer))
    real, seen = igt_job.IgtRunner.write, {'n': 0}

    def put_off(self, project, document_id, *a, **k):
        seen['n'] += 1
        if seen['n'] == 1:
            raise igt_job.Deferred(document_id)
        return real(self, project, document_id, *a, **k)
    monkeypatch.setattr(igt_job.IgtRunner, 'write', put_off)
    finished = run_job(job, runner(job))
    assert not _stretches(model)
    (doc,) = finished['report']['documents']
    assert doc['state'] == 'done'
    assert ('1 document was not changed: someone was editing it when the job\'s changes there were to be written.'
            in finished['report']['notice']), finished['report']['notice']
    assert len(finished['report']['notes']) <= 1
