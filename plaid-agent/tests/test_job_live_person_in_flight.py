"""A person types in a document while a job's stretch is in flight, under a
real core (H14-1). The stretch's write lands after the person's edit, so the
newest History unit is the job's own: the document is still put off, the
other document is worked first, and the job takes the first one up again
only after the wait. The hunter's two sequences: the person types in a
sentence of the next stretch (s6), and in a sentence of the stretch in flight
(s1), whose write there is dropped as changed and which is taken again. And
the reviewer's two (REV-HFA-1, -2): a whole-selection piece, and a stretch
whose model fails and is halved, each with the person typing while it runs.
Their writes are put off under the lock: the person's value is still theirs
when the document is first put off.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import time
import uuid

import pytest

from fixtures import GLOSS
from job_fixtures import plan_row, Model, call, document, job_project, reply, targets_named, use
from live import _skip_or_fail, core_url, login, seed

from plaid_agent.core.agent import ModelConfig
from plaid_agent.core.job import Job, StretchFailed, run_job
from plaid_agent.core.limits import JOB_DEFER_WAIT_S
from plaid_agent.igt.job import IgtRunner
from plaid_agent.jobworker import count_chars

WORKER = '0193a5c0-0000-7000-8000-0000000000e1'
LINES = ['kai pele tuna', 'lo mo sa', 'nima rua kai', 'pele lo mo', 'tuna sa nima', 'rua kai pele', 'mo lo tuna']


@pytest.fixture
def world():
    try:
        admin = login()
    except Exception as e:  # noqa: BLE001
        _skip_or_fail(f'no core: {e}')
    from plaid_client import PlaidClient
    email = f'job-inflight-{uuid.uuid4().hex[:8]}@example.org'
    admin.users.create(email, 'job-inflight-pass-1', False)
    writer = PlaidClient.login(core_url(), email, 'job-inflight-pass-1')
    docs = {'d1': document('d1', 'Shared', [{'words': line.split()} for line in LINES]),
            'd2': document('d2', 'Zz other', [{'words': ['kai', 'pele']}, {'words': ['lo', 'mo']}])}
    lexicon = {'id': 'v1', 'name': 'Lexicon', 'project': 'p1', 'items': []}
    s = seed(admin, job_project(), docs, {'v1': lexicon}, name=f'job inflight {uuid.uuid4().hex[:6]}')
    admin.projects.add_writer(s.project_id, email)
    yield admin, writer, s
    s.delete()


@pytest.mark.parametrize('sentence', [6, 1])
def test_a_person_typing_while_a_stretch_is_in_flight_puts_the_document_off(world, monkeypatch, sentence):
    admin, writer, s = world
    from plaid_client import PlaidClient
    made = writer.jobs.create(s.project_id, 'igt', 'Gloss the first word of every sentence.')
    claimed = admin.jobs.claim(WORKER, 'fake/m', ['igt'])
    if claimed:
        admin.jobs.add_decisions(claimed['job']['id'], WORKER, [plan_row(fills=(GLOSS,), ids=s.ids)])
    assert claimed and claimed['job']['id'] == made['id']
    offset = {'s': 0.0}

    def sleep(seconds):
        offset['s'] += seconds
    job = Job(admin, claimed, WORKER, client_for=lambda token: PlaidClient(core_url(), token), model='fake/m',
              sleep=sleep, now=lambda: time.time() + offset['s'])
    person = s.ids[f'd1-s{sentence}w1']
    pieces = []

    def answer(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        name = asked.split('"')[1]
        named = targets_named(asked)
        pieces.append((name, named, offset['s']))
        if len(pieces) == 1:
            # The person types as the first stretch runs: its write lands after.
            writer.spans.create(s.ids[GLOSS], [person], 'PERSON')
            time.sleep(1.1)
        return reply(calls=[call(i, 'set_field', {'document': name, 'refs': [f's{k}.w1'], 'field': 'Gloss',
                                                  'value': f'JOB-{name[0]}{k}'})
                            for i, k in enumerate(named, start=1)])
    use(monkeypatch, Model(answer))
    runner = IgtRunner(job, ModelConfig(model='fake/m', stream=False, max_steps=1000), count=count_chars,
                       write_summary=False)
    finished = run_job(job, runner)
    assert finished['state'] == 'done', (finished.get('reason'), writer.jobs.get(made['id']).get('message'))
    names = [p[0] for p in pieces]
    assert names[:2] == ['Shared', 'Zz other'], f'Shared was put off after the stretch in flight: {pieces}'
    later = [p for p in pieces[2:] if p[0] == 'Shared']
    assert later and all(p[2] >= JOB_DEFER_WAIT_S - 1 for p in later), f'taken up again only after the wait: {pieces}'
    if sentence == 1:
        assert 1 in later[0][1], f's1, changed during the stretch, is taken again later: {pieces}'


def _gloss(admin, s, token):
    raw = admin.documents.get(s.ids['d1'], include_body=True)
    return next((sp['value'] for tl in raw['text_layers'] for tk in tl['token_layers']
                 for sl in tk.get('span_layers') or [] if sl['id'] == s.ids[GLOSS]
                 for sp in sl.get('spans') or [] if sp['tokens'] == [token]), None)


def _run_put_off(world, monkeypatch, pieces, answer):
    """The job run with ``answer`` as its model. What s4 of Shared held when
    Shared was first put off, and the job as it ended."""
    admin, writer, s = world
    from plaid_client import PlaidClient
    made = writer.jobs.create(s.project_id, 'igt', 'Gloss the first word of every sentence.')
    claimed = admin.jobs.claim(WORKER, 'fake/m', ['igt'])
    if claimed:
        admin.jobs.add_decisions(claimed['job']['id'], WORKER, [plan_row(pieces=pieces, fills=(GLOSS,), ids=s.ids)])
    assert claimed and claimed['job']['id'] == made['id']
    offset = {'s': 0.0}

    def sleep(seconds):
        offset['s'] += seconds
    job = Job(admin, claimed, WORKER, client_for=lambda token: PlaidClient(core_url(), token), model='fake/m',
              sleep=sleep, now=lambda: time.time() + offset['s'])
    use(monkeypatch, Model(answer))
    runner = IgtRunner(job, ModelConfig(model='fake/m', stream=False, max_steps=1000), count=count_chars,
                       write_summary=False)
    seen = []
    real = type(runner).defer

    def defer(self, d):
        if d == s.ids['d1'] and not seen:
            seen.append(_gloss(admin, s, s.ids['d1-s4w1']))
        return real(self, d)
    monkeypatch.setattr(type(runner), 'defer', defer)
    finished = run_job(job, runner)
    assert finished['state'] == 'done', (finished.get('reason'), writer.jobs.get(made['id']).get('message'))
    return seen


def test_a_halved_stretch_does_not_write_over_a_person_typing_during_its_failed_first_try(world, monkeypatch):
    admin, writer, s = world
    typed = []

    def answer(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        name = asked.split('"')[1]
        named = targets_named(asked)
        if name == 'Shared' and len(named) == 5:
            if not typed:
                typed.append(writer.spans.create(s.ids[GLOSS], [s.ids['d1-s4w1']], 'PERSON'))
                time.sleep(1.1)
            raise StretchFailed('output', 'too long')
        return reply(calls=[call(i, 'set_field', {'document': name, 'refs': [f's{k}.w1'], 'field': 'Gloss',
                                                  'value': f'JOB-{name[0]}{k}'})
                            for i, k in enumerate(named, start=1)])
    seen = _run_put_off(world, monkeypatch, 'sentences', answer)
    assert typed and seen == ['PERSON'], f'Shared put off with s4 still the person\'s: {seen}'


def test_a_selection_piece_does_not_write_over_a_person_typing_while_it_runs(world, monkeypatch):
    admin, writer, s = world
    typed = []

    def answer(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        if not typed:
            typed.append(writer.spans.create(s.ids[GLOSS], [s.ids['d1-s4w1']], 'PERSON'))
            time.sleep(1.1)
        return reply(calls=[call(i, 'set_field', {'document': 'Shared', 'refs': [f's{k}.w1'], 'field': 'Gloss',
                                                  'value': f'JOB-S{k}'}) for i, k in enumerate(range(1, 8), start=1)])
    seen = _run_put_off(world, monkeypatch, 'selection', answer)
    assert typed and seen == ['PERSON'], f'Shared put off with s4 still the person\'s: {seen}'
