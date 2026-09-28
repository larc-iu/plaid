"""The assistant refuses a new node under a relation that takes a value (a
list item, an attribute with a closed set, ``:wiki``, a name's ``:opN``,
``:ARG2`` of have-polarity-91), with the words the app's Text mode uses, rather
than planning it for Validation to report after."""

import pytest

from umr_fixtures import SENTENCE_1_PENMAN, umr_client, umr_ws

from plaid_agent.umr.toolkit import call_tool


def _apply(text):
    ws = umr_ws(umr_client())
    out = call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': 1, 'text': text})
    return ws, out


@pytest.mark.parametrize('rel', [':aspect', ':li', ':refer-number', ':wiki'])
def test_a_new_node_under_a_relation_that_takes_a_value_is_refused(rel):
    # Under a node that is there (s1d) and under one the text adds (s1z).
    for text, var in [
        (SENTENCE_1_PENMAN.replace(':refer-number singular)',
                                   f':refer-number singular\n        {rel} (s1y / thing))'), 's1d'),
        (SENTENCE_1_PENMAN.replace(':aspect performance)',
                                   f':aspect performance\n    :ARG1 (s1z / thing\n'
                                   f'        {rel} (s1y / thing)))'), 's1z'),
    ]:
        if rel == ':refer-number' and var == 's1d':
            continue  # s1d holds :refer-number already, and one may not repeat.
        ws, out = _apply(text)
        assert ws.ops == [], out
        assert f"{var}: '{rel}' takes a value, not a node." in out, out


def test_the_parent_s_concept_is_the_one_the_text_gives_it():
    text = SENTENCE_1_PENMAN.replace('(s1d / dog', '(s1d / have-polarity-91').replace(
        ':refer-number singular)', ':refer-number singular\n        :ARG2 (s1y / thing))')
    ws, out = _apply(text)
    assert ws.ops == [], out
    assert "s1d: ':ARG2' takes a value, not a node." in out, out


def test_a_new_node_under_a_relation_that_takes_one_is_planned():
    ws, out = _apply(SENTENCE_1_PENMAN.replace(
        ':refer-number singular)', ':refer-number singular\n        :mod (s1y / big))'))
    assert ws.ops, out


def _ws_with_edge(role):
    """The fixture with s1b's edge to s1d under ``role``."""
    from umr_fixtures import document_raw
    doc = document_raw()
    rels = doc['text_layers'][0]['token_layers'][2]['span_layers'][0]['relation_layers'][0]
    rels['relations'][0]['value'] = role
    return umr_ws(umr_client(documents={'umr1': doc}))


@pytest.mark.parametrize('role, concept', [(':op1', 'name'), (':ARG2', 'have-polarity-91')])
def test_a_concept_that_puts_a_node_it_points_at_under_a_value_only_relation_is_refused(
        role, concept):
    ws = _ws_with_edge(role)
    text = (f'(s1b / {concept}\n    {role} (s1d / dog\n        :refer-number singular)\n'
            '    :aspect performance)')
    out = call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': 1, 'text': text})
    assert ws.ops == [], out
    assert f"s1b: '{role}' takes a value, not a node." in out, out


def test_a_concept_whose_edge_the_same_text_removes_is_planned():
    ws = _ws_with_edge(':op1')
    text = '(s1b / name\n    :op1 "Rex"\n    :aspect performance)'
    out = call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': 1, 'text': text})
    assert any(op['kind'] == 'set_concept' for op in ws.ops), out

