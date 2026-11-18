"""REV-RW-6: one rule for a piece that ends without finishing, whatever ended
it. A second call at the output limit with work staged writes what was
staged, exactly as a piece whose steps are used up: in a stretch each sentence
with nothing staged is skipped failed (kind output) and counted, in a whole
document what remains goes to stretches. This replaces "the second hit fails
the stretch with nothing written" (fixes/SP.md): REV-SP-10's cursor loss is
answered by the skip of every unstaged sentence before the write. And a
whole-document piece that answers nothing goes to stretches as a failed one
does, and a selection that answers nothing has its failed row."""

import json

import pytest

from job_fixtures import JobClient, Model, blank, call, document, reply, runner, start, targets_named, use

from plaid_agent.core.job import run_job
from plaid_agent.core.prompt import JOB_ANSWER_AGAIN
from plaid_agent.igt import job as igt_job

J = 'JCT'
WHOLE = 'Your piece: the whole document'
SELECTION = 'Your piece: the whole selection'


def _stage(name, ns):
    return [call(10 * n, 'set_analysis', {'document': name, 'ref': f's{n}.w1', 'morphemes': [
        {'form': f'ka{n}', 'type': 'stem', 'fields': {'Morph Gloss': 'go'}}]}) for n in ns]


def _model(first):
    """The first piece stages ``first`` at its first call, then every call of
    it is cut at the output limit. Every later piece stages its sentences."""
    seen = {'first': None}

    def answer(asked, n, kwargs):
        if seen['first'] is None:
            seen['first'] = asked
        if asked == seen['first']:
            if n == 1 and not any(m.get('role') == 'tool' for m in kwargs['messages']):
                return reply(calls=_stage(asked.split('"')[1], first))
            return reply('...', finish='length')
        return reply(calls=_stage(asked.split('"')[1], targets_named(asked))) if n == 1 else reply('Done.')
    return Model(answer)


def _stretches(model):
    return [targets_named(c['asked']) for c in model.calls
            if c['n'] == 1 and WHOLE not in c['asked'] and SELECTION not in c['asked']]


def _summaries(client):
    from plaid_agent.igt.job import PIECE_FORM
    return [json.loads(r['analysis']) for (f, _k), r in client.jobs.decision_rows.get(J, {}).items()
            if f == PIECE_FORM]


def test_a_stretch_cut_twice_writes_what_it_staged_and_skips_the_rest_counted(monkeypatch):
    client = JobClient({'d1': document('d1', 'Story', blank(5))})
    job = start(client, id=J, plan='sentences')
    model = use(monkeypatch, _model([2, 4]))
    finished = run_job(job, runner(job))
    assert _stretches(model) == [[1, 2, 3, 4, 5]], 'asked once'
    (doc,) = finished['report']['documents']
    assert doc['counts']['words'] == 2
    assert [(s['sentence'], s['reason'], s['kind']) for s in doc['skipped']] == [
        ('s1', 'failed', 'output'), ('s3', 'failed', 'output'), ('s5', 'failed', 'output')]
    r = runner(job)
    project = r.project()
    assert r.pending(r.read(project, 'd1'), project, 'd1', every=r.every_sentence()) == []


class _Crash(BaseException):
    """The worker's process dies here."""


def test_a_stretch_cut_twice_passes_no_sentence_uncounted_when_the_worker_dies_at_its_write(monkeypatch):
    """REV-SP-10's guard, now for the write of what was staged: stretch s1,
    s2, the piece stages s2 only and is cut twice, and the process dies as
    the write is sent. On resume s1 is counted skipped and s2 is worked: none
    lost, none counted twice."""
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 2)
    client = JobClient({'d1': document('d1', 'Story', blank(2))})
    job = start(client, id=J, plan='sentences')
    real, hit = igt_job.IgtRunner.write, {'n': 0}

    def write(self, *a, **kw):
        if not hit['n']:
            hit['n'] = 1
            raise _Crash()
        return real(self, *a, **kw)
    monkeypatch.setattr(igt_job.IgtRunner, 'write', write)
    use(monkeypatch, _model([2]))
    with pytest.raises(_Crash):
        runner(job).document('d1')
    model = use(monkeypatch, Model(lambda asked, n, kwargs: reply(calls=_stage('Story', targets_named(asked)))
                                    if n == 1 else reply('Done.')))
    assert runner(job).document('d1') == 'done'
    assert _stretches(model) == [[2]]
    row = job.rows['d1']
    assert [s['sentence'] for s in row['skipped']] == ['s1'] and row['done'] == 2


def test_a_whole_document_cut_twice_writes_what_it_staged_and_the_rest_goes_to_stretches(monkeypatch):
    """The trace's piece-0012: 19 sentences, s1 and s2 staged, then cut."""
    client = JobClient({'d1': document('d1', 'Story', blank(19))})
    job = start(client, id=J, plan='document')
    model = use(monkeypatch, _model([1, 2]))
    finished = run_job(job, runner(job))
    assert _stretches(model) == [[3, 4, 5, 6, 7], [8, 9, 10, 11, 12], [13, 14, 15, 16, 17], [18, 19]]
    (doc,) = finished['report']['documents']
    assert doc['counts']['words'] == 19 and doc['skipped'] == []
    assert finished['report']['plan']['fallback'] == [{'document_id': 'd1', 'reason': 'ran-out'}]
    assert [r.get('ended') for r in _summaries(client)][0] == 'output'


def test_a_whole_document_that_answers_nothing_goes_to_stretches(monkeypatch):
    """The reviewer's P5: every sentence was skipped no-answer on one empty
    answer, asked twice."""
    client = JobClient({'d1': document('d1', 'Story', blank(7))})
    job = start(client, id=J, plan='document')
    model = use(monkeypatch, Model(lambda asked, n, kwargs: reply('') if WHOLE in asked else (
        reply(calls=_stage('Story', targets_named(asked))) if n == 1 else reply('Done.'))))
    finished = run_job(job, runner(job))
    assert _stretches(model) == [[1, 2, 3, 4, 5], [6, 7]]
    (doc,) = finished['report']['documents']
    assert doc['counts']['words'] == 7 and doc['skipped'] == []
    assert finished['report']['plan']['fallback'] == [{'document_id': 'd1', 'reason': 'failed'}]
    rows = _summaries(client)
    assert rows[0]['whole'] is True and rows[0]['failed'] == 'no-answer', rows[0]


def test_a_selection_that_answers_nothing_has_its_failed_row(monkeypatch):
    client = JobClient({'d1': document('d1', 'Story', blank(2))})
    job = start(client, id=J, plan='selection')
    use(monkeypatch, Model(lambda asked, n, kwargs: reply('') if SELECTION in asked else (
        reply(calls=_stage('Story', targets_named(asked))) if n == 1 else reply('Done.'))))
    run_job(job, runner(job))
    rows = _summaries(client)
    assert rows[0]['document'] is None and rows[0]['failed'] == 'no-answer', rows[0]
