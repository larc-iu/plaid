"""BRIEF RW B2: a piece whose budget runs out (its calls, one call's prompt,
or what all its calls sent) while it holds staged work is not failed with
that work thrown away. It is asked ONE closing call, with no tools and a
fixed line, and what it staged is then written by the ordinary write (the
gate, the apply rule, the record), as any piece that ended. A piece that
staged nothing fails as before (halved, skipped). What the closing write
leaves empty in the piece's sentences is counted in Left blank, as for any
piece that ended: the piece is finished whole, so the cursor never passes a
sentence left to a half (REV-SP-10's loss cannot happen)."""

import pytest

from job_fixtures import JobClient, Model, blank, call, document, reply, runner, start, targets_named, use

from plaid_agent.core import job as core_job
from plaid_agent.core.job import run_job
from plaid_agent.core.limits import JOB_STRETCH_MAX_ROUNDS
from plaid_agent.core.prompt import JOB_STEPS_USED_UP, JOB_STEPS_USED_UP_REFUSED

J = 'JCL'
WHOLE = 'Your piece: the whole document'


def _analyse(asked, only=None):
    name = asked.split('"')[1]
    return [call(10 * n, 'set_analysis', {'document': name, 'ref': f's{n}.w1', 'morphemes': [
        {'form': f'ka{n}', 'type': 'stem', 'fields': {'Morph Gloss': 'go'}}]})
            for n in (only or (range(1, 50) if WHOLE in asked else targets_named(asked))) if f'[s{n}]' in asked]


def _closing(kwargs):
    return any(m.get('content') == JOB_STEPS_USED_UP for m in kwargs['messages'])


def _model(stage=None, closing=lambda kwargs: reply('Staged s1 to s5. Nothing unfinished.')):
    """A piece that stages at its first call (``stage(asked)``, every target
    sentence unless given), then reads until its budget ends, and answers
    the closing call with ``closing``."""
    def answer(asked, n, kwargs):
        if _closing(kwargs):
            return closing(kwargs)
        if n == 1:
            return reply(calls=(stage or _analyse)(asked))
        return reply(calls=[call(100 + n, 'no_such_tool', {'n': n})])
    return Model(answer)


def _written(client):
    return str([p for k, p in client.calls if k in ('tokens.create', 'tokens.bulk_create')])


def test_a_stretch_out_of_calls_with_work_staged_is_asked_once_to_close_and_written(monkeypatch):
    client = JobClient({'d1': document('d1', 'Story', blank(5))})
    job = start(client, id=J, plan='sentences')
    model = use(monkeypatch, _model())
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert [c['n'] for c in model.calls] == list(range(1, JOB_STRETCH_MAX_ROUNDS + 2)), 'one piece, 20 calls and one'
    last = model.calls[-1]['kwargs']
    assert _closing(last) and [m.get('content') for m in last['messages']].count(JOB_STEPS_USED_UP) == 1
    assert 'tools' not in last, 'the closing call offers no tool'
    (doc,) = finished['report']['documents']
    assert doc['state'] == 'done' and doc['skipped'] == [] and doc['counts']['words'] == 5
    for n in range(1, 6):
        assert f"'ka{n}'" in _written(client)
    assert [n['note'] for n in finished['report']['notes']] == ['Staged s1 to s5. Nothing unfinished.']


def test_the_closing_line_says_the_steps_are_used_up():
    assert JOB_STEPS_USED_UP == ('(system) The steps of this piece are used up: no tool can be called now. What '
                                 'you staged is written as it stands. End now with your note, saying what is '
                                 'unfinished.')
    assert JOB_STEPS_USED_UP_REFUSED == 'The steps of this piece are used up: end now with your note.'


def test_the_measured_shape_a_whole_document_staged_whole_is_written_in_one_piece(monkeypatch):
    """The trace's shape: a whole-document piece of a 19-sentence document
    stages the whole document, then reads until its budget ends."""
    client = JobClient({'d1': document('d1', 'Story', blank(19))})
    job = start(client, id=J, plan='document')
    model = use(monkeypatch, _model())
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert len([c for c in model.calls if c['n'] == 1]) == 1, 'one piece'
    assert WHOLE in model.calls[0]['asked']
    (doc,) = finished['report']['documents']
    assert doc['counts']['words'] == 19 and doc['skipped'] == []
    assert finished['report']['plan']['fallback'] == []


@pytest.mark.parametrize('budget', ['calls', 'prompt', 'sent'])
def test_each_budget_closes_a_piece_that_holds_work(monkeypatch, budget):
    client = JobClient({'d1': document('d1', 'Story', blank(2))})
    job = start(client, id=J, plan='sentences')
    r = runner(job)
    at = {'n': 0}
    if budget == 'prompt':
        # From the third call on, a prompt over the cap of one call.
        r.count = lambda value: 70000 if at['n'] >= 2 and isinstance(value, list) and value \
            and isinstance(value[0], dict) and value[0].get('role') == 'system' else 10
    elif budget == 'sent':
        # Each call's prompt counted 100: the third would pass 250 sent.
        r.count = lambda value: 50
        monkeypatch.setattr(core_job, 'JOB_STRETCH_MAX_SENT_TOKENS', 250)
    model = _model(closing=lambda kwargs: reply('Closed.'))
    inner = model.answer

    def answer(asked, n, kwargs):
        at['n'] = n
        return inner(asked, n, kwargs)
    model.answer = answer
    use(monkeypatch, model)
    finished = run_job(job, r)
    (doc,) = finished['report']['documents']
    assert doc['counts']['words'] == 2 and doc['skipped'] == [], (budget, doc)
    assert sum(1 for c in model.calls if _closing(c['kwargs'])) == 1


