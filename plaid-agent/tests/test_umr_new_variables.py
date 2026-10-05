"""A new node's variable is judged as plaid-umr judges it on every editor path
(``UmrDocument._newVariableProblem``): it follows the convention, names its own
sentence, is not a sentence's document graph (``s2s0``) and is not in use
elsewhere in the document. The assistant used to check only that the name could
be written, so it could plan ``(s2s0 / thing)``, a second document block the
export writes, and ``(s1d / thing)`` in sentence 2, a new node sharing sentence
1's variable (REV-DOCUMENT, 2026-09-28)."""

import pytest

from umr_fixtures import umr_client, umr_ws

from plaid_agent.umr.toolkit import call_tool
from plaid_client.workflows.umr import new_variable_problem


@pytest.fixture
def ws():
    return umr_ws(umr_client())


def apply(ws, text, sentence=2):
    return call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': sentence, 'text': text})


@pytest.mark.parametrize('var, why', [
    ('s2s0', "names the sentence's document graph"),
    ('s1d', 'names sentence 1, and the node is in sentence 2'),
    ('s1q', 'names sentence 1, and the node is in sentence 2'),
    ('x1', 'is not a variable'),
])
def test_a_new_node_the_app_would_refuse_is_refused(ws, var, why):
    out = apply(ws, f'(s2r / run-01\n    :ARG0 (s2t / thing)\n    :ARG1 ({var} / thing))')
    assert ws.ops == [], out
    assert why in out, out


def test_a_new_node_under_its_own_sentence_is_planned(ws):
    out = apply(ws, '(s2r / run-01\n    :ARG0 (s2t / thing)\n    :ARG1 (s2t2 / thing))')
    assert [op['var'] for op in ws.ops if op['kind'] == 'create_node'] == ['s2t2'], out


def test_a_rename_is_judged_as_a_new_name(ws):
    out = apply(ws, '(s2r / run-01\n    :ARG0 (s2s0 / thing))')
    assert ws.ops == [], out
    assert "document graph" in out, out
    w = umr_ws(umr_client())
    out = apply(w, '(s2r / run-01\n    :ARG0 (s2x / thing))')
    assert [(op['kind'], op['var']) for op in w.ops] == [('rename_node', 's2x')], out
    # A rename to a name another node holds is refused as a new node's is.
    w = umr_ws(umr_client())
    out = apply(w, '(s2r / run-01\n    :ARG0 (s1d / thing))')
    assert w.ops == [], out


def test_a_stored_name_off_the_convention_is_kept(ws):
    """Only a NEW name is held to the convention, as the app holds it: a
    sentence whose stored nodes break it can still be edited."""
    out = apply(ws, '(s2r / run-01\n    :ARG0 (s2t / thing\n        :refer-number plural))')
    assert [op['kind'] for op in ws.ops] == ['set_attrs'], out


def test_a_constant_is_not_a_sentence_variable(ws):
    out = call_tool(ws, 'add_triple', {'document': 'Story', 'a': 'author', 'rel': ':before',
                                       'b': 's2r'})
    assert any(op['kind'] == 'create_node' and op.get('constant') for op in ws.ops), out


def test_a_name_in_use_elsewhere_in_the_document_is_refused(ws):
    """The document's own variables, and the ones this plan already creates,
    are taken. What the plan deletes is free again."""
    doc = ws.doc('Story')
    op = {'kind': 'create_node', 'document_id': doc.id, 'var': 's2t', 'concept': 'thing',
          'sentence': 2}
    with pytest.raises(Exception, match='s2t is already in use'):
        ws.refuse_unwritable(op)
    ws.ops.append({'kind': 'delete_node', 'document_id': doc.id, 'var': 's2t',
                   'span_id': doc.node_named('s2t').id})
    ws.refuse_unwritable(op)  # no ToolError
    ws.ops.append({'kind': 'create_node', 'document_id': doc.id, 'var': 's2q',
                   'concept': 'thing', 'sentence': 2})
    with pytest.raises(Exception, match='s2q is already in use'):
        ws.refuse_unwritable({**op, 'var': 's2q'})
    # The op a new one replaces is not part of the plan any more.
    ws.refuse_unwritable({**op, 'var': 's2q'}, replacing=len(ws.ops) - 1)


def test_the_check_matches_the_apps():
    taken = {'s1d', 's2t'}
    assert new_variable_problem('s2x', 2, taken) is None
    assert new_variable_problem('s12ab3', 12, taken) is None
    assert new_variable_problem('s2t', 2, taken) == 's2t is already in use.'
    assert new_variable_problem('s2s0', 2, taken) == "s2s0 names the sentence's document graph."
    assert new_variable_problem('s2s', 2, taken) is None
    assert new_variable_problem('s1x', 2, taken) == (
        's1x names sentence 1, and the node is in sentence 2.')
    assert new_variable_problem('S2x', 2, taken) == (
        'S2x is not a variable: s, the sentence number, letters, a number.')
    assert new_variable_problem('s2x2y', 2, taken)
    assert new_variable_problem('s2é', 2, taken) is None
