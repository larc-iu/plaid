"""Apply again sends what the first run sent, however it is approved (H14-APPROVE-1).

A run again resends the first run's batches under the same Idempotency-Keys,
and the core refuses a used key with another body (422
``idempotency-key-reused``). The stamp a run writes (verified, human-made, a
contributor's) is part of each body, so a run again that took it from the new
request, or from the project's review setting as it is now, was refused for
good once the card's box (unticked after a reload) or the setting differed
from the first run. The first run's stamp is kept in the writing mark and a
run again uses it.
"""

import copy

import pytest

from plaid_client import testing as fake_mod

import test_lost_answers as la
import test_stale_by_sentence as sbs

from plaid_agent.core import plan as core_plan
from plaid_agent.core import service as service_mod
from plaid_agent.core.conversation import ConversationStore, find_plan
from plaid_agent.core.plan import WRITING
from plaid_agent.core.approval import _failure
from plaid_agent.core.plan import PlanError
from plaid_client.http import PlaidAPIError
from test_service_flow import Helper
from plaid_agent.core.agent import ModelConfig


def _approve(spec, client, plan, as_human):
    svc = spec['service']()
    svc.cfg = ModelConfig(model='fake/model')
    svc.service_id = f'{spec["app"]}:assist:fake'
    helper = Helper(request_id='r9')
    svc.process_request({'requester_client': client, 'requester_id': 'u@x',
                         'project_id': spec['pid'], 'delegated_projects': [spec['pid']], 'conversation_id': 'c1',
                         'op': 'approve', 'plan_id': plan['id'], 'as_human': as_human}, helper)
    return helper


def _sends(monkeypatch):
    sent = []
    real = fake_mod._Batch.submit

    def submit(batch):
        sent.append(repr(batch.queued))
        return real(batch)
    monkeypatch.setattr(fake_mod._Batch, 'submit', submit)
    return sent


def _item(client, spec, plan):
    conv, _ = ConversationStore(client, 'u@x', spec['pid'], spec['app']).load('c1')
    return find_plan(conv, plan['id'])[1]


# (first run's box, review setting) then (the run again's box, review setting).
CASES = {
    'human then unticked': ((True, False), (False, False)),
    'verified then ticked': ((False, False), (True, False)),
    'contributed then review lifted': ((False, True), (False, False)),
    'verified then reviewed': ((False, False), (False, True)),
}


@pytest.mark.parametrize('app', ['igt', 'ud'])
@pytest.mark.parametrize('case', sorted(CASES))
def test_apply_again_sends_the_first_runs_stamp_whatever_it_is_asked(app, case, monkeypatch):
    (first_human, first_reviewed), (again_human, again_reviewed) = CASES[case]
    spec = sbs.APPS[app]()
    client = spec['client']()
    plan, _ = sbs._plan(spec, client)
    sent = _sends(monkeypatch)
    reviewed = {'now': first_reviewed}
    monkeypatch.setattr(service_mod.BaseAssistantService, '_reviewed',
                        staticmethod(lambda *a: reviewed['now']))
    record = {}
    real = core_plan.Batcher.flush

    def lost(self):
        # The batch commits, the service stops before the record says so.
        real(self)
        record.update(copy.deepcopy(client.user_data.store))
        raise la._lost()

    monkeypatch.setattr(core_plan.Batcher, 'flush', lost)
    _approve(spec, client, plan, first_human)
    first = list(sent)
    assert first and record
    monkeypatch.setattr(core_plan.Batcher, 'flush', real)
    # The restart: the record as the first run left it, the plan interrupted.
    sbs._edit(client, spec, spec['same'])
    client.user_data.store.clear()
    client.user_data.store.update(record)
    del sent[:]
    reviewed['now'] = again_reviewed
    helper = _approve(spec, client, plan, again_human)
    assert not helper.errors, helper.errors
    assert sent[:len(first)] == first, 'the run again sends, under each key, what the first run sent'
    item = _item(client, spec, plan)
    assert item['status'] == 'applied'
    assert item['as_human'] is (first_human and not first_reviewed)
    assert bool(item.get('contributed')) is first_reviewed


def test_the_writing_mark_names_the_stamp_and_the_contributor(monkeypatch):
    monkeypatch.setattr(core_plan, 'held_from', lambda *a: False)
    plan = {}
    core_plan.writing(None, plan, [], lambda: True, run='r1', ops=[], stamp='contributed', contributor='u@x')
    assert plan[WRITING]['stamp'] == 'contributed' and plan[WRITING]['contributor'] == 'u@x'
    assert core_plan.stamp_of(plan[WRITING]) == ('contributed', 'u@x')
    assert core_plan.stamp_of({'run': 'r1', 'inside': True}) is None


def test_a_reused_key_is_said_in_words_the_user_can_act_on():
    refused = PlaidAPIError('HTTP 422 idempotency-key-reused', status=422, url='http://h/api/v1/batch',
                            method='POST', response_data={'error': 'idempotency-key-reused'})
    try:
        raise PlanError('HTTP 422 idempotency-key-reused', 0, 1) from refused
    except PlanError as e:
        said = _failure(None, [], e)
    assert 'idempotency' not in said and '422' not in said
    assert said == 'an earlier run of this plan wrote some of it differently'
