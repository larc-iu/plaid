"""What goes wrong in a stretch that is not the model's (REV-J-B S2-3): only
a failure of the model's work is halved (SPEC 3.6). Core busy or out of
reach is tried again with a growing wait and the document is then put off,
core saying the job is no longer this worker's stops it, and anything else
fails the job with what happened, never skipping sentences. A write that
landed is counted once and its decisions are stored once, whatever crashes
between the write, the decisions and the row."""

import json

import pytest

from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_client import PlaidAPIError
from plaid_agent.core import job as core_job
from plaid_agent.core.plan import PlanError
from plaid_agent.core.job import failure_kind, run_job
from plaid_agent.core.limits import JOB_CORE_TRIES, JOB_CORE_WAIT_S
from plaid_agent.igt import job as igt_job
RECORD_FORM = ' sentence '  # a sentence's record among the decisions (CONTRACT, added by J-FIX-B)
WRITING_FORM = ' writing '  # a sentence the job is about to write in (CONTRACT, added by J-FIX-B4)

J = 'JE'


@pytest.mark.parametrize('e', [PlaidAPIError('HTTP 500', status=500), PlaidAPIError('HTTP 409', status=409),
                               KeyError('x'), ConnectionResetError('reset'), ValueError('bug')])
def test_nothing_but_the_models_own_failure_is_a_stretch_failure(e):
    assert failure_kind(e) is None


def _analyse(asked, n, kwargs):
    if n > 1:
        return reply('Done.')
    calls = []
    for line in asked.splitlines():
        if line.startswith('Targets in s'):
            s = line.split()[2].rstrip(':')
            for w in line.split('words ')[1].split(' and ')[0].split(', ') if 'words ' in line else []:
                ref, form = w.split(' ')[0], w.split('"')[1]
                calls.append(call(len(calls) + 1, 'set_analysis', {
                    'document': 'Story', 'ref': f'{s}.{ref}',
                    'morphemes': [{'form': form, 'type': 'stem', 'fields': {'Morph Gloss': 'G'}}]}))
    return reply(calls=calls)


BEFORE = [{'words': ['ka']}, {'words': ['ta']}]
AFTER = [{'words': [('ka', [('ka', 'G')], J)]}, {'words': [('ta', [('ta', 'G')], J)]}]


def _job(after=AFTER):
    client = JobClient({'d1': document('d1', 'Story', BEFORE)})
    client.after_write['d1'] = document('d1', 'Story', after, version=2)
    clock = {'t': 1_800_000_000.0, 'slept': []}

    def sleep(s):
        clock['slept'].append(s)
        clock['t'] += s
    job = start(client, ['gloss'], id=J, now=lambda: clock['t'])
    job._sleep = sleep
    job.update_row('d1', targets=2)
    return client, job, clock


def _real_rows(client):
    return {k: v for k, v in client.jobs.decision_rows.get(J, {}).items()}


def _decided(client):
    return {form: r['count'] for (form, key), r in _real_rows(client).items()
            if not form.startswith((RECORD_FORM, WRITING_FORM))}


def _targets_asked(model):
    return [c['asked'].splitlines()[-1] for c in model.calls if c['n'] == 1]


def test_a_core_error_on_the_write_is_tried_again_and_never_halved(monkeypatch):
    client, job, clock = _job()
    model = use(monkeypatch, Model(_analyse))
    real = igt_job.execute_plan
    left = {'n': 1}

    def execute(c, ops, **kw):
        if left['n']:
            left['n'] -= 1
            # As execute_plan says it: nothing landed.
            raise PlanError('HTTP 500', 0, len(ops)) from PlaidAPIError('HTTP 500', status=500)
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    assert runner(job).document('d1') == 'done'
    assert _targets_asked(model) == ['Analyse s1, s2.', 'Analyse s1, s2.'], 'asked again whole, never halved'
    assert not job.rows['d1'].get('skipped')
    assert sum(clock['slept']) == JOB_CORE_WAIT_S


def test_core_out_of_reach_for_long_puts_the_document_off(monkeypatch):
    client, job, clock = _job()
    use(monkeypatch, Model(_analyse))

    def execute(c, ops, **kw):
        # As execute_plan says it: no answer came, so it may have landed.
        raise PlanError('Network error', 0, len(ops), unknown=True) from PlaidAPIError('Network error', status=0)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    assert runner(job).document('d1') == 'deferred'
    assert not job.rows['d1'].get('skipped') and job.rows['d1']['state'] == 'deferred'
    assert sum(clock['slept']) == sum(JOB_CORE_WAIT_S * n for n in range(1, JOB_CORE_TRIES))


def test_a_fault_with_no_rule_fails_the_job_with_what_happened(monkeypatch):
    client, job, clock = _job()
    use(monkeypatch, Model(_analyse))

    def execute(c, ops, **kw):
        raise KeyError('morphemes')
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    finished = run_job(job, runner(job))
    assert finished['state'] == 'failed' and finished['reason'] == 'worker-error'
    assert "'morphemes'" in client.jobs.rows[J]['message']
    assert not job.rows['d1'].get('skipped'), 'no sentence was skipped for it'


