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
