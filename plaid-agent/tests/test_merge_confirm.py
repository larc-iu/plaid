"""An approved word merge confirms the values core joined as machine output
(HUNT-model M1 after e11b8fc09). Core stamps a joined span by what it holds,
so two unverified machine glosses join as machine output, and the plan the
user approved confers verified, as on every other write it makes."""

import copy

from fixtures import GLOSS, FakeClient, document_raw, fake_ws

from plaid_agent.igt.plan import execute_plan
from plaid_agent.igt.toolkit import call_tool

MACHINE = {'prov': 'inferred', 'provSource': 'service:igt:gloss', 'provProb': 0.4}


def _client(stamp):
    doc = copy.deepcopy(document_raw())
    words = doc['text_layers'][0]['token_layers'][1]
    words['span_layers'][0]['spans'] += [
        {'id': 'sp-g2', 'value': 'fish', 'tokens': ['w-2'], 'metadata': dict(stamp)},
        {'id': 'sp-g3', 'value': 'saw', 'tokens': ['w-3'], 'metadata': dict(stamp)}]
    return FakeClient(documents={'d1': doc})


def _merged(client):
    ws = fake_ws(client)
    out = call_tool(ws, 'merge_words', {'document': 'Text 1', 'refs': ['s1.w2', 's1.w3']})
    assert 'Planned' in out, out
    execute_plan(client, ws.plan_payload()['ops'], source='service:igt:assist:x', label='Assistant: merge',
                 project=ws.project, stamp_mode='verified')
    return client


def test_a_join_of_machine_values_is_confirmed_by_the_approval():
    client = _merged(_client(MACHINE))
    assert client.payloads('tokens.merge') or any(k == 'tokens.merge' for k, _ in client.writes)
    patched = [(sid, ops) for sid, ops in client.patches('spans') if sid in ('sp-g2', 'sp-g3')]
    assert patched, client.writes
    [(sid, ops)] = patched
    assert {'op': 'set', 'path': ['provConfirmed'], 'value': True} in ops, ops
    # In a batch after the merge.
    kinds = [k for batch in client.batches for k, _ in batch]
    assert kinds.index('tokens.merge') < max(i for i, k in enumerate(kinds) if k == 'spans.bulk_update')


def test_a_join_a_person_made_is_left_as_core_stamped_it():
    client = _merged(_client({}))
    assert not [sid for sid, _ in client.patches('spans') if sid in ('sp-g2', 'sp-g3')]
