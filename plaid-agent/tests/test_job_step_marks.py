"""RW round 4 (REV-RW-R3-2 and the copy note): the top line says of each
document a big piece did not finish what is true there. A document the
unfinished step read part of and changed nothing in is said so, never "not
reached" (a row state of its own), one it never read "was not read", and a
whole document's own failed part is never "the job's step". Reads are
scripted with calls that need no core."""

from job_fixtures import JobClient, Model, blank, call, document, reply, runner, start, use

from plaid_agent.core.job import run_job
from plaid_agent.core.prompt import JOB_STEPS_USED_UP

J = 'JSM'
SELECTION = 'Your piece: the whole selection'
WHOLE = 'Your piece: the whole document'


def _closing(kwargs):
    return any(m.get('content') == JOB_STEPS_USED_UP for m in kwargs['messages'])


def test_an_unfinished_step_says_read_in_part_unchanged_and_not_read_apart(monkeypatch):
    """The selection reads s1 of Story and stages a change in Tale, then runs
    out. Story was read in part and not changed, Myth was not read."""
    client = JobClient({'d1': document('d1', 'Story', blank(3)), 'd2': document('d2', 'Tale', blank(3)),
                        'd3': document('d3', 'Myth', blank(3))})
    job = start(client, 'Check every gloss and list the odd ones.', id=J, plan='selection', fills=())

    def answer(asked, n, kwargs):
        if _closing(kwargs):
            return reply('Ran out.')
        if n == 1:
            return reply(calls=[call(1, 'read_document', {'document': 'Story', 'to_sentence': 1})])
        if n == 2:
            return reply(calls=[call(2, 'set_analysis', {'document': 'Tale', 'ref': 's3.w1', 'morphemes': [
                {'form': 'ka', 'type': 'stem', 'fields': {'Morph Gloss': 'go'}}]})])
        return reply(calls=[call(100 + n, 'no_such_tool', {'n': n})])
    use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    marks = {d['name']: d['counts'].get('ran_out') for d in finished['report']['documents']}
    assert marks == {'Myth': 'not-read', 'Story': 'unchanged', 'Tale': 'written'}, marks
    notice = finished['report']['notice']
    assert ('1 document was read in part and not changed: the job\'s step over the documents ended before it '
            'finished it.') in notice, notice
    assert '1 document was not read: the job\'s step over the documents ended before it.' in notice, notice
    assert 'not reached' not in notice
    totals = finished['report']['totals']
    assert (totals['documents_step_unchanged'], totals['documents_step_not_read'], totals['documents_ran_out'],
            totals['documents_not_reached']) == (1, 1, 1, 0), totals
