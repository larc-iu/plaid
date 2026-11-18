"""REV-RW-1: a whole-document or selection piece that ends without finishing
(its steps used up) writes what it staged by the ordinary write, and what it
did not get to is then worked in stretches: in each document, every sentence
it staged nothing in that still holds something the plan fills and is empty
(the one empty rule, igt/targets.py). Never counted as worked. A plan that
fills nothing walks nothing after it, and the report says the rest was not
done. Reads are scripted with calls that need no core."""

import pytest

from job_fixtures import JobClient, Model, blank, call, document, reply, runner, start, targets_named, use

from plaid_agent.core.job import run_job
from plaid_agent.core.prompt import JOB_STEPS_USED_UP

J = 'JEB'
WHOLE = 'Your piece: the whole document'
SELECTION = 'Your piece: the whole selection'


def _closing(kwargs):
    return any(m.get('content') == JOB_STEPS_USED_UP for m in kwargs['messages'])


def _stage(name, ns):
    return [call(10 * n, 'set_analysis', {'document': name, 'ref': f's{n}.w1', 'morphemes': [
        {'form': f'ka{n}', 'type': 'stem', 'fields': {'Morph Gloss': 'go'}}]}) for n in ns]


def _model(big):
    """The big piece stages ``big`` ({name: [sentence numbers]}) at its first
    call and reads until its steps are used up. A stretch stages its
    sentences and ends."""
    def answer(asked, n, kwargs):
        if _closing(kwargs):
            return reply('Ran out.')
        if WHOLE in asked or SELECTION in asked:
            if n == 1:
                # A whole document's piece stages in its own document.
                mine = {asked.split('"')[1]: big.get('*')} if WHOLE in asked and '*' in big else big
                return reply(calls=[c for name, ns in mine.items() for c in _stage(name, ns)])
            return reply(calls=[call(100 + n, 'no_such_tool', {'n': n})])
        return reply(calls=_stage(asked.split('"')[1], targets_named(asked))) if n == 1 else reply('Done.')
    return Model(answer)


def _stretches(model):
    return [(c['asked'].split('"')[1], targets_named(c['asked'])) for c in model.calls
            if c['n'] == 1 and WHOLE not in c['asked'] and SELECTION not in c['asked']]


def test_a_closed_whole_document_writes_what_it_staged_and_the_rest_goes_to_stretches(monkeypatch):
    """The reviewer's P2, the trace's piece-0012: 19 sentences, s1 and s2
    staged, then the steps are used up."""
    client = JobClient({'d1': document('d1', 'Story', blank(19))})
    job = start(client, id=J, plan='document')
    model = use(monkeypatch, _model({'Story': [1, 2]}))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert len([c for c in model.calls if c['n'] == 1 and WHOLE in c['asked']]) == 1
    assert _stretches(model) == [('Story', [3, 4, 5, 6, 7]), ('Story', [8, 9, 10, 11, 12]),
                                 ('Story', [13, 14, 15, 16, 17]), ('Story', [18, 19])]
    (doc,) = finished['report']['documents']
    assert doc['state'] == 'done' and doc['skipped'] == [] and doc['counts']['words'] == 19
    (row,) = [b for b in doc['counts']['blank'] if b['target'] == 'segmentation']
    assert row['untouched'] == 0 and row['not_reached'] == 0, row
    assert finished['report']['plan']['fallback'] == [{'document_id': 'd1', 'reason': 'ran-out'}]


def test_a_closed_whole_document_that_staged_s5_alone_has_s1_to_s4_worked_too(monkeypatch):
    """What it staged is after what it did not: the cursor is put back, so
    s1 to s4 are worked and s5 is never taken again."""
    client = JobClient({'d1': document('d1', 'Story', blank(7))})
    job = start(client, id=J, plan='document')
    model = use(monkeypatch, _model({'Story': [5]}))
    finished = run_job(job, runner(job))
    assert _stretches(model) == [('Story', [1, 2, 3, 4, 6]), ('Story', [7])]
    (doc,) = finished['report']['documents']
    assert doc['counts']['words'] == 7 and doc['skipped'] == []


THREE = {'d1': document('d1', 'Story', blank(3)), 'd2': document('d2', 'Tale', blank(3)),
         'd3': document('d3', 'Myth', blank(3))}


