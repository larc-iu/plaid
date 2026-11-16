"""While a job plans, its line says how many of its documents a read has
printed to the planning so far, from the planning's own workspace (RPF3-E,
RP2-1 finding 6: eight minutes of "Planning the work. N steps." alone)."""

from job_fixtures import PLANNING_ENDS, JobClient, Model, call, document, reply, runner, start, use

from plaid_agent.core.job import run_job


def test_the_planning_line_counts_the_documents_read(monkeypatch):
    client = JobClient({'d1': document('d1', 'Story 1', [{'words': ['ka']}]),
                        'd2': document('d2', 'Story 2', [{'words': ['sa']}])})
    job = start(client, 'Gloss.', id='JPL', plan=None)
    lines = []

    def answer(asked, n, kwargs):
        if str(asked).rstrip().endswith(PLANNING_ENDS):
            lines.append(job.status.get('message'))
            if n == 1:
                return reply(calls=[call(1, 'read_document', {'document': 'Story 1'})])
            if n == 2:
                return reply(calls=[call(2, 'plan_work', {'pieces': 'sentences', 'fills': ['segmentation']})])
            return reply('Planned.')
        return reply('Done.')
    use(monkeypatch, Model(answer))
    run_job(job, runner(job))
    assert lines[:3] == ['Planning the work.', 'Planning the work. 1 step.',
                         'Planning the work. 1 of 2 documents read. 2 steps.'], lines
