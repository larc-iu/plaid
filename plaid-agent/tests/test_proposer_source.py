"""An applied plan's writes name the assistant that proposed it, in every app.

An assistant's service id carries its model (`umr:assist:openai-fake`). After
the operator restarted the service on another model, a plan proposed before
the restart and approved after it was stamped `provSource` of the service that
applied it next to `provDetail.model` of the one that proposed it, so a study
grouping by source credited the new model with the old one's change. Each turn
now records the service id it answered as, and the plan's writes and its
operation name that one (REV-A-MODEL, question 1, decided (a)).
"""

import pytest

import test_stale_by_sentence as sbs
from test_plan_record import _staged, _stored
from test_service_flow import Helper

from plaid_agent.core.agent import ModelConfig
from plaid_agent.core.conversation import ConversationStore


def _sources(client):
    out = []

    def walk(x):
        if isinstance(x, dict):
            if isinstance(x.get('provSource'), str):
                out.append(x['provSource'])
            if x.get('path') in (['provSource'], 'provSource') and isinstance(x.get('value'), str):
                out.append(x['value'])
            for v in x.values():
                walk(v)
        elif isinstance(x, (list, tuple)):
            for v in x:
                walk(v)
    for _, payload in client.calls:
        walk(payload)
    return out


@pytest.fixture(params=sorted(sbs.APPS))
def spec(request):
    return sbs.APPS[request.param]()


def test_a_plan_approved_after_a_restart_on_another_model_names_the_one_that_proposed_it(spec, monkeypatch):
    client = spec['client']()
    plan = _staged(spec, client, monkeypatch)
    proposer = f'{spec["app"]}:assist:fake'
    item = _stored(spec, client)
    assert item['service'] == proposer and item['model'] == 'fake/model'

    # The operator restarts the assistant on another model, and the user approves.
    svc = spec['service']()
    svc.cfg = ModelConfig(model='other/model')
    svc.service_id = f'{spec["app"]}:assist:other-model'
    written = len(client.calls)
    helper = Helper(request_id='r9')
    svc.process_request({'op': 'send', 'requester_client': client, 'requester_id': 'u@x', 'project_id': spec['pid'],
                         'conversation_id': 'c1', 'op': 'approve', **{'plan_id': plan['id']}}, helper)
    assert helper.done and helper.done[-1]['kind'] == 'applied', helper.errors
    client.calls[:] = client.calls[written:]
    sources = _sources(client)
    assert sources, 'the plan wrote no stamp'
    assert set(sources) == {f'service:{proposer}'}, sources
    [tags] = [t for t in client.operation_tags if t.get('kind') == 'assistant-plan']
    assert tags['ref'] == f'conv:c1/plan:{plan["id"]}/service:{proposer}'


def test_a_plan_staged_before_turns_named_their_service_is_refused_with_a_message(spec, monkeypatch):
    """A plan staged before each turn recorded its service id, and still
    undecided, cannot say who proposed it. Approving it failed with a bare
    KeyError from inside the document locks, and the card stayed approvable,
    so every Approve failed the same way. It is refused as out of date, with a
    sentence, and nothing is written."""
    client = spec['client']()
    plan = _staged(spec, client, monkeypatch)
    store = ConversationStore(client, 'u@x', spec['pid'], spec['app'])
    conv, meta = store.load('c1')
    del conv['display'][1]['service']
    store.save('c1', conv, meta)

    svc = spec['service']()
    svc.cfg = ModelConfig(model='fake/model')
    svc.service_id = f'{spec["app"]}:assist:fake'
    written = len(client.calls)
    helper = Helper(request_id='r9')
    svc.process_request({'op': 'send', 'requester_client': client, 'requester_id': 'u@x', 'project_id': spec['pid'],
                         'conversation_id': 'c1', 'op': 'approve', **{'plan_id': plan['id']}}, helper)
    assert not helper.done
    [said] = helper.errors
    assert said.startswith('Nothing was written.') and 'plan again' in said, said
    assert 'KeyError' not in said and "'service'" not in said, said
    assert not [t for t in client.operation_tags if t.get('kind') == 'assistant-plan']
    assert not _sources(type('Calls', (), {'calls': client.calls[written:]})), 'the plan wrote'
    # Settled, so the card stops offering an Approve that can only fail again.
    assert _stored(spec, client)['status'] == 'stale'
