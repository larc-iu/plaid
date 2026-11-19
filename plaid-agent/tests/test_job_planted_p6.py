"""Planted-faults campaign PF, lane 6 (core/job.py): the tests for the faults
planted in the job's frame that the job test set did not notice. Each fails
with its fault planted and passes on the clean code."""

from job_fixtures import JobClient, Model, call, document, every_tool, reply, runner, start, use

from plaid_client import PlaidAPIError
from plaid_agent.core import job as core_job
from plaid_agent.core.job import run_job


def test_the_sent_budget_counts_what_every_call_of_the_stretch_sent(monkeypatch):
    """Each call's prompt counts 100 tokens against a stretch budget of 250:
    the third call would pass it, so the piece is closed there, never left to
    run to its calls' budget (the tokens sent are summed over the stretch)."""
    from test_job_closing import _closing, _model
    from job_fixtures import blank
    client = JobClient({'d1': document('d1', 'Story', blank(2))})
    job = start(client, id='JP6A', plan='sentences')
    r = runner(job)
    r.count = lambda value: 50
    monkeypatch.setattr(core_job, 'JOB_STRETCH_MAX_SENT_TOKENS', 250)
    model = use(monkeypatch, _model(closing=lambda kwargs: reply('Closed.')))
    finished = run_job(job, r)
    assert finished['state'] == 'done'
    assert [_closing(c['kwargs']) for c in model.calls] == [False, False, True], \
        'two calls sent 200 tokens, the third would pass 250: it is the closing call'


def test_a_403_whose_heartbeat_core_does_not_answer_ends_the_job_as_access_lost(monkeypatch):
    """Core refuses the starter's token a write (403) and the heartbeat that
    asks whether the starter still writes does not get through: that
    decides nothing, and the job ends failed starter-access as before, never
    as the worker's own error (Job.access_lost)."""
    from test_job_access import _analyse, _client, _refuse_lock
    client = _client()
    job = start(client)
    use(monkeypatch, Model(_analyse))
    _refuse_lock(client, PlaidAPIError('HTTP 403', status=403, response_data={'error': 'Write access required.'}))

    def heartbeat(*a, **kw):
        raise PlaidAPIError('HTTP 503', status=503)
    client.jobs.heartbeat = heartbeat
    finished = run_job(job, runner(job))
    assert finished['state'] == 'failed' and finished['reason'] == 'starter-access', finished.get('reason')


def test_a_stop_heard_at_the_harmonizing_heartbeat_never_starts_harmonize(monkeypatch):
    """The heartbeat that says the phase changed is the first to hear of a
    stop: the frame asks again before harmonize starts, whatever the app's
    harmonize checks itself (SPEC 1.3: nothing more is written)."""
    from test_job_stop import _ended_cancelled, _harmonize_job
    client, job = _harmonize_job(monkeypatch)
    job.status['phase'] = 'working'
    r = runner(job)
    r.work = lambda j: client.jobs.cancel(j.id)
    called = []
    r.harmonize = lambda j: called.append(j.id) or {'changed': [], 'left': []}
    _ended_cancelled(client, job, run_job(job, r))
    assert called == [], 'harmonize was started after the stop was heard'


def test_the_total_of_proposed_changes_counts_those_past_the_reports_list(monkeypatch):
    """Three guidelines proposed with room to list one: the report lists one
    and its total says three (proposed and proposed_more)."""
    from plaid_agent.igt import job as igt_job
    every_tool(monkeypatch)
    monkeypatch.setattr(igt_job, 'JOB_CHANGES_MAX', 1)
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['blank']}])})
    job = start(client, 'Propose guidelines.', id='JP6D')

    def answer(asked, n, kwargs):
        if n == 1:
            return reply(calls=[call(1, 'guidelines', {'action': 'help'})])
        if n == 2:
            return reply(calls=[call(10 + i, 'guidelines', {'action': 'add', 'title': f'Rule {i}',
                                                             'body': f'Gloss rule {i}.'}) for i in range(3)])
        return reply('Proposed three guidelines.')
    use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    report = finished['report']
    assert len(report['proposed']) == 1 and report['proposed_more'] == 2, (report['proposed'], report['proposed_more'])
    assert report['totals']['proposed'] == 3
