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
        {'form': f'ka{n}', 'type': 'stem', 'fields': {'Morph Gloss': 'go'}}]})
        for n in ([k for k in range(1, 50) if f'[s{k}]' in asked] if WHOLE in asked else targets_named(asked))])


def _reads(n):
    """A call that stages nothing and needs no core: a tool no piece has,
    with arguments of its own each time (never the repeat stop)."""
    return reply(calls=[call(100 + n, 'no_such_tool', {'n': n})])


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


def test_a_stretch_plan_with_every_stretch_failing_ends(monkeypatch):
    """A plan in stretches whose every piece fails: halved, every sentence
    skipped and counted, the job done (unchanged, a guard)."""
    client = JobClient({'d1': document('d1', 'Story', blank(6))})
    job = start(client, id=J, plan='sentences')
    use(monkeypatch, _model(small_fails=True))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert finished['report']['totals']['skipped_failed'] == 6


@pytest.mark.parametrize('pieces', ['document', 'selection'])
def test_what_a_whole_piece_that_ran_leaves_is_worked_in_stretches_never_whole_again(monkeypatch, pieces):
    """The coordinator's case (PLANEXP: Natugu texts 2 and 4 under a plan by
    documents, the whole document taken 3 times): what remains after a whole
    piece that ran, here s1, which a person edited while the model worked,
    is taken again as a stretch, and the plan line counts the document."""
    from test_job_gate import BLANK, _gloss, _job, _staged
    client, job, clock, _ = _job(monkeypatch, pieces, after=BLANK)
    edited = [{'words': ['ka', 'ta'], 'translation': ('One, edited.', 'human')},
              {'words': ['sa'], 'translation': ('Two.', 'human')}]
    once = {'n': 0}
    gloss = _gloss()

    def answer(asked, n, kwargs):
        if n > 1 and not once['n'] and (WHOLE in asked or SELECTION in asked):
            once['n'] = 1
            client._holder('d1')['documents']['d1'] = document('d1', 'Story', edited, version=5)
            client.after_write['d1'] = document('d1', 'Story', edited, version=5)
        return gloss(asked, n, kwargs)
    model = use(monkeypatch, Model(answer))
    staged = _staged(monkeypatch)
    r = runner(job)
    r.work(job)
    written = [o.get('word_id') for o in staged if o.get('kind') == 'set_analysis']
    assert 'd1-s1w1' in written, 's1 is taken again'
    firsts = [c['asked'] for c in model.calls if c['n'] == 1]
    assert sum(1 for a in firsts if WHOLE in a or SELECTION in a) == 1, 'one whole piece'
    assert firsts[-1].splitlines()[-1].startswith('Your piece: s1.'), firsts[-1].splitlines()[-1]
    assert r.fallen_back() == {'d1': 'again'}


def _summaries(client):
    import json
    from plaid_agent.igt.job import PIECE_FORM
    return [json.loads(r['analysis']) for (f, _k), r in client.jobs.decision_rows.get(J, {}).items()
            if f == PIECE_FORM]


@pytest.mark.parametrize('plan', ['document', 'selection'])
def test_a_failed_big_piece_has_a_row_saying_it_failed(monkeypatch, plan):
    """B5: the work list shows the failed whole piece, with its failure's
    kind, before the stretches that follow it."""
    client = JobClient({'d1': document('d1', 'Story', blank(3))})
    job = start(client, id=J, plan=plan)
    use(monkeypatch, _model())
    run_job(job, runner(job))
    rows = _summaries(client)
    assert rows[0]['whole'] is True and rows[0]['failed'] == 'budget', rows[0]
    assert rows[0]['document'] == ('d1' if plan == 'document' else None)
    assert not any(r.get('failed') for r in rows[1:])
    assert 'Nothing' not in str(rows[0].get('note'))


@pytest.mark.parametrize('how', ['put-off', 'core'])
def test_a_whole_piece_whose_write_is_put_off_or_hit_by_core_is_not_asked_whole_again(monkeypatch, how):
    """REV-RW-3: the whole piece ran, and its write was put off (a person in
    the document) or failed on a passing core error: what remains is taken
    in stretches, never as the whole document again."""
    from plaid_client import PlaidAPIError
    client = JobClient({'d1': document('d1', 'Story', blank(3))})
    job = start(client, id=J, plan='document')
    real, once = igt_job.IgtRunner.write, {'n': 0}

    def write(self, *a, **kw):
        if not once['n']:
            once['n'] = 1
            if how == 'put-off':
                raise igt_job.Deferred('d1')
            raise PlaidAPIError('HTTP 502', status=502, method='POST')
        return real(self, *a, **kw)
    monkeypatch.setattr(igt_job.IgtRunner, 'write', write)
    model = use(monkeypatch, _model(big_fails=False))
    finished = run_job(job, runner(job))
    assert len(_firsts(model, WHOLE)) == 1, [c['asked'].splitlines()[-1] for c in model.calls if c['n'] == 1]
    (doc,) = finished['report']['documents']
    assert doc['counts']['words'] == 3, doc


def test_a_whole_piece_put_off_is_not_asked_whole_by_a_worker_taken_up_again(monkeypatch):
    """REV-RW-4: the one fact the retake rule needs is kept in core as the
    fallback row the job already writes (``in-use``, a put-off's reason, REV-RW-R3-1), written when the whole
    piece's write is put off: a worker that restarts during the wait works
    the document in stretches."""
    client = JobClient({'d1': document('d1', 'Story', blank(3))})
    job = start(client, id=J, plan='document')
    real = igt_job.IgtRunner.write

    def put_off(self, *a, **kw):
        raise igt_job.Deferred('d1')
    monkeypatch.setattr(igt_job.IgtRunner, 'write', put_off)
    use(monkeypatch, _model(big_fails=False))
    first = runner(job)
    first.plan(job)
    assert first.document('d1') == 'deferred'
    assert first.fallen_back() == {'d1': 'in-use'}
    monkeypatch.setattr(igt_job.IgtRunner, 'write', real)
    model = use(monkeypatch, _model(big_fails=False))
    fresh = runner(job)
    fresh.plan(job)
    assert fresh.fallen_back() == {'d1': 'in-use'}
    fresh.document('d1')
    assert not _firsts(model, WHOLE), 'a restarted worker never asks it whole'
