"""THE GATE under a real core (REV-JG-1): a `document` piece and a
`selection` piece write through the one write that settles the document
first, so a word the starter cleared after a write whose record was lost is
never written again, however the job got there: a crash, a passing error
after the write, a split. And a sentence the starter edits during the piece
is taken again rather than written over.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import time
import uuid

import pytest

from fixtures import MORPH_LAYER, SENT_LAYER, TRANS
from job_fixtures import plan_row, Model, call, document, job_project, reply, use
from live import _skip_or_fail, core_url, login, seed

from plaid_client import PlaidAPIError
from plaid_agent.core.agent import ModelConfig
from plaid_agent.core.job import Job, run_job
from plaid_agent.igt.job import RECORD_FORM, IgtRunner
from plaid_agent.jobworker import count_chars

WORKER = '0193a5c0-0000-7000-8000-0000000000d7'
PIECES = ['document', 'selection']
# "ka ta pa. sa." : ka at 0, ta at 3, pa at 6, sa at 10.
SA, PA = 10, 6


class Crash(BaseException):
    """The worker's process dies here."""


@pytest.fixture
def world():
    try:
        admin = login()
    except Exception as e:  # noqa: BLE001
        _skip_or_fail(f'no core: {e}')
    from plaid_client import PlaidClient
    email = f'job-gate-{uuid.uuid4().hex[:8]}@example.org'
    admin.users.create(email, 'job-gate-pass-1', False)
    writer = PlaidClient.login(core_url(), email, 'job-gate-pass-1')
    docs = {'d1': document('d1', 'Story', [{'words': ['ka', 'ta', 'pa']}, {'words': ['sa']}])}
    lexicon = {'id': 'v1', 'name': 'Lexicon', 'project': 'p1', 'items': []}
    s = seed(admin, job_project(), docs, {'v1': lexicon}, name=f'job gate {uuid.uuid4().hex[:6]}')
    admin.projects.add_writer(s.project_id, email)
    yield admin, writer, s
    s.delete()


def _gloss(asked, n, kwargs):
    """Every word of Story, whatever the piece."""
    if n > 1:
        return reply('Glossed.')
    refs = ['s1.w1', 's1.w2', 's1.w3', 's2.w1']
    return reply(calls=[call(i, 'set_analysis', {'document': 'Story', 'ref': r, 'morphemes': [
        {'form': 'x', 'fields': {'Morph Gloss': f'go{i}'}}]}) for i, r in enumerate(refs, start=1)])


def _job(admin, writer, s, pieces, sleep=None):
    from plaid_client import PlaidClient
    made = writer.jobs.create(s.project_id, 'igt', 'Gloss every word nobody analysed.')
    claimed = admin.jobs.claim(WORKER, 'fake/m', ['igt'])
    assert claimed and claimed['job']['id'] == made['id']
    admin.jobs.add_decisions(made['id'], WORKER, [plan_row(pieces)])
    offset = {'s': 0.0}

    def wait(sec):
        offset['s'] += sec
        if sleep:
            sleep(sec)
    return Job(admin, claimed, WORKER, client_for=lambda token: PlaidClient(core_url(), token), model='fake/m',
               sleep=wait, now=lambda: time.time() + offset['s'])


def _runner(job):
    return IgtRunner(job, ModelConfig(model='fake/m', stream=False, max_steps=1000), count=count_chars,
                     write_summary=False)


def _morphs(admin, s):
    raw = admin.documents.get(s.ids['d1'], include_body=True)
    return [t for tl in raw['text_layers'] for tk in tl['token_layers'] if tk['id'] == s.ids[MORPH_LAYER]
            for t in tk.get('tokens') or []]


def _clear(admin, writer, s, begin):
    """The starter deletes the job's morpheme at ``begin``: the word reads
    as nobody's analysis."""
    for t in _morphs(admin, s):
        if t['begin'] == begin:
            writer.tokens.delete(t['id'])


def _crash_then_resume(admin, writer, s, monkeypatch, pieces, between):
    job = _job(admin, writer, s, pieces)
    real = IgtRunner.record

    def record(self, *a, **kw):
        raise Crash()
    monkeypatch.setattr(IgtRunner, 'record', record)
    with pytest.raises(Crash):
        run_job(job, _runner(job))
    monkeypatch.setattr(IgtRunner, 'record', real)
    assert {t['begin'] for t in _morphs(admin, s)} == {0, 3, PA, SA}, 'the write landed'
    between()
    # A new worker process: the rows as core has them, a new runner.
    job.rows = {x['document_id']: dict(x) for x in admin.jobs.get(job.id)['documents']}
    return run_job(job, _runner(job)), job


