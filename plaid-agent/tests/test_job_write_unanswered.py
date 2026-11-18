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
        # Once its request went out: the piece is taken again over what is
        # left (REV-L2B), then the document is put off.
        monkeypatch.setattr(igt_job, 'execute_plan', down)
    else:
        # Before its first request (the gate's reads): made again from the
        # gate, then put off with core's error (D21, REV-JR1-7).
        monkeypatch.setattr(igt_job.IgtRunner, 'write', down)
    return client, job, run_job(job, runner(job))


_OPEN = pytest.mark.xfail(strict=True, reason=(
    'JOIN18 open item: a check by documents whose whole piece ran out is marked "written" before its write '
    '(go_on), and a send that fails after its request went out does not undo the mark'))


@pytest.mark.parametrize('pieces,fills,where', [
    (pieces, fills, where)
    for pieces, fills in [('sentences', None), ('document', None), ('selection', None),
                          # A plan that fills nothing ends such a document
                          # in the walk (UNWORKED_HOW's ``unreachable``).
                          ('document', ()), ('selection', ())]
    for where in ('gate', 'send') if (pieces, fills, where) != ('document', (), 'send')
] + [pytest.param('document', (), 'send', marks=_OPEN)])
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
