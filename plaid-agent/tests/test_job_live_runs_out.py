"""BRIEF RW under a real core, with the shape of the measured run: a job
planned as one selection over one blank document, whose big pieces read until
their budget ends. Runs on the session's core (``live.py``), or the one
PLAID_TEST_URL names."""

from job_fixtures import Model, call, document, reply, targets_named, use

from plaid_agent.core.job import run_job
from plaid_agent.core.prompt import JOB_STEPS_USED_UP
from test_job_live_entries import _job, _runner, world  # noqa: F401 - the fixture
from test_job_live_selection import _morphs

N = 7
FORMS = [f'ka{i}' for i in range(1, N + 1)]
BIG = ('Your piece: the whole selection', 'Your piece: the whole document')


def _doc():
    return {'dA': document('dA', 'Alpha', [{'words': [f]} for f in FORMS])}


def _stage(numbers):
    return [call(10 + n, 'set_analysis', {'document': 'Alpha', 'ref': f's{n}.w1', 'morphemes': [
        {'form': FORMS[n - 1], 'fields': {'Morph Gloss': 'go'}}]}) for n in numbers]


def _reads(n):
    return reply(calls=[call(100 + n, 'analyses_of', {'form': f'x{n}'})])


def test_a_selection_that_never_ends_falls_back_to_stretches_and_writes(world, monkeypatch):
    """The measured run: the selection piece reads for ever and stages
    nothing. It is asked once, its document is never asked whole, and the
    stretches write every word."""
    admin, writer, make = world
    s = make(_doc())
    asked = []

    def answer(text, n, kwargs):
        if n == 1:
            asked.append(text.splitlines()[-1])
        if any(b in text for b in BIG):
            return _reads(n)
        return reply(calls=_stage(targets_named(text))) if n == 1 else reply('Glossed.')
    use(monkeypatch, Model(answer))
    job = _job(admin, writer, s, 'selection')
    finished = run_job(job, _runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
    assert asked == ['Your piece: the whole selection above.', 'Your piece: s1, s2, s3, s4, s5.',
                     'Your piece: s6, s7. s4, s5 are context.'], asked
    (doc,) = finished['report']['documents']
    assert doc['state'] == 'done' and doc['skipped'] == [] and doc['counts']['words'] == N
    assert all(len(_morphs(admin, s, 'dA', f'dA-s{i}w1')) == 1 for i in range(1, N + 1))
    assert finished['report']['plan']['fallback'] == [{'document_id': None, 'reason': 'failed'}]


def test_a_whole_document_staged_then_out_of_calls_is_closed_and_written(world, monkeypatch):
    """The other half of the measured run: a whole-document piece that
    staged the whole document and read on until its calls ran out. One
    closing call, and the document is written by that one piece."""
    admin, writer, make = world
    s = make(_doc())

    def answer(text, n, kwargs):
        if any(m.get('content') == JOB_STEPS_USED_UP for m in kwargs['messages']):
            return reply('Staged every word. Nothing unfinished.')
        if n == 1:
            return reply(calls=_stage(range(1, N + 1)))
        return _reads(n)
    model = use(monkeypatch, Model(answer))
    job = _job(admin, writer, s, 'document')
    finished = run_job(job, _runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
    assert len([c for c in model.calls if c['n'] == 1]) == 1
    (doc,) = finished['report']['documents']
    assert doc['counts']['words'] == N and doc['skipped'] == []
    assert all(len(_morphs(admin, s, 'dA', f'dA-s{i}w1')) == 1 for i in range(1, N + 1))
    assert finished['report']['pieces_ended'] == 1
    assert [n['note'] for n in finished['report']['notes']] == ['Staged every word. Nothing unfinished.']