def test_a_core_error_in_a_read_tool_is_not_told_to_the_model_as_its_own(monkeypatch):
    client, job, clock = _job()

    def answer(asked, n, kwargs):
        if n == 1:
            return reply(calls=[call(1, 'search', {'pattern': 'ka'})])
        return reply('Done.')
    model = use(monkeypatch, Model(answer))
    monkeypatch.setattr(job.admin, 'query', lambda body: (_ for _ in ()).throw(PlaidAPIError('HTTP 502', status=502)),
                        raising=False)
    from plaid_agent.igt import toolkit
    real = toolkit.call_tool

    def call_tool(ws, name, args):
        if name == 'search':
            raise PlaidAPIError('HTTP 502', status=502)
        return real(ws, name, args)
    monkeypatch.setattr(toolkit, 'call_tool', call_tool)
    assert runner(job).document('d1') == 'deferred'
    assert all(m.get('role') != 'tool' for c in model.calls for m in c['kwargs']['messages']), \
        'the model never heard of core\'s trouble'


def test_an_analysis_longer_than_core_keeps_is_counted_and_not_sent_as_a_decision(monkeypatch):
    long_gloss = 'x' * 4100
    after = [{'words': [('ka', [('ka', long_gloss)], J)]}, {'words': [('ta', [('ta', 'G')], J)]}]
    client, job, clock = _job(after)
    use(monkeypatch, Model(_analyse))
    assert runner(job).document('d1') == 'done'
    row = job.rows['d1']
    assert row['counts']['words'] == 2 and row['done'] == 2 and row['targets'] == 2
    assert _decided(client) == {'ta': 1}


class Crash(BaseException):
    """The worker's process dies here."""


def _resume(client, job, monkeypatch):
    """A new worker process resuming the job: the rows as core has them."""
    job.rows = {r['document_id']: dict(r) for r in client.jobs.get(J)['documents']}
    model = use(monkeypatch, Model(_analyse))
    assert runner(job).document('d1') == 'done'
    return model


def _crash_at(monkeypatch, job, where):
    if where == 'decisions':
        real = job.add_decisions

        def add(decisions):
            # The record's call, after the write: the writing row before it lands.
            if any(d['form'].startswith(RECORD_FORM) for d in decisions):
                raise Crash()
            return real(decisions)
        monkeypatch.setattr(job, 'add_decisions', add)
        return lambda: monkeypatch.setattr(job, 'add_decisions', real)
    real = job.update_row

    def update(document_id, **fields):
        if 'counts' in fields and fields.get('done'):
            raise Crash()
        return real(document_id, **fields)
    monkeypatch.setattr(job, 'update_row', update)
    return lambda: monkeypatch.setattr(job, 'update_row', real)


@pytest.mark.parametrize('where', ['decisions', 'row', 'after'])
def test_a_crash_anywhere_between_the_write_and_its_record_counts_the_write_once(monkeypatch, where):
    client, job, clock = _job()
    use(monkeypatch, Model(_analyse))
    undo = _crash_at(monkeypatch, job, where) if where != 'after' else (lambda: None)
    try:
        runner(job).document('d1')
    except Crash:
        pass
    undo()
    model = _resume(client, job, monkeypatch)
    assert not model.calls, 'the words written are not asked again'
    assert _decided(client) == {'ka': 1, 'ta': 1}, 'each decision stored once'
    row = client.jobs.get(J)['documents'][0]
    assert row['counts']['words'] == 2 and row['done'] == 2 and row['targets'] == 2


def test_decisions_that_landed_before_core_answered_an_error_are_not_sent_again(monkeypatch):
    client, job, clock = _job()
    use(monkeypatch, Model(_analyse))
    real = client.jobs.add_decisions
    left = {'n': 1}

    def add(job_id, worker_id, decisions):
        real(job_id, worker_id, decisions)
        if left['n']:
            left['n'] -= 1
            raise PlaidAPIError('HTTP 502', status=502)
    client.jobs.add_decisions = add
    assert runner(job).document('d1') == 'done'
    assert _decided(client) == {'ka': 1, 'ta': 1}
    assert job.rows['d1']['counts']['words'] == 2 and job.rows['d1']['done'] == 2


def test_a_record_is_a_mark_with_the_sentences_counts():
    client, job, clock = _job()
    r = runner(job)
    r.commit('d1', [{'sentence': 'd1-s1', 'counts': {'words': 1}, 'decisions': []}], {})
    marks = [v for (form, key), v in _real_rows(client).items() if form.startswith(RECORD_FORM)]
    assert len(marks) == 1 and json.loads(marks[0]['analysis'])['counts'] == {'words': 1}
    assert marks[0]['form'] == ' sentence d1-s1' and core_job.analysis_key(marks[0]['analysis']) == marks[0]['key']
