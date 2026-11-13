"""A person reshaping what the job wrote, under a real core (REV-B4-1): the
starter splits a sentence the job wrote and clears the job's proposal in the
right half, whose id is new. The job knows the half's words, and writes
nothing there again.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import time
import uuid

import pytest

from fixtures import MORPH_LAYER, SENT_LAYER
from job_fixtures import Model, call, document, job_project, reply, targets_named, use
from live import _skip_or_fail, core_url, login, seed

from plaid_agent.core.agent import ModelConfig
from plaid_agent.core.job import Job, run_job
from plaid_agent.igt import job as igt_job
from plaid_agent.igt.job import RECORD_FORM, IgtRunner
from plaid_agent.jobworker import count_chars

WORKER = '0193a5c0-0000-7000-8000-0000000000c5'


@pytest.fixture
def world():
    try:
        admin = login()
    except Exception as e:  # noqa: BLE001
        _skip_or_fail(f'no core: {e}')
    from plaid_client import PlaidClient
    email = f'job-reshape-{uuid.uuid4().hex[:8]}@example.org'
    admin.users.create(email, 'job-reshape-pass-1', False)
    writer = PlaidClient.login(core_url(), email, 'job-reshape-pass-1')
    docs = {'d1': document('d1', 'Story', [{'words': ['ka', 'ta', 'pa']}, {'words': ['sa']}])}
    lexicon = {'id': 'v1', 'name': 'Lexicon', 'project': 'p1', 'items': []}
    s = seed(admin, job_project(), docs, {'v1': lexicon}, name=f'job reshape {uuid.uuid4().hex[:6]}')
    admin.projects.add_writer(s.project_id, email)
    yield admin, writer, s
    s.delete()


def _gloss(asked, n, kwargs):
    if n > 1:
        return reply('Done.')
    calls, i = [], 0
    for s in targets_named(asked):
        for w in range(1, 4):
            i += 1
            calls.append(call(i, 'set_analysis', {'document': 'Story', 'ref': f's{s}.w{w}', 'morphemes': [
                {'form': 'x', 'fields': {'Morph Gloss': f'go{s}{w}'}}]}))
    return reply(calls=calls)


def _layer_tokens(raw, layer_id):
    return [t for tl in raw['text_layers'] for tk in tl['token_layers'] if tk['id'] == layer_id
            for t in tk.get('tokens') or []]


def _job(admin, writer, s):
    from plaid_client import PlaidClient
    made = writer.jobs.create(s.project_id, 'igt', ['gloss'])
    claimed = admin.jobs.claim(WORKER, 'fake/m', ['igt'])
    assert claimed and claimed['job']['id'] == made['id']
    offset = {'s': 0.0}
    return Job(admin, claimed, WORKER, client_for=lambda token: PlaidClient(core_url(), token), model='fake/m',
               sleep=lambda sec: offset.__setitem__('s', offset['s'] + sec), now=lambda: time.time() + offset['s'])


def test_a_split_after_the_cursor_and_a_cleared_proposal_is_not_glossed_again(world, monkeypatch):
    admin, writer, s = world
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 1)
    use(monkeypatch, Model(_gloss))
    job = _job(admin, writer, s)
    d1 = s.ids['d1']
    real = job.add_decisions
    done = {}

    def add(decisions):
        out = real(decisions)
        if not done and any(d['form'] == RECORD_FORM + s.ids['d1-s1'] for d in decisions):
            # The starter splits s1 before "pa" (igt's Split sentence: the
            # left half keeps the id) and clears the job's analysis of pa.
            raw = admin.documents.get(d1, include_body=True)
            pa = next(t for t in _layer_tokens(raw, s.ids[MORPH_LAYER]) if t['begin'] == 6)
            done['new'] = writer.tokens.split(s.ids['d1-s1'], 6)
            writer.tokens.delete(pa['id'])
        return out
    monkeypatch.setattr(job, 'add_decisions', add)
    runner = IgtRunner(job, ModelConfig(model='fake/m', stream=False, max_steps=1000), count=count_chars)
    finished = run_job(job, runner)
    assert finished['state'] == 'done'
    assert done.get('new'), 'the starter split and cleared'
    raw = admin.documents.get(d1, include_body=True)
    assert len(_layer_tokens(raw, s.ids[SENT_LAYER])) == 3
    morphs = _layer_tokens(raw, s.ids[MORPH_LAYER])
    assert not [t for t in morphs if t['begin'] == 6], 'pa is left as the starter left it'
    assert [t['begin'] for t in morphs] == [0, 3, 10], 'ka, ta and sa are the job\'s'
