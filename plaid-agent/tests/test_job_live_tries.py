"""A write cut short, on a real core (BRIEF RX-FIX items 2, 3 and 5): a try
that did not land, a crash between two tries of one write, and a lost answer
to a middle try, for a stretch, a document piece and a selection with a
lexicon change. And the reviewer's live probes: a rename after a try that
covered its one-sentence piece (REV-RX-3), and a write of a comment alone
(REV-RX-4), each with its answer lost and with its worker dead.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import pytest

from job_fixtures import Model, call, reply, use
from test_job_live_delete_sentence import _admin, _job, _read, _runner
from test_job_live_landed import _forms, _model, _morphs, _world

from plaid_client import PlaidAPIError
from plaid_agent.core.job import run_job
from plaid_agent.core.plan import PlanError
from plaid_agent.igt import job as igt_job
from plaid_agent.igt.job import INTERRUPTED


class Crash(BaseException):
    """The worker's process dies here."""


def _chained(e):
    """The executor's error for a write whose answer was lost."""
    err = PlanError('the answer was lost', 1, 1, unknown=True)
    err.__cause__ = e
    return err


def _resume(admin, job):
    """A new worker process: the rows as core has them."""
    job.rows = {x['document_id']: dict(x) for x in admin.jobs.get(job.id)['documents']}


def _run(admin, job, crashing):
    if crashing:
        with pytest.raises(Crash):
            run_job(job, _runner(job))
        _resume(admin, job)
    return run_job(job, _runner(job))


CUTS = ['not-landed', 'crash-between', 'lost-middle']


@pytest.mark.parametrize('cut', CUTS)
@pytest.mark.parametrize('pieces', ['sentences', 'document', 'selection-lexicon'])
def test_a_write_cut_short_is_written_once_and_nothing_vanishes(monkeypatch, pieces, cut):
    """A piece glosses ka, deletes the doubled sentence and renames gam:
    three tries. The deletion's try is cut: it never reaches core
    (``not-landed``), the worker dies before it (``crash-between``), or it
    lands and its answer is lost (``lost-middle``). Core says what landed:
    the gloss is never written again, the doubled sentence is deleted once
    (taken again when it was not deleted: its sentence is one of the
    piece's), the entry renamed once, and the report lists nothing, every
    change of the cut write having landed or been made by the piece taken
    again."""
    admin = _admin()
    selection = pieces.startswith('selection')
    writer, s = _world(admin, pieces)
    try:
        asked = []
        model = _model(True, True, s.ids['e-gam'], asked)
        glossed = []

        def answer(q, n, kwargs):
            # The gloss of ka is staged by the first piece alone: a later
            # piece's write in an earlier one's sentence is written
            # (REV-JH-1), which this test is not about.
            out = model(q, n, kwargs)
            calls = out.choices[0].message.tool_calls
            if calls and any(c.function.name == 'set_analysis' for c in calls):
                if glossed:
                    out.choices[0].message.tool_calls = [c for c in calls if c.function.name != 'set_analysis']
                glossed.append(True)
            return out
        use(monkeypatch, Model(answer))
        real, sent, done = igt_job.execute_plan, [], []

        def execute(c, ops, **kw):
            kinds = sorted(o['kind'] for o in ops)
            sent.append(kinds)
            if 'delete_sentence' in kinds and not done:
                done.append(True)
                if cut == 'not-landed':
                    raise _chained(PlaidAPIError('HTTP 502 Bad Gateway', status=502, method='POST'))
                if cut == 'crash-between':
                    raise Crash()
                real(c, ops, **kw)
                raise _chained(PlaidAPIError('HTTP 502 Bad Gateway', status=502, method='POST'))
            return real(c, ops, **kw)
        monkeypatch.setattr(igt_job, 'execute_plan', execute)
        job = _job(admin, writer, s, 'Gloss ka, delete a sentence that repeats the one before it, rename gam.',
                   'selection' if selection else pieces)
        finished = _run(admin, job, cut == 'crash-between')
        assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
        assert done, 'the deletion was cut'
        body, _sentences, _words = _read(admin, s)
        assert body == 'ka ta. sa.', body
        assert len(_morphs(admin, s)) == 1, 'ka glossed once'
        assert _forms(admin, s) == ['gaam'], 'gam renamed once'
        assert sent.count(['set_analysis']) == 1, f'the gloss sent once: {sent}'
        report = finished['report']
        assert report['proposed'] == [], report['proposed']
        assert (report['totals']['words'], report['totals']['deletions']) == (1, 1), report['totals']
    finally:
        s.delete()