@pytest.mark.parametrize('pieces', PIECES)
def test_a_crash_after_the_write_and_a_cleared_word_is_never_written_again(world, monkeypatch, pieces):
    admin, writer, s = world
    use(monkeypatch, Model(_gloss))
    finished, job = _crash_then_resume(admin, writer, s, monkeypatch, pieces, lambda: _clear(admin, writer, s, SA))
    assert finished['state'] == 'done', (finished.get('reason'), finished.get('message'))
    assert SA not in {t['begin'] for t in _morphs(admin, s)}, 'sa is left as the starter left it'
    row = finished['documents'][0]
    assert row['skipped'] == [] and row['counts']['words'] == 4, 'core says the write landed: counted, not listed'


@pytest.mark.parametrize('pieces', PIECES)
def test_a_crash_and_a_second_worker_with_nobody_writing_writes_nothing_twice(world, monkeypatch, pieces):
    admin, writer, s = world
    use(monkeypatch, Model(_gloss))
    before = {}
    finished, job = _crash_then_resume(admin, writer, s, monkeypatch, pieces,
                                       lambda: before.update(n=len(_morphs(admin, s))))
    assert finished['state'] == 'done'
    assert len(_morphs(admin, s)) == before['n'] == 4
    assert finished['report']['totals']['words'] == 4 and not finished['report']['proposed']


@pytest.mark.parametrize('pieces', PIECES)
def test_a_split_after_the_write_and_a_cleared_word_is_never_written_again(world, monkeypatch, pieces):
    admin, writer, s = world
    use(monkeypatch, Model(_gloss))

    def split():
        # igt's Split sentence: the left half keeps the id, pa goes right.
        writer.tokens.split(s.ids['d1-s1'], PA)
        _clear(admin, writer, s, PA)
    finished, job = _crash_then_resume(admin, writer, s, monkeypatch, pieces, split)
    assert finished['state'] == 'done', (finished.get('reason'), finished.get('message'))
    raw = admin.documents.get(s.ids['d1'], include_body=True)
    assert len([t for tl in raw['text_layers'] for tk in tl['token_layers'] if tk['id'] == s.ids[SENT_LAYER]
                for t in tk['tokens']]) == 3
    assert PA not in {t['begin'] for t in _morphs(admin, s)}, 'pa is left as the starter left it'


@pytest.mark.parametrize('pieces', PIECES)
def test_a_passing_error_on_the_record_and_a_word_cleared_in_the_wait(world, monkeypatch, pieces):
    admin, writer, s = world
    use(monkeypatch, Model(_gloss))
    state = {'n': 0}

    def sleep(sec):
        if state['n'] == 1:
            state['n'] = 2
            _clear(admin, writer, s, SA)
    job = _job(admin, writer, s, pieces, sleep=sleep)
    real = job.update_row

    def update(document_id, **fields):
        if (fields.get('counts') or {}).get('words') and not state['n']:
            state['n'] = 1
            raise PlaidAPIError('HTTP 502', status=502, method='PUT')
        return real(document_id, **fields)
    monkeypatch.setattr(job, 'update_row', update)
    finished = run_job(job, _runner(job))
    assert state['n'] == 2, 'the 502 was met and the starter cleared sa in the wait'
    assert finished['state'] == 'done', (finished.get('reason'), finished.get('message'))
    assert SA not in {t['begin'] for t in _morphs(admin, s)}, 'sa is left as the starter left it'
    row = finished['documents'][0]
    assert row['skipped'] == [] and row['counts']['words'] == 4, 'core says the write landed: counted, not listed'


@pytest.mark.parametrize('pieces', PIECES)
def test_a_sentence_the_starter_edits_during_the_piece_is_taken_again(world, monkeypatch, pieces):
    """REV-JG-5: the starter writes a translation of s1 while the piece
    works. Nothing is written over it: s1 is taken again and glossed then,
    and the starter's translation stays."""
    admin, writer, s = world
    edited = {}

    def model(asked, n, kwargs):
        if n > 1 and not edited:
            edited['span'] = writer.spans.create(s.ids[TRANS], [s.ids['d1-s1']], 'The starter wrote this.')
        return _gloss(asked, n, kwargs)
    use(monkeypatch, Model(model))
    job = _job(admin, writer, s, pieces)
    finished = run_job(job, _runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), finished.get('message'))
    assert {t['begin'] for t in _morphs(admin, s)} == {0, 3, PA, SA}, 's1 was glossed when taken again'
    raw = admin.documents.get(s.ids['d1'], include_body=True)
    values = [sp['value'] for tl in raw['text_layers'] for tk in tl['token_layers']
              for sl in tk.get('span_layers') or [] for sp in sl.get('spans') or []]
    assert 'The starter wrote this.' in values
    assert not finished['documents'][0]['skipped']
