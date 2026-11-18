"""One 502 inside record() after a write landed (REV-JR1-3): the write is
not made again from its gate with the piece's old prints, so no sentence
the job's own write changed reads as changed during the piece."""

import pytest

from job_fixtures import JobClient, Model, planned, runner, start, use
from test_job_core_blips import J, _analyse, _docs

from plaid_client import PlaidAPIError
from plaid_agent.core.job import run_job
from plaid_agent.igt.job import IgtRunner


@pytest.mark.parametrize('pieces', ['sentences', 'document'])
def test_a_blip_in_the_record_of_a_landed_write_never_reads_its_own_sentences_as_changed(monkeypatch, pieces):
    client = JobClient(_docs())
    job = start(client, id=J, plan=pieces)
    seen = []
    state = {'n': 0}
    real = IgtRunner.record

    def record(self, project, document_id, doc, part, st, changed=frozenset(), vouched=frozenset(),
               made=frozenset()):
        seen.append((document_id, sorted(changed)))
        state['n'] += 1
        if state['n'] == 1:
            raise PlaidAPIError('HTTP 502', status=502)
        return real(self, project, document_id, doc, part, st, changed, vouched, made)
    monkeypatch.setattr(IgtRunner, 'record', record)
    use(monkeypatch, Model(planned(_analyse)))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', finished.get('reason')
    assert all(not ch for _, ch in seen), seen