def _one_sentence(monkeypatch):
    import test_job_live_landed as tl
    monkeypatch.setattr(tl, 'SENTENCES', [{'words': ['ka', 'ta']}])


@pytest.mark.parametrize('failure', ['lost', 'crash'])
def test_a_rename_after_a_try_that_covered_the_piece_is_listed(monkeypatch, failure):
    """REV-RX-3 live: a one-sentence document piece glosses ka and renames
    gam. The gloss lands and its answer is lost, or the worker dies: the
    piece is not asked again, the rename never sent, and it is listed among
    the report's proposed changes as not written, and counted."""
    _one_sentence(monkeypatch)
    admin = _admin()
    writer, s = _world(admin, 'document')
    try:
        asked = []

        def answer(q, n, kwargs):
            if 'Your piece:' not in q or n > 1:
                return reply('Done.')
            asked.append(q)
            return reply(calls=[call(1, 'set_analysis', {'document': 'Alpha', 'ref': 's1.w1', 'morphemes': [
                {'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]}),
                call(3, 'rename_entry', {'entry_id': s.ids['e-gam'], 'new_form': 'gaam'})])
        use(monkeypatch, Model(answer))
        real, sent = igt_job.execute_plan, []

        def execute(c, ops, **kw):
            sent.append(sorted(o['kind'] for o in ops))
            out = real(c, ops, **kw)
            if len(sent) == 1:
                if failure == 'crash':
                    raise Crash()
                raise _chained(PlaidAPIError('HTTP 502 Bad Gateway', status=502, method='POST'))
            return out
        monkeypatch.setattr(igt_job, 'execute_plan', execute)
        job = _job(admin, writer, s, 'Gloss ka, rename gam.', 'document')
        finished = _run(admin, job, failure == 'crash')
        assert finished['state'] == 'done'
        assert sent == [['set_analysis']] and len(asked) == 1
        assert len(_morphs(admin, s)) == 1 and _forms(admin, s) == ['gam']
        report = finished['report']
        assert [(c['kind'], c['reason']) for c in report['proposed']] == [('rename_entry', INTERRUPTED)]
        assert report['totals']['proposed'] == 1 and report['totals']['words'] == 1
    finally:
        s.delete()


@pytest.mark.parametrize('failure', ['lost', 'crash'])
def test_a_comment_alone_is_posted_once(monkeypatch, failure):
    """REV-RX-4 live: core audits no comment, and answers its key from the
    answers it keeps of keyed writes: after a lost answer or a crash the
    comment is known to have landed, posted once, the model asked once."""
    admin = _admin()
    writer, s = _world(admin, 'document')
    try:
        asked = []

        def answer(q, n, kwargs):
            if 'Your piece:' not in q or n > 1:
                return reply('Done.')
            asked.append(q)
            return reply(calls=[call(1, 'add_comment', {'document': 'Alpha', 'ref': 's1',
                                                        'body': 'Check this sentence.'})])
        use(monkeypatch, Model(answer))
        real, sent = igt_job.execute_plan, []

        def execute(c, ops, **kw):
            sent.append(sorted(o['kind'] for o in ops))
            out = real(c, ops, **kw)
            if len(sent) == 1:
                if failure == 'crash':
                    raise Crash()
                raise _chained(PlaidAPIError('HTTP 502 Bad Gateway', status=502, method='POST'))
            return out
        monkeypatch.setattr(igt_job, 'execute_plan', execute)
        job = _job(admin, writer, s, 'Comment on anything odd.', 'document')
        finished = _run(admin, job, failure == 'crash')
        assert finished['state'] == 'done'
        assert sent == [['add_comment']] and len(asked) == 1
        comments = admin._request('GET', f'/api/v1/projects/{s.project_id}/comments')
        bodies = [c['body'] for c in (comments.get('entries') if isinstance(comments, dict) else comments)]
        assert bodies == ['Check this sentence.'], bodies
        assert finished['report']['proposed'] == []
    finally:
        s.delete()
