"""What the UMR assistant sees of a sentence and is told about a change (A3-UMR-2, -3, -5).

A sentence can hold more than the root's graph: a node added on the canvas
with no parent, or a sentence joined to this one in another app, is a part the
root does not reach. read_document printed the root's graph alone, so the
model planned on nodes it could not see. A tool result counted the changes it
staged, never what they took away, and the model told the user it had added an
attribute where the card said it removed another one. And a settled
set_attrs change kept no value in the record.
"""

import umr_fixtures as umr_fx
from umr_fixtures import umr_client, umr_ws

from plaid_agent.core.conversation import proposed_changes
from plaid_agent.umr.service import AssistantService
from plaid_agent.umr.toolkit import call_tool


def _with_fragment():
    """The fixture with a second graph in sentence 2: "away" as a node no
    other node points at, carrying two attributes."""
    raw = umr_fx.document_raw()
    nodes = next(kl for kl in raw['text_layers'][0]['token_layers'] if kl['id'] == umr_fx.NODE_LAYER)
    nodes['tokens'].append({'id': 'mn-5', 'begin': 24, 'end': 28})
    nodes['span_layers'][0]['spans'].append(
        {'id': 'mc-a', 'value': 'away', 'tokens': ['mn-5'],
         'metadata': {'umr': {'var': 's2a', 'attrs': [
             {'rel': ':aspect', 'value': 'state', 'order': 0},
             {'rel': ':modal-strength', 'value': 'full-affirmative', 'order': 1}]}}})
    return umr_client(documents={'umr1': raw})


def _call(ws, name, **args):
    return call_tool(ws, name, args)


def test_read_document_shows_every_graph_of_a_sentence():
    ws = umr_ws(_with_fragment())
    out = _call(ws, 'read_document', document='Story', sentences=[2])
    assert 'this sentence holds 2 graphs' in out
    assert '(s2a / away' in out
    assert ':modal-strength full-affirmative' in out


def test_a_sentence_with_one_graph_reads_as_before():
    ws = umr_ws()
    out = _call(ws, 'read_document', document='Story', sentences=[2])
    assert 'Graph:\n' + umr_fx.SENTENCE_2_PENMAN in out
    assert 'graphs' not in out


def test_apply_penman_given_every_graph_says_it_takes_the_roots_alone():
    ws = umr_ws(_with_fragment())
    out = _call(ws, 'apply_penman', document='Story', sentence=2,
                text=umr_fx.SENTENCE_2_PENMAN + '\n\n(s2a / away :aspect state)')
    assert "takes the root's graph alone" in out
    assert not ws.ops


def test_set_attributes_says_what_the_new_line_drops():
    ws = umr_ws(_with_fragment())
    out = _call(ws, 'set_attributes', document='Story', sentence=2, var='s2a', line=':aspect state')
    assert 'removes :modal-strength full-affirmative' in out, out


def test_apply_penman_says_what_a_node_delete_takes_with_it():
    ws = umr_ws()
    out = _call(ws, 'apply_penman', document='Story', sentence=2, text='(s2r / run-01)')
    assert 'It removes: remove (s2t / thing) and 1 document-level relation' in out, out


def test_a_concept_named_remove_is_not_a_removal():
    ws = umr_ws()
    out = _call(ws, 'apply_penman', document='Story', sentence=2,
                text=umr_fx.SENTENCE_2_PENMAN[:-1] + ' :ARG2 (s2x / remove-01))')
    assert out.startswith('Planned'), out
    assert 'It removes' not in out, out


def test_a_settled_set_attrs_keeps_the_line_it_set():
    ws = umr_ws(_with_fragment())
    _call(ws, 'set_attributes', document='Story', sentence=2, var='s2a', line=':aspect state')
    _call(ws, 'set_attributes', document='Story', sentence=1, var='s1d', line='')
    kept, total = proposed_changes(ws.ops, *AssistantService.proposed_keys)
    assert total == 2
    assert kept == [['set_attrs', 'mc-a', ':aspect state'], ['set_attrs', 'mc-d', '']]


def test_set_attributes_reaches_a_node_the_root_does_not():
    """As the canvas does."""
    ws = umr_ws(_with_fragment())
    out = _call(ws, 'set_attributes', document='Story', sentence=2, var='s2a', line=':aspect process')
    assert out.startswith('Planned'), out
    assert ws.ops and ws.ops[0]['span_id'] == 'mc-a'
