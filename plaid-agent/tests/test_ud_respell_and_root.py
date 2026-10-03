"""set_words respells in place when the count of words stays, as the editor's
``setWordMorphemes`` / ``_respellWords`` do, refuses a call that changes
nothing, and says on the card what a real reshape discards. set_head never
leaves a sentence with two roots. The fixture: "Vamos al mar." with "al" =
a (ADP, case) + el (DET, det), and Vamos the root."""

import pytest

from plaid_agent.ud.plan import execute_plan
from plaid_agent.ud.project import load_project
from plaid_agent.ud.toolkit import call_tool
from plaid_agent.ud.tools import Workspace
from ud_fixtures import FORM, PID, ud_client


@pytest.fixture
def ws():
    client = ud_client()
    return Workspace(client, load_project(client, PID))


def run(ws, name, **args):
    return call_tool(ws, name, args)


def test_respelling_one_word_of_a_multiword_token_keeps_both_words_and_their_annotation(ws):
    out = run(ws, 'set_words', document='Viaje', ref='s1.w2-3', forms=['a', 'él'])
    assert out.startswith('Planned respelling "al" in s1 as "a" + "él"'), out
    [op] = ws.ops
    assert op['kind'] == 'set_span' and op['field'] == 'form' and op['layer_id'] == FORM
    assert (op['token_id'], op['span_id'], op['value']) == ('uw-2b', 'sp-f2b', 'él')
    assert op['label'] == 'form "el" → "él"' and op['ref'] == 's1.w3'
    c = ws.client
    counts = execute_plan(c, ws.ops, source='s', label='l', project=ws.project)
    assert counts == {'field values': 1}
    # Nothing deleted, nothing made: the words, their lemmas, tags and arcs stay.
    assert not c.payloads('tokens.bulk_delete') and not c.payloads('tokens.bulk_create')
    assert not [k for k, _ in c.writes if k.startswith('relations.')]
    assert c.updates('spans') == [('sp-f2b', 'él')]


def test_a_set_words_that_changes_nothing_is_refused(ws):
    for ref, forms in (('s1.w1', ['Vamos']), ('s1.w2-3', ['a', 'el'])):
        out = run(ws, 'set_words', document='Viaje', ref=ref, forms=forms)
        assert out.startswith('Error: Nothing to change'), out
    assert ws.ops == []


def test_a_reshape_says_on_its_row_what_it_discards_and_flags_the_arcs_it_takes(ws):
    run(ws, 'set_words', document='Viaje', ref='s1.w4', forms=['ma', 'r'])
    [op] = ws.ops
    # mar's lemma and UPOS, its obl head and the case and det arcs it heads.
    assert op['label'] == "'mar' becomes 'ma' + 'r' (discards 2 annotation value(s) and 3 dependencies)"
    payload = ws.plan_payload()
    [stored] = payload['ops']
    assert stored.get('replaces_work')
    assert set(op['relation_ids']) == {'r-2a', 'r-2b', 'r-3'}


def test_a_second_root_is_refused_unless_the_old_root_is_given_a_head(ws):
    out = run(ws, 'set_head', document='Viaje', ref='s1.w4', head=0)
    assert 's1.w1 ("Vamos") is the root of s1, and a sentence has one' in out and 'old_root_head' in out
    assert ws.ops == []
    out = run(ws, 'set_head', document='Viaje', ref='s1.w4', head=0, old_root_head=4, old_root_deprel='acl')
    assert out.startswith('Planned'), out
    assert [(op['word_id'], op['head_id'], op['deprel']) for op in ws.ops] == [
        ('uw-3', 'uw-3', 'root'), ('uw-1', 'uw-3', 'acl')]
    # Applied, the tree has one root.
    c = ws.client
    execute_plan(c, ws.ops, source='s', label='l', project=ws.project)
    made = [p['args'] for k, p in c.writes if k == 'relations.create']
    assert [a[3] for a in made] == ['root', 'acl']


def test_a_root_the_plan_already_moved_is_not_counted(ws):
    run(ws, 'del_relation', document='Viaje', refs=['s1.w1'])
    assert run(ws, 'set_head', document='Viaje', ref='s1.w4', head=0).startswith('Planned')
    # and a root the plan makes is
    out = run(ws, 'set_head', document='Viaje', ref='s1.w5', head=0)
    assert 's1.w4 ("mar") is the root of s1' in out


def test_old_root_arguments_belong_to_head_0(ws):
    out = run(ws, 'set_head', document='Viaje', ref='s1.w4', head=1, deprel='obj', old_root_head=4)
    assert 'go with head 0' in out and ws.ops == []
