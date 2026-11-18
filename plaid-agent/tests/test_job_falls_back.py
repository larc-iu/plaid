"""BRIEF RW B1: a job always ends, and no piece is asked more than a small
fixed number of times. A whole-document or selection piece that fails is
never asked again as a whole: its documents are worked in stretches of
sentences, the ordinary walk, which halves a failed stretch and skips a
failed sentence. The trace this comes from: one whole-document piece of a
19-sentence document asked eighteen times in four hours, writing nothing."""

import pytest

from job_fixtures import JobClient, Model, blank, call, document, reply, runner, start, targets_named, use

from plaid_agent.core.job import run_job
from plaid_agent.core.limits import JOB_STRETCH_MAX_ROUNDS
from plaid_agent.igt import job as igt_job

J = 'JFB'
WHOLE = 'Your piece: the whole document'
SELECTION = 'Your piece: the whole selection'


def _stage(asked):
    name = asked.split('"')[1]
    return reply(calls=[call(10 * n, 'set_analysis', {'document': name, 'ref': f's{n}.w1', 'morphemes': [
        {'form': f'ka{n}', 'type': 'stem', 'fields': {'Morph Gloss': 'go'}}]}) for n in targets_named(asked)])


def _reads(n):
    """A call that reads, and stages nothing."""
    return reply(calls=[call(100 + n, 'analyses_of', {'form': f'x{n}'})])


def _model(big_fails=True, small_fails=False):
    """A piece of the whole document or of the selection reads until its
    budget ends it, staging nothing (``big_fails``). A stretch stages its
    sentences and ends, or reads for ever too (``small_fails``)."""
    def answer(asked, n, kwargs):
        big = WHOLE in asked or SELECTION in asked
        if (big and big_fails) or (not big and small_fails):
            return _reads(n)
        return _stage(asked) if n == 1 else reply('Done.')
    return Model(answer)


def _firsts(model, words):
    return [c for c in model.calls if c['n'] == 1 and words in c['asked']]


@pytest.mark.parametrize('plan', ['document', 'selection'])
def test_a_big_piece_that_fails_is_asked_once_and_its_document_written_in_stretches(monkeypatch, plan):
    client = JobClient({'d1': document('d1', 'Story', blank(7))})
    job = start(client, id=J, plan=plan)
    model = use(monkeypatch, _model())
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    asked_whole = _firsts(model, WHOLE) + _firsts(model, SELECTION)
    assert len(asked_whole) == 1, 'the failed piece is never asked again as a whole'
    stretches = [targets_named(c['asked']) for c in model.calls if c['n'] == 1
                 and WHOLE not in c['asked'] and SELECTION not in c['asked']]
    assert stretches == [[1, 2, 3, 4, 5], [6, 7]]
    (doc,) = finished['report']['documents']
    assert doc['state'] == 'done' and doc['skipped'] == [] and doc['counts']['words'] == 7
    assert finished['report']['plan']['fallback'] == [
        {'document_id': 'd1' if plan == 'document' else None, 'reason': 'failed'}]


def test_a_selection_that_fails_works_each_of_its_documents_in_stretches(monkeypatch):
    client = JobClient({'d1': document('d1', 'Story', blank(3)), 'd2': document('d2', 'Tale', blank(2))})
    job = start(client, id=J, plan='selection')
    model = use(monkeypatch, _model())
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert len(_firsts(model, SELECTION)) == 1 and not _firsts(model, WHOLE)
    assert [d['counts']['words'] for d in finished['report']['documents']] == [3, 2]


def test_a_stretch_after_the_fallback_that_fails_is_halved_and_skipped_and_the_job_ends(monkeypatch):
    """Every piece fails, the stretches too: each sentence is skipped as
    failed and counted, and the calls stay within the bound the report
    states: the whole document once, then each stretch halved to its
    sentences (2n - 1 asks for n sentences), each at most the budget's calls."""
    client = JobClient({'d1': document('d1', 'Story', blank(7))})
    job = start(client, id=J, plan='document')
    model = use(monkeypatch, _model(small_fails=True))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    (doc,) = finished['report']['documents']
    assert [s['sentence'] for s in doc['skipped']] == [f's{n}' for n in range(1, 8)]
    assert {(s['reason'], s['kind']) for s in doc['skipped']} == {('failed', 'budget')}
    assert finished['report']['totals']['skipped_failed'] == 7
    assert len(_firsts(model, WHOLE)) == 1
    asks = [c for c in model.calls if c['n'] == 1]
    # 1 whole, then 9 asks for the stretch of 5 and 3 for the stretch of 2.
    assert len(asks) == 1 + 9 + 3
    assert len(model.calls) <= len(asks) * JOB_STRETCH_MAX_ROUNDS


def test_a_whole_document_failed_once_is_not_asked_as_a_whole_after_a_resume(monkeypatch):
    """The fallback is kept in core: a worker taken up again works the
    document in stretches from the start, never as a whole."""
    client = JobClient({'d1': document('d1', 'Story', blank(3))})
    job = start(client, id=J, plan='document')
    runner(job).fall_back('d1', 'failed')
    model = use(monkeypatch, _model())
    run_job(job, runner(job))
    assert not _firsts(model, WHOLE)


def test_a_stretch_plan_with_every_stretch_failing_ends(monkeypatch):
    """A plan in stretches whose every piece fails: halved, every sentence
    skipped and counted, the job done (unchanged, a guard)."""
    client = JobClient({'d1': document('d1', 'Story', blank(6))})
    job = start(client, id=J, plan='sentences')
    use(monkeypatch, _model(small_fails=True))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert finished['report']['totals']['skipped_failed'] == 6
