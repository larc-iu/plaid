"""The join of RW, JR1 and JR2 (JOIN18, REV-JR1-7, REV-JR2-7): a write that
core never answers for, in any kind of piece, puts its document off as core
not answering, never as a person editing it. The document ends not reached
and marked unanswered, and the top line says the server did not answer,
never that someone was editing it or that the job's step failed."""

import pytest

from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_client import PlaidAPIError
from plaid_agent.core.job import run_job
from plaid_agent.igt import job as igt_job
from plaid_agent.igt.job import UNANSWERED


def _said(client):
    return [b.get('message') for k, b in client.jobs.calls if k == 'heartbeat' and b.get('message')]


def _run(monkeypatch, pieces, fills, where):
    clock = {'t': 1_800_000_000.0}
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['blank']}])})
    kw = {} if fills is None else {'fills': fills}
    job = start(client, 'Check every gloss.' if fills == () else 'Gloss everything.', now=lambda: clock['t'],
                plan=pieces, **kw)

    def sleep(s):
        clock['t'] += s
    job._sleep = sleep

    def answer(asked, n, kwargs):
        if n == 1:
            return reply(calls=[call(1, 'set_analysis', {'document': 'Story', 'ref': 's1.w1',
                                                         'morphemes': [{'form': 'blank'}]})])
        return reply('Done.')
    use(monkeypatch, Model(answer))

    def down(*a, **kw):
        raise PlaidAPIError('HTTP 502', status=502, method='POST')
    if where == 'send':
        # Once its request went out, its answer lost (a proxy's 502 on the
        # batch's POST, which the executor reads as of unknown outcome,
        # REV-SJ2-2): the piece is taken again over what is left (REV-L2B),
        # then the document is put off.
        from plaid_client import testing
        real = testing._Batch.submit

        def lost(self):
            if not self.queued:
                return real(self)
            down()
        monkeypatch.setattr(testing._Batch, 'submit', lost)
    else:
        # Before its first request (the gate's reads): made again from the
        # gate, then put off with core's error (D21, REV-JR1-7).
        monkeypatch.setattr(igt_job.IgtRunner, 'write', down)
    return client, job, run_job(job, runner(job))


@pytest.mark.parametrize('pieces,fills,where', [
    (pieces, fills, where)
    for pieces, fills in [('sentences', None), ('document', None), ('selection', None),
                          # A plan that fills nothing ends such a document
                          # in the walk (UNWORKED_HOW's ``unreachable``).
                          ('document', ()), ('selection', ())]
    for where in ('gate', 'send')
])
def test_a_write_core_never_answers_for_ends_its_document_unanswered(monkeypatch, pieces, fills, where):
    client, job, finished = _run(monkeypatch, pieces, fills, where)
    said = _said(client)
    assert not [m for m in said if m.startswith('Waiting for people')], said
    assert job.paused['edits'] == 0, "not a wait for people's edits"
    (d1,) = finished['report']['documents']
    assert d1['state'] == 'not-reached' and (d1.get('counts') or {}).get(UNANSWERED) is True, d1
    assert not d1.get('defers'), d1
    notice = finished['report']['notice'] or ''
    assert '1 document was not worked: the server did not answer.' in notice, notice
    assert 'someone was editing' not in notice and "the job's step" not in notice, notice
    assert 'was written' not in notice, notice


# REV-JOIN18-3: a document ended unanswered keeps no in-memory "written as
# staged" mark, so its tally never says both.
@pytest.mark.parametrize('how', ['end_unworked', 'end_if_unanswered'])
def test_a_document_ended_unanswered_is_never_tallied_as_written_as_staged(how):
    from plaid_agent.core.limits import JOB_DEFER_ROUNDS
    from plaid_agent.igt.job import RAN_OUT
    from plaid_agent.igt.project import load_project
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['blank']}])})
    job = start(client, 'Check every gloss.', plan='document', fills=())
    r = runner(job)
    r.ran_out['d1'] = 'written'
    if how == 'end_unworked':
        r.end_unworked(load_project(client, job.project_id), 'd1', UNANSWERED)
    else:
        r.server_off['d1'] = RuntimeError('502')
        r.unanswered['d1'] = JOB_DEFER_ROUNDS
        r.end_if_unanswered('d1')
    assert job.rows['d1']['state'] == 'not-reached'
    counts = r.tally('d1', None).get('counts') or {}
    assert counts.get(UNANSWERED) is True and RAN_OUT not in counts, counts