def test_a_piece_out_of_calls_with_nothing_staged_fails_as_before(monkeypatch):
    client = JobClient({'d1': document('d1', 'Story', blank(1))})
    job = start(client, id=J, plan='sentences')
    model = use(monkeypatch, _model(stage=lambda asked: [call(1, 'no_such_tool', {'n': 0})]))
    runner(job).document('d1')
    assert not any(_closing(c['kwargs']) for c in model.calls)
    assert job.rows['d1']['skipped'] == [{'sentence': 's1', 'sentence_id': 'd1-s1', 'reason': 'failed',
                                          'kind': 'budget'}]


@pytest.mark.parametrize('only_empty', [False, True])
def test_a_closed_stretchs_unstaged_sentences_are_skipped_failed_and_counted(monkeypatch, only_empty):
    """REV-RW-2 (the reviewer's P1): a stretch of s1 to s5 stages s1 and s2
    and runs out. s1 and s2 are written. s3 to s5, with nothing staged, are
    skipped failed with the budget's kind and counted as skipped, never as
    worked, never asked again, and a worker taken up again asks for nothing:
    no sentence of the stretch is passed uncounted."""
    client = JobClient({'d1': document('d1', 'Story', blank(5))})
    job = start(client, id=J, plan='sentences', only_empty=only_empty)
    model = use(monkeypatch, _model(stage=lambda asked: _analyse(asked, only=[1, 2])))
    finished = run_job(job, runner(job))
    assert len([c for c in model.calls if c['n'] == 1]) == 1, 'never asked again'
    (doc,) = finished['report']['documents']
    assert doc['state'] == 'done' and doc['counts']['words'] == 2
    assert [(s['sentence'], s['reason'], s['kind']) for s in doc['skipped']] == [
        ('s3', 'failed', 'budget'), ('s4', 'failed', 'budget'), ('s5', 'failed', 'budget')]
    (blank_row,) = [b for b in doc['counts']['blank'] if b['target'] == 'segmentation']
    # s1 and s2's second words (left), s3 to s5's words (skipped): none
    # untouched, none not reached.
    assert (blank_row['left'], blank_row['untouched'], blank_row['not_reached'], blank_row['skipped']) == \
        (2, 0, 0, 6), blank_row
    assert finished['report']['totals']['skipped_failed'] == 3
    r = runner(job)
    project = r.project()
    assert r.pending(r.read(project, 'd1'), project, 'd1', every=r.every_sentence()) == []


@pytest.mark.parametrize('how', ['cut', 'error'])
def test_a_closing_call_that_fails_still_writes_what_was_staged(monkeypatch, how):
    client = JobClient({'d1': document('d1', 'Story', blank(2))})
    job = start(client, id=J, plan='sentences')

    def closing(kwargs):
        if how == 'cut':
            return reply('...', finish='length')
        raise RuntimeError('the provider failed')
    model = use(monkeypatch, _model(closing=closing))
    finished = run_job(job, runner(job))
    (doc,) = finished['report']['documents']
    assert doc['counts']['words'] == 2 and doc['skipped'] == []
    assert sum(1 for c in model.calls if _closing(c['kwargs'])) == 1, 'the closing call is never asked again'
    assert [n['note'] for n in finished['report']['notes']] in ([], [{'note': ''}]) or \
        all(not n['note'] for n in finished['report']['notes'])


def test_a_closing_answer_that_calls_a_tool_is_refused_and_the_piece_ends(monkeypatch):
    client = JobClient({'d1': document('d1', 'Story', blank(2))})
    job = start(client, id=J, plan='sentences')
    model = use(monkeypatch, _model(closing=lambda kwargs: reply(calls=[call(500, 'read_document',
                                                                             {'document': 'Story'})])))
    finished = run_job(job, runner(job))
    (doc,) = finished['report']['documents']
    assert doc['counts']['words'] == 2 and doc['skipped'] == []
    assert len(model.calls) == JOB_STRETCH_MAX_ROUNDS + 1, 'no call after the closing one'


def test_the_planning_has_no_closing_call(monkeypatch):
    """The planning stages nothing: its budget ends it as before."""
    from plaid_agent.core.job import Pace
    pace = Pace('fake/m', count=lambda v: 10)
    with pytest.raises(core_job.StretchFailed):
        pace.note(JOB_STRETCH_MAX_ROUNDS, {'messages': []})


def _summaries(client):
    import json
    from plaid_agent.igt.job import PIECE_FORM
    return [json.loads(r['analysis']) for (f, _k), r in client.jobs.decision_rows.get(J, {}).items()
            if f == PIECE_FORM]


def test_a_closed_piece_says_so_on_its_row_and_the_report_counts_it(monkeypatch):
    """B5: the work list's row of a piece that ended by its closing call
    carries ``closed``, and the report counts such pieces."""
    client = JobClient({'d1': document('d1', 'Story', blank(7))})
    job = start(client, id=J, plan='sentences')

    closing = _model()

    def answer(asked, n, kwargs):
        # s1 to s5 run out of calls with their work staged, s6 and s7 end.
        if 6 in targets_named(asked):
            return reply(calls=_analyse(asked)) if n == 1 else reply('Done.')
        return closing.answer(asked, n, kwargs)
    use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    rows = _summaries(client)
    assert [r.get('ended') for r in rows] == ['budget', None], rows
    assert finished['report']['pieces_ended'] == 1
