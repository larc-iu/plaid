"""A job a worker took up again (claimed with a phase: an earlier worker
ran it) reports its pause times as not known, null, as core's own report
does (D17 of the job review 2026-11-18): this worker's waits are only part
of them, while the elapsed time covers the whole run."""

from job_fixtures import JobClient, document, start

from plaid_agent.core.job import Job, build_report


def test_a_resumed_jobs_report_says_its_pause_times_are_not_known():
    client = JobClient({'d1': document('d1', 'Story 1', [{'words': ['ka']}])})
    job = start(client)
    job.paused['people'] = 300.0
    fresh = build_report(job, 'done', None, [], {}, {})
    assert fresh['paused_for_people_s'] == 300 and fresh['paused_for_edits_s'] == 0
    again = Job(client, {'job': {**job.job, 'phase': 'working'}, 'token': job.token}, 'worker-2',
                client_for=lambda token: client)
    again.paused['people'] = 300.0
    report = build_report(again, 'done', None, [], {}, {})
    assert (report['paused_for_people_s'], report['paused_for_model_s'], report['paused_for_edits_s']) == \
        (None, None, None)
