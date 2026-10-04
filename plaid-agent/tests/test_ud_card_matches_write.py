"""What the UD plan card says against what approval writes and reports
(H38 polish): a multi-word token's row names its text, a relabel is written
as the relation's own update, and the applied message counts as the card."""

from collections import Counter

import pytest

from plaid_agent.ud.changes import describe_changes
from plaid_agent.ud.plan import execute_plan, summarize
from plaid_agent.ud.project import load_project
from plaid_agent.ud.toolkit import call_tool
from plaid_agent.ud.tools import Workspace
from ud_fixtures import PID, ud_client


@pytest.fixture
def ws():
    client = ud_client()
    return Workspace(client, load_project(client, PID))


def _summary_counts(ops) -> Counter:
    """The card's line ("1 cleared value, 1 field value") as counts by the
    plural noun, which is how the applied result is keyed."""
    plural = {'value': 'values', 'dependency': 'dependencies'}
    out: Counter = Counter()
    for part in summarize(ops).split(', '):
        n, noun = part.split(' ', 1)
        if int(n) == 1:
            head, last = noun.rsplit(' ', 1)
            noun = f'{head} {plural[last]}'
        out[noun] += int(n)
    return out


def test_a_multiword_token_row_names_its_text(ws):
    call_tool(ws, 'set_words', {'document': 'Viaje', 'ref': 's1.w2-3', 'forms': ['al']})
    [row] = describe_changes(ws, ws.ops)
    assert row['where']['ref'] == 's1.w2-3' and row['where']['surface'] == 'al'


def test_a_relabel_is_written_as_an_update_of_the_relation(ws):
    """The same head with a new label: the editor updates the relation, so
    History reads a relabel, not a removal and a creation."""
    call_tool(ws, 'set_head', {'document': 'Viaje', 'ref': 's1.w4', 'head': 1, 'deprel': 'nmod'})
    assert summarize(ws.ops) == '1 relabeled dependency'
    counts = execute_plan(ws.client, ws.ops, source='s', label='l', project=ws.project)
    assert counts == {'relabeled dependencies': 1}
    assert not ws.client.payloads('relations.delete')
    assert not ws.client.payloads('relations.create') and not ws.client.payloads('relations.bulk_create')
    [update] = ws.client.payloads('relations.bulk_update')
    assert [(u['id'], u['value']) for u in update] == [('r-3', 'nmod')]


def test_a_new_head_is_still_a_delete_and_a_create(ws):
    call_tool(ws, 'set_head', {'document': 'Viaje', 'ref': 's1.w4', 'head': 2, 'deprel': 'nmod'})
    assert summarize(ws.ops) == '1 dependency'
    counts = execute_plan(ws.client, ws.ops, source='s', label='l', project=ws.project)
    assert counts == {'dependencies': 1}
    assert 'r-3' in ws.client.payloads('relations.delete')


def test_a_feature_split_counts_the_same_on_the_card_and_when_applied(ws):
    call_tool(ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w1'], 'field': 'features',
                                'value': 'Number=Sing,Plur'})
    card = _summary_counts(ws.ops)
    assert card == {'cleared values': 1, 'field values': 1}
    counts = execute_plan(ws.client, ws.ops, source='s', label='l', project=ws.project)
    assert {k: v for k, v in counts.items() if k != 'notes'} == card
