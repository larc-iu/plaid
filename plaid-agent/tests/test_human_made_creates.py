"""A plan approved with "Record as human-made" writes no provenance, and a
row it creates is sent with no metadata or an empty map, never a null, which
core refuses ("metadata: invalid type") and which failed the whole plan. The
fake client refuses a null on a create as core does (bench note 5)."""

import pytest

from fixtures import FakeClient, scan_ws
from ud_fixtures import PID, ud_client

from plaid_agent.igt.plan import execute_plan as igt_execute
from plaid_agent.igt.toolkit import call_tool as igt_call
from plaid_agent.ud.plan import execute_plan as ud_execute
from plaid_agent.ud.project import load_project
from plaid_agent.ud.toolkit import call_tool as ud_call
from plaid_agent.ud.tools import Workspace


@pytest.fixture
def ud_ws():
    client = ud_client()
    return Workspace(client, load_project(client, PID))


def _metadata_of(entry):
    """What a create sent as its metadata: the map, or None when the key was
    left out. A null sent is refused by the fake before this is read."""
    args, kwargs = entry['args'], entry['kwargs']
    return kwargs.get('metadata', args[4] if len(args) > 4 else None)


def test_the_fake_refuses_a_null_metadata_on_a_create_as_core_does():
    from plaid_client import PlaidAPIError
    c = FakeClient()
    with pytest.raises(PlaidAPIError, match='metadata: invalid type'):
        c.relations.create('L', 'a', 'b', 'nsubj', None)
    with pytest.raises(PlaidAPIError, match='metadata: invalid type'):
        c.spans.bulk_create([{'span_layer_id': 'L', 'tokens': ['t'], 'value': 'v', 'metadata': None}])
    c.relations.create('L', 'a', 'b', 'nsubj', {})
    c.relations.create('L', 'a', 'b', 'nsubj')


def test_a_new_head_approved_as_human_made_is_written(ud_ws):
    ud_call(ud_ws, 'set_head', {'document': 'Viaje', 'ref': 's1.w4', 'head': 2, 'deprel': 'nmod'})
    counts = ud_execute(ud_ws.client, ud_ws.ops, source='s', label='l', project=ud_ws.project,
                        stamp_mode='human')
    assert counts == {'dependencies': 1}
    [made] = ud_ws.client.payloads('relations.create')
    assert made['args'][3] == 'nmod' and not _metadata_of(made)


def test_words_a_reshape_makes_as_human_made_are_written_with_their_forms(ud_ws):
    ud_call(ud_ws, 'set_words', {'document': 'Viaje', 'ref': 's2.w1', 'forms': ['Cor', 're']})
    ud_execute(ud_ws.client, ud_ws.ops, source='s', label='l', project=ud_ws.project, stamp_mode='human')
    spans = [entry for payload in ud_ws.client.payloads('spans.bulk_create') for entry in payload]
    forms = [s for s in spans if s['value'] in ('Cor', 're')]
    assert len(forms) >= 2
    assert all(isinstance(s.get('metadata', {}), dict) for s in spans)


def test_a_gloss_on_an_unsegmented_word_as_human_made_makes_its_morpheme():
    w = scan_ws(FakeClient())
    igt_call(w, 'set_field', {'document': 'd1', 'refs': ['s1.w3.m1'], 'field': 'Morph Gloss', 'value': 'go'})
    counts = igt_execute(w.client, w.plan_payload()['ops'], source='s', label='l', project=w.project,
                         stamp_mode='human')
    assert counts == {'field values': 1}
    [made] = w.client.payloads('tokens.create')
    assert not made['kwargs'].get('metadata')