def test_a_closed_selection_writes_what_it_staged_and_each_document_goes_to_stretches(monkeypatch):
    """The reviewer's P3: a selection over 3 documents stages d1 s1 and its
    steps are used up. d1 s1 is written, and what remains of every document
    is worked in stretches."""
    client = JobClient(dict(THREE))
    job = start(client, id=J, plan='selection')
    model = use(monkeypatch, _model({'Story': [1]}))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert len([c for c in model.calls if c['n'] == 1 and SELECTION in c['asked']]) == 1
    assert not [c for c in model.calls if c['n'] == 1 and WHOLE in c['asked']]
    # The job's order is by name.
    assert _stretches(model) == [('Myth', [1, 2, 3]), ('Story', [2, 3]), ('Tale', [1, 2, 3])]
    assert [d['counts']['words'] for d in finished['report']['documents']] == [3, 3, 3]
    assert all(d['skipped'] == [] and not d['counts'].get('one_step') for d in finished['report']['documents'])
    assert sorted((f['document_id'], f['reason']) for f in finished['report']['plan']['fallback']) == [
        ('d1', 'ran-out'), ('d2', 'ran-out'), ('d3', 'ran-out')]


def test_a_closed_selection_that_staged_everything_ends_in_its_one_step(monkeypatch):
    client = JobClient(dict(THREE))
    job = start(client, id=J, plan='selection')
    model = use(monkeypatch, _model({'Story': [1, 2, 3], 'Tale': [1, 2, 3], 'Myth': [1, 2, 3]}))
    finished = run_job(job, runner(job))
    assert _stretches(model) == []
    assert [d['counts']['words'] for d in finished['report']['documents']] == [3, 3, 3]
    assert finished['report']['plan']['fallback'] == []


@pytest.mark.parametrize('plan', ['selection', 'document'])
def test_a_closed_big_piece_of_a_plan_that_fills_nothing_walks_nothing_and_says_the_rest_was_not_done(
        monkeypatch, plan):
    """RPF3's ruling holds: a plan that fills nothing never walks its
    documents after its big piece. The report's top line says that piece
    ended before its work was done, and the documents are counted."""
    client = JobClient(dict(THREE))
    job = start(client, 'Check every gloss.', id=J, plan=plan, fills=())
    model = use(monkeypatch, _model({'Story': [1]} if plan == 'selection' else {'*': [1]}))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert _stretches(model) == []
    n = 3
    assert finished['report']['totals']['documents_ran_out'] == n
    assert (f'{n} documents ended before the job had done its work there: what it had staged was written, and '
            'the rest was not done.') in finished['report']['notice'], finished['report']['notice']


class _Crash(BaseException):
    """The worker's process dies here."""


@pytest.mark.parametrize('at', ['before-write', 'after-write'])
def test_a_worker_that_dies_around_the_closing_write_passes_no_sentence(monkeypatch, at):
    """REV-SP-10's loss, for a whole document that ended unfinished: the
    process dies just before or just after the closing write. A worker taken
    up again works every sentence, none passed, and never the whole document."""
    from plaid_agent.igt import job as igt_job
    client = JobClient({'d1': document('d1', 'Story', blank(7))})
    job = start(client, id=J, plan='document')
    real = igt_job.IgtRunner.write if at == 'before-write' else igt_job.IgtRunner.end_summary
    hit = {'n': 0}

    def dies(self, *a, **kw):
        if not hit['n']:
            hit['n'] = 1
            if at == 'after-write':
                real(self, *a, **kw)
            raise _Crash()
        return real(self, *a, **kw)
    monkeypatch.setattr(igt_job.IgtRunner, 'write' if at == 'before-write' else 'end_summary', dies)
    use(monkeypatch, _model({'Story': [3]}))
    with pytest.raises(_Crash):
        runner(job).document('d1')
    model = use(monkeypatch, _model({}))
    assert runner(job).document('d1') == 'done'
    assert not [c for c in model.calls if c['n'] == 1 and WHOLE in c['asked']]
    taken = sorted(n for _name, ns in _stretches(model) for n in ns)
    # Before the write nothing was written: s3 is worked again too. After it,
    # s3 is finished and every other sentence is taken in stretches.
    assert taken == ([1, 2, 3, 4, 5, 6, 7] if at == 'before-write' else [1, 2, 4, 5, 6, 7]), taken
    row = job.rows['d1']
    assert row['done'] == 7 and not row.get('skipped'), row
