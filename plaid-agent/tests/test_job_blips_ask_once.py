"""Core's passing trouble during a piece or after its model has ended never
asks the model again (D21 of the job review 2026-11-18): a tool's read that
meets a 502 is made again at the call, and the piece's note, refusals and
write after its model are tried again on their own, as a selection's are
(REV-JG3-9). Only trouble that outlasts the tries unwinds the piece, and
trouble met once the write's first request went out (its send), after
which the piece is taken again over what is left (REV-L2B).

The test counts every call a job makes to the fake core, then runs the job
again once per call with a 502 at that call alone, and counts the model's
calls each time."""

import pytest

from job_fixtures import JobClient, Model, planned, runner, start, use
from test_job_core_blips import J, Blips, _analyse, _docs, _install

from plaid_agent.core.job import run_job
from plaid_agent.igt.job import IgtRunner


class Sending(Blips):
    """Blips that also notes which calls a write's send made."""

    def __init__(self, at=None):
        super().__init__(at)
        self.sending = False
        self.in_send = set()

    def wrap(self, name, fn):
        inner = super().wrap(name, fn)

        def wrapped(*a, **kw):
            if self.sending:
                self.in_send.add(self.n + 1)
            return inner(*a, **kw)
        return wrapped


def _run(monkeypatch, at, pieces):
    client = JobClient(_docs())
    job = start(client, id=J, plan=pieces)
    blips = Sending(at)
    _install(monkeypatch, client, blips)
    send = IgtRunner.send

    def sending(self, *a, **kw):
        blips.sending = True
        try:
            return send(self, *a, **kw)
        finally:
            blips.sending = False
    monkeypatch.setattr(IgtRunner, 'send', sending)
    model = use(monkeypatch, Model(planned(_analyse)))
    finished = run_job(job, runner(job))
    return finished, blips, len(model.calls)


@pytest.mark.parametrize('pieces', [None, 'sentences', 'document', 'selection'])
def test_one_502_at_any_call_never_asks_the_model_again(monkeypatch, pieces):
    with monkeypatch.context() as m:
        finished, blips, asked = _run(m, None, pieces)
    assert finished['state'] == 'done'
    n, names, in_send = blips.n, blips.names, blips.in_send
    again = []
    for at in range(1, n + 1):
        with monkeypatch.context() as m:
            finished, blips, asked_now = _run(m, at, pieces)
        assert finished['state'] == 'done', (at, names[at - 1], finished.get('reason'))
        if asked_now != asked and at not in in_send:
            again.append((at, names[at - 1], asked_now - asked))
    assert not again, again