@pytest.mark.parametrize('pieces', ['document', 'selection'])
def test_a_check_whose_unfinished_piece_cannot_be_written_never_says_it_was_written(monkeypatch, pieces):
    """JOIN18's open item: a check (fills nothing) whose big piece ran out of
    steps with a change staged, and whose write's send then fails, says the
    server did not answer, never "what it had staged there was written"."""
    from plaid_agent.core.prompt import JOB_STEPS_USED_UP
    clock = {'t': 1_800_000_000.0}
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['blank']}])})
    job = start(client, 'Check every gloss.', now=lambda: clock['t'], plan=pieces, fills=())

    def sleep(s):
        clock['t'] += s
    job._sleep = sleep

    def answer(asked, n, kwargs):
        if any(m.get('content') == JOB_STEPS_USED_UP for m in kwargs['messages']):
            return reply('Ran out.')
        if n == 1:
            return reply(calls=[call(1, 'set_analysis', {'document': 'Story', 'ref': 's1.w1',
                                                         'morphemes': [{'form': 'blank'}]})])
        return reply(calls=[call(100 + n, 'no_such_tool', {'n': n})])
    use(monkeypatch, Model(answer))

    from plaid_client import testing
    real = testing._Batch.submit

    def lost(self):
        if not self.queued:
            return real(self)
        raise PlaidAPIError('HTTP 502', status=502, method='POST')
    monkeypatch.setattr(testing._Batch, 'submit', lost)
    finished = run_job(job, runner(job))
    (d1,) = finished['report']['documents']
    assert d1['state'] == 'not-reached' and (d1.get('counts') or {}).get(UNANSWERED) is True, d1
    assert (d1.get('counts') or {}).get('ran_out') is None, d1
    notice = finished['report']['notice'] or ''
    assert '1 document was not worked: the server did not answer.' in notice, notice
    assert 'was written' not in notice, notice


@pytest.mark.parametrize('ran_out', [False, True])
@pytest.mark.parametrize('landed', [False, True])
@pytest.mark.parametrize('pieces', ['document', 'selection'])
def test_a_checks_lost_answer_says_what_landed(monkeypatch, pieces, landed, ran_out):
    """REV-SJ2-2: a check (fills nothing) whose write's answer is lost, as
    the real executor raises it (a proxy's 502 on the batch's POST, read by
    ``applying`` as a PlanError of unknown outcome). The top line says what
    core holds: written when the write landed, the server did not answer
    when it did not. A piece that ran out and was not written is never said
    written (``ran_out`` waits for core to hold the write)."""
    from plaid_client import testing
    from plaid_agent.core.prompt import JOB_STEPS_USED_UP
    clock = {'t': 1_800_000_000.0}
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['blank']}])})
    job = start(client, 'Check every gloss.', now=lambda: clock['t'], plan=pieces, fills=())

    def sleep(s):
        clock['t'] += s
    job._sleep = sleep

    def answer(asked, n, kwargs):
        if any(m.get('content') == JOB_STEPS_USED_UP for m in kwargs['messages']):
            return reply('Ran out.')
        if n == 1:
            return reply(calls=[call(1, 'set_analysis', {'document': 'Story', 'ref': 's1.w1',
                                                         'morphemes': [{'form': 'blankx'}]})])
        if ran_out:
            return reply(calls=[call(100 + n, 'no_such_tool', {'n': n})])
        return reply('Checked.')
    use(monkeypatch, Model(answer))
    real = testing._Batch.submit

    def lost(self):
        if not self.queued:
            return real(self)
        if landed:
            real(self)
        raise PlaidAPIError('HTTP 502', status=502, method='POST')
    monkeypatch.setattr(testing._Batch, 'submit', lost)
    finished = run_job(job, runner(job))
    (d1,) = finished['report']['documents']
    notice = finished['report']['notice'] or ''
    if landed:
        assert d1['state'] == 'done' and (d1.get('counts') or {}).get('changes') == 1, d1
        assert 'did not answer' not in notice, notice
        if ran_out:
            assert 'what it had staged there was written, and the rest was not done.' in notice, notice
        elif pieces == 'selection':
            assert 'The job worked on its one document in one step and changed it.' in notice, notice
        else:
            # Its one piece finished and its write landed: done, nothing to say.
            assert not notice, notice
    else:
        assert (d1.get('counts') or {}).get('changes') == 0, d1
        assert d1['state'] == 'not-reached' and (d1.get('counts') or {}).get(UNANSWERED) is True, d1
        assert '1 document was not worked: the server did not answer.' in notice, notice
        assert 'was written' not in notice, notice
