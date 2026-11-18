"""Core's passing trouble during a piece or after its model has ended never
asks the model again (D21 of the job review 2026-11-18): a tool's read that
meets a 502 is made again at the call, and the piece's note, refusals and
write after its model are tried again on their own, as a selection's are
(REV-JG3-9). Only trouble that outlasts the tries unwinds the piece.

The test counts every call a job makes to the fake core, then runs the job
again once per call with a 502 at that call alone, and counts the model's
calls each time."""

import pytest

from job_fixtures import JobClient, Model, planned, runner, start, use
from test_job_core_blips import J, Blips, _analyse, _docs, _install

from plaid_agent.core.job import run_job


def _run(monkeypatch, at, pieces):
    client = JobClient(_docs())
    job = start(client, id=J, plan=pieces)
    blips = Blips(at)
    _install(monkeypatch, client, blips)
    model = use(monkeypatch, Model(planned(_analyse)))
    finished = run_job(job, runner(job))
    return finished, blips, len(model.calls)


@pytest.mark.parametrize('pieces', [None, 'sentences', 'document', 'selection'])
def test_one_502_at_any_call_never_asks_the_model_again(monkeypatch, pieces):
    with monkeypatch.context() as m:
        finished, blips, asked = _run(m, None, pieces)
    assert finished['state'] == 'done'
    n, names = blips.n, blips.names
    again = []
    for at in range(1, n + 1):
        with monkeypatch.context() as m:
            finished, blips, asked_now = _run(m, at, pieces)
        assert finished['state'] == 'done', (at, names[at - 1], finished.get('reason'))
        if asked_now != asked:
            again.append((at, names[at - 1], asked_now - asked))
    assert not again, again
