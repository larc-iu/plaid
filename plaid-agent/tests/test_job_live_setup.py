"""A job set up in a conversation, on a real core (BRIEF-SU): the person's
writer client starts the Thematic role job of test_job_live_fields with a
``setup`` that lets it fill Thematic role only, as the page sends it, and the
worker reads it back from core's claim. Each way: a plan inside the setup is
worked, a plan naming another field is refused and corrected, a plan refused
to the end ends the job with no plan and nothing written.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import time

from job_fixtures import Model, call, reply, use
from live import core_url
from test_job_fields import GUIDELINE, INSTRUCTIONS, ROLE, ROLE_NAME, _fill, _piece_words
from test_job_live_entries import WORKER, _runner
from test_job_live_fields import _roles, world  # noqa: F401 (the fixture)

from plaid_agent.core.job import Job, run_job

PLANNING = 'Plan the job and end with plan_work.'
LINE = f'This job was set up to fill only "{ROLE_NAME}". It may not edit the text.'
INSIDE = {'pieces': 'sentences', 'fills': [ROLE_NAME]}
OUTSIDE = {'pieces': 'sentences', 'fills': [ROLE_NAME, 'Translation']}


def _job(admin, writer, s, plans, monkeypatch):
    from plaid_client import PlaidClient
    writer.guidelines.create(s.project_id, 'Thematic role', body=GUIDELINE)
    setup = {'fills': [{'id': s.ids[ROLE], 'name': ROLE_NAME}], 'text': False, 'conversation': 'c1'}
    made = writer.jobs.create(s.project_id, 'igt', INSTRUCTIONS, setup=setup)
    assert made['setup'] == setup, made
    claimed = admin.jobs.claim(WORKER, 'fake/m', ['igt'])
    assert claimed and claimed['job']['id'] == made['id'] and claimed['job']['setup'] == setup
    piece = _fill(_piece_words)

    def answer(asked, n, kwargs):
        if asked.rstrip().endswith(PLANNING):
            plan = plans[n - 1] if n - 1 < len(plans) else None
            return reply(calls=[call(90 + n, 'plan_work', plan)]) if plan is not None else reply('Planned.')
        return piece(asked, n, kwargs)
    model = use(monkeypatch, Model(answer))
    offset = {'s': 0.0}

    def wait(sec):
        offset['s'] += sec
    job = Job(admin, claimed, WORKER, client_for=lambda token: PlaidClient(core_url(), token), model='fake/m',
              sleep=wait, now=lambda: time.time() + offset['s'])
    return job, model


def _planning(model):
    return [c for c in model.calls if c['asked'].rstrip().endswith(PLANNING)]


def _refusals(model):
    return [m.get('content') for c in _planning(model) for m in c['kwargs']['messages']
            if m['role'] == 'tool' and str(m.get('content')).startswith('Error')]


def test_a_plan_inside_the_setup_is_worked(world, monkeypatch):  # noqa: F811
    admin, writer, s = world
    job, model = _job(admin, writer, s, [INSIDE], monkeypatch)
    finished = run_job(job, _runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
    assert LINE in _planning(model)[0]['asked']
    assert _refusals(model) == []
    assert len(_roles(admin, s)) == 9, 'Thematic role filled on every word'
    assert admin.jobs.get(job.id)['report']['plan']['fills_names'] == [ROLE_NAME]


def test_a_plan_refused_for_its_setup_then_corrected_is_worked(world, monkeypatch):  # noqa: F811
    admin, writer, s = world
    job, model = _job(admin, writer, s, [OUTSIDE, INSIDE], monkeypatch)
    finished = run_job(job, _runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
    (refused,) = set(_refusals(model))  # each later call carries the transcript
    assert refused.startswith(f'Error: fills: this job was set up to fill only "{ROLE_NAME}". Leave out '
                              '"Translation".'), refused
    assert len(_roles(admin, s)) == 9


def test_a_plan_refused_for_its_setup_to_the_end_ends_with_no_plan(world, monkeypatch):  # noqa: F811
    admin, writer, s = world
    job, model = _job(admin, writer, s, [OUTSIDE], monkeypatch)
    finished = run_job(job, _runner(job))
    assert finished['state'] == 'failed' and finished['reason'] == 'no-plan', finished
    assert _refusals(model), 'refused'
    assert all(c['asked'].rstrip().endswith(PLANNING) for c in model.calls), 'no piece'
    assert _roles(admin, s) == {}, 'nothing written'
    read = admin.jobs.get(job.id)
    assert read['report']['plan']['by'] == 'none' and read['setup']['fills'][0]['name'] == ROLE_NAME
