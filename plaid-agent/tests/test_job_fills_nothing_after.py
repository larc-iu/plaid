"""RW round 3 (REV-RW-R2-2): a plan that fills nothing walks nothing after its
big piece, however it ended, and the report says what happened in each
document. A selection that fills something is walked only where something
is empty, and the documents it did not reach are counted."""

import json

import pytest

from job_fixtures import JobClient, Model, blank, call, document, reply, runner, start, targets_named, use

from plaid_agent.core.job import run_job
from plaid_agent.core.prompt import JOB_STEPS_USED_UP

J = 'JFN'
WHOLE = 'Your piece: the whole document'
SELECTION = 'Your piece: the whole selection'


def _closing(kwargs):
    return any(m.get('content') == JOB_STEPS_USED_UP for m in kwargs['messages'])


def _stage(name, ns, gloss='go'):
    return [call(10 * n, 'set_analysis', {'document': name, 'ref': f's{n}.w1', 'morphemes': [
        {'form': f'ka{n}', 'type': 'stem', 'fields': {'Morph Gloss': gloss}}]}) for n in ns]


def _reads(n):
    return reply(calls=[call(100 + n, 'no_such_tool', {'n': n})])


def _analysed(n):
    return [{'words': [{'form': f'ka{i}', 'morphs': [(f'ka{i}', 'go')]}, {'form': 'ta', 'morphs': [('ta', 'x')]}]}
            for i in range(1, n + 1)]


def _firsts(model):
    out = []
    for c in model.calls:
        if c['n'] == 1:
            a = c['asked']
            out.append('WHOLE' if WHOLE in a else 'SELECTION' if SELECTION in a else targets_named(a))
    return out


def _summaries(client):
    from plaid_agent.igt.job import PIECE_FORM
    return [json.loads(r['analysis']) for (f, _k), r in client.jobs.decision_rows.get(J, {}).items()
            if f == PIECE_FORM]


TWO = {'d1': document('d1', 'Story', blank(3)), 'd2': document('d2', 'Tale', blank(3))}


@pytest.mark.parametrize('how', ['ran-out', 'failed', 'no-answer'])
@pytest.mark.parametrize('plan', ['selection', 'document'])
def test_a_plan_that_fills_nothing_walks_nothing_after_its_big_piece_however_it_ended(monkeypatch, plan, how):
    """REV-RW-R2-2, the reviewer's P3B: a check (fills nothing) whose big piece
    runs out with a change staged in Story, fails having staged nothing, or
    answers nothing. No stretch is asked, every document ends, and the top
    line says what happened in each: written there, not read, or failed."""
    client = JobClient(dict(TWO))
    job = start(client, 'Check every gloss and list the odd ones.', id=J, plan=plan, fills=())

    def answer(asked, n, kwargs):
        if _closing(kwargs):
            return reply('Ran out.')
        if WHOLE in asked or SELECTION in asked:
            if how == 'no-answer':
                return reply('')
            if n == 1 and how == 'ran-out' and (SELECTION in asked or '"Story"' in asked):
                return reply(calls=_stage('Story', [1]))
            return _reads(n)
        return reply('Checked.')
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert all(a in ('WHOLE', 'SELECTION') for a in _firsts(model)), _firsts(model)
    assert all(d['state'] == 'done' for d in finished['report']['documents'])
    notice = finished['report']['notice']
    if how == 'ran-out' and plan == 'selection':
        assert ('1 document ended before the job had done its work there: what it had staged there was written, and '
                'the rest was not done.') in notice, notice
        assert '1 document was not read: the job\'s step over the documents ended before it.' in notice, notice
    elif how == 'ran-out':
        # By documents, Tale's own piece staged nothing and failed.
        assert ('1 document ended before the job had done its work there: what it had staged there was written, and '
                'the rest was not done.') in notice, notice
        assert '1 document was not worked: its part failed.' in notice, notice
    elif plan == 'document':
        assert '2 documents were not worked: the part for each failed.' in notice, notice
    else:
        assert '2 documents were not worked: the job\'s step over them failed.' in notice, notice
    assert 'what it had staged was written' not in notice


def test_an_unfinished_selection_that_fills_something_counts_the_documents_it_did_not_reach(monkeypatch):
    """A rename across documents (it fills a field, every value already
    filled) ends unfinished having read and changed Story alone: no document
    is walked (nothing the plan fills is empty: RPF3's rule), and the top
    line counts the document it did not reach."""
    client = JobClient({'d1': document('d1', 'Story', _analysed(2)), 'd2': document('d2', 'Tale', _analysed(2))})
    job = start(client, 'Rename the gloss go to went.', id=J, plan='selection')

    def answer(asked, n, kwargs):
        if _closing(kwargs):
            return reply('Ran out.')
        if SELECTION in asked:
            if n == 1:
                return reply(calls=[call(1, 'read_document', {'document': 'Story'})])
            if n == 2:
                return reply(calls=_stage('Story', [1, 2], gloss='went'))
            return _reads(n)
        return reply('Checked.')
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert _firsts(model) == ['SELECTION']
    notice = finished['report']['notice']
    assert '1 document was not read: the job\'s step over the documents ended before it.' in notice, notice
