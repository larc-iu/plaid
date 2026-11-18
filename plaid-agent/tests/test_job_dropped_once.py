"""The count of proposed changes past the cap is the same however often a
call that kept it is made again (REV-JR1-11): core adds a row's count on
every call, and a call that landed with its answer lost is made again by
``through_core``. Each change past the cap is a row of its own, counted
once, so a resend, or the same change proposed again, never grows it."""

from job_fixtures import JobClient, document, runner, start

from plaid_client import PlaidAPIError
from plaid_agent.core import job as core_job
from plaid_agent.igt import job as igt_job


def test_a_resent_call_never_grows_the_count_of_changes_past_the_cap(monkeypatch):
    monkeypatch.setattr(igt_job, 'JOB_CHANGES_MAX', 1)
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka']}])})
    job = start(client)
    real = client.jobs.add_decisions
    lost = {'n': 1}

    def add_decisions(job_id, worker_id, rows):
        out = real(job_id, worker_id, rows)
        if lost['n']:
            # It landed, and its answer was lost.
            lost['n'] -= 1
            raise PlaidAPIError('HTTP 502', status=502)
        return out
    client.jobs.add_decisions = add_decisions
    r = runner(job)
    changes = [{'kind': 'set_field', 'document_id': None, 'label': f'change {i}'} for i in range(3)]
    core_job.through_core(job, lambda: r.record_changes(changes))
    r.record_changes(changes[1:])
    parts = runner(job).report_parts(job)
    assert len(parts['proposed']) == 1 and parts['proposed_dropped'] == 2, parts
