"""Planted-faults campaign PF, lane 7 (2026-11-19): the fake's jobs held to a
rule of core's that the jobs tests let go."""

from test_jobs import _fake


def test_fake_every_end_settles_a_deferred_row_not_reached_as_core_does():
    """Core settles every row the job did not finish, a deferred one among
    them (``plaid.sql.job``, waiting, working and deferred), at every end."""
    client, _ = _fake()
    jobs = client.jobs
    for to in ('done', 'cancelled', 'failed'):
        job = jobs.create('p1', 'igt', 'Gloss.')
        jobs.claim('w1', 'm', ['igt'])
        jobs.update_document(job['id'], 'd2', 'w1', state='done')
        jobs.update_document(job['id'], 'd1', 'w1', state='deferred', defers=1)
        ended = jobs.finish(job['id'], 'w1', to, {})
        assert [r['state'] for r in ended['documents']] == ['done', 'not-reached'], to
