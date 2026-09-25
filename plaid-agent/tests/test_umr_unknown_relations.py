"""A relation UMR does not have is refused on every route a plan takes into
the graph, as plaid-umr's editors refuse it (e4d3c7db, 556d75c2, e90d377d),
and one the sentence already holds is kept."""

import pytest

from umr_fixtures import SENTENCE_1_PENMAN, document_raw, umr_client, umr_ws

from plaid_agent.core.tools import ToolError
from plaid_agent.umr.toolkit import call_tool


def run(ws, name, **args):
    return call_tool(ws, name, args)


@pytest.fixture
def ws():
    return umr_ws(umr_client())


#: Every tool route that writes a sentence-level relation, each bringing in
#: :poss where :possessor was meant.
SENTENCE_ROUTES = {
    'an edge on a node that is kept': (
        'apply_penman', {'sentence': 1, 'text': SENTENCE_1_PENMAN.replace(
            ':aspect performance', ':aspect performance\n    :poss (s1x / person)')}),
    'an edge out of a new node': (
        'apply_penman', {'sentence': 1, 'text': SENTENCE_1_PENMAN.replace(
            ':aspect performance',
            ':aspect performance\n    :ARG1 (s1x / thing :poss (s1y / person))')}),
    'an attribute in a graph': (
        'apply_penman', {'sentence': 1, 'text': SENTENCE_1_PENMAN.replace(
            ':aspect performance', ':aspect performance :poss 3')}),
    'an attribute of a new node': (
        'apply_penman', {'sentence': 1, 'text': SENTENCE_1_PENMAN.replace(
            ':aspect performance', ':aspect performance\n    :ARG1 (s1x / thing :poss 3)')}),
    'the attribute line': (
        'set_attributes', {'sentence': 1, 'var': 's1d', 'line': ':refer-number singular :poss 3'}),
    'one attribute over a concept': (
        'set_attribute_for_concept', {'concept': 'dog', 'rel': ':poss', 'value': '3'}),
}


@pytest.mark.parametrize('route', sorted(SENTENCE_ROUTES))
def test_a_relation_umr_does_not_have_is_refused_with_the_one_it_meant(ws, route):
    name, args = SENTENCE_ROUTES[route]
    out = run(ws, name, document='Story', **args)
    assert "Unknown relation ':poss'" in out and ':possessor' in out, out
    assert ws.ops == []


def test_the_routes_really_plan_once_the_relation_is_spelled_right(ws):
    """The refusal is the relation's and not something else about the call."""
    for route, (name, args) in SENTENCE_ROUTES.items():
        w = umr_ws(umr_client())
        fixed = {k: (v.replace(':poss', ':possessor') if isinstance(v, str) else v)
                 for k, v in args.items()}
        out = call_tool(w, name, {'document': 'Story', **fixed})
        assert w.ops, (route, out)


def test_an_inverse_role_is_judged_by_its_base(ws):
    out = run(ws, 'apply_penman', document='Story', sentence=1, text=SENTENCE_1_PENMAN.replace(
        ':aspect performance', ':aspect performance\n    :poss-of (s1x / person)'))
    assert ':possessor-of' in out and ws.ops == []
    ok = run(ws, 'apply_penman', document='Story', sentence=1, text=SENTENCE_1_PENMAN.replace(
        ':aspect performance', ':aspect performance\n    :possessor-of (s1x / person)'))
    assert ws.ops, ok


def _with_stored_unknown():
    """The fixture with an imported ':legacy 1' on s1d, a relation UMR does
    not have that the sentence already holds."""
    raw = document_raw()
    dog = next(s for tl in raw['text_layers'][0]['token_layers']
               for sl in tl.get('span_layers', []) for s in sl['spans'] if s['id'] == 'mc-d')
    dog['metadata']['umr']['attrs'].append({'rel': ':legacy', 'value': '1', 'order': 1})
    return umr_ws(umr_client(documents={'umr1': raw}))


def test_a_relation_the_sentence_already_holds_is_not_refused_again():
    w = _with_stored_unknown()
    assert w.doc('Story').node_named('s1d').attrs[-1]['rel'] == ':legacy', 'the fixture holds it'
    run(w, 'set_attributes', document='Story', sentence=1, var='s1d',
        line=':refer-number plural :legacy 1')
    assert len(w.ops) == 1
    w.ops.clear()
    # The stored graph with :polarity added: :legacy is restated, not brought in.
    text = ('(s1b / bark-01\n    :ARG0 (s1d / dog\n        :refer-number singular\n'
            '        :legacy 1)\n    :aspect performance\n    :polarity -)')
    out = run(w, 'apply_penman', document='Story', sentence=1, text=text)
    assert w.ops, out
    w.ops.clear()
    # Kept, not waved through: a second unknown beside it is still refused.
    out = run(w, 'set_attributes', document='Story', sentence=1, var='s1d',
              line=':legacy 1 :poss 3')
    assert "Unknown relation ':poss'" in out


# --- document level ---------------------------------------------------------

def test_a_document_relation_in_no_group_is_refused_before_anything_is_planned(ws):
    out = run(ws, 'add_triple', document='Story', a='author', rel=':FullAff', b='s1b')
    assert "Unknown document-level relation ':FullAff'" in out
    assert ':full-affirmative' in out
    assert ws.ops == [], 'not even the constant it would have made'


def test_a_relation_given_the_wrong_group_names_its_own(ws):
    out = run(ws, 'add_triple', document='Story', a='s1b', rel=':before', b='s2r', group='coref')
    assert 'is a temporal relation' in out and ws.ops == []


def test_contains_is_taken_in_either_of_its_groups(ws):
    run(ws, 'add_triple', document='Story', a='s1b', rel=':contains', b='s2r')
    assert ws.ops[-1]['group'] == 'temporal'
    w = umr_ws(umr_client())
    run(w, 'add_triple', document='Story', a='s1b', rel=':contains', b='s2r', group='coref')
    assert w.ops[-1]['group'] == 'coref'


def test_the_workspace_refuses_a_triple_however_it_was_staged(ws):
    """The backstop: an op that did not come through add_triple."""
    ws.doc('Story')
    with pytest.raises(ToolError, match='Unknown document-level modal relation'):
        ws.add_op({'kind': 'create_triple', 'document_id': 'umr1', 'source_var': 's1b',
                   'target_var': 's2r', 'rel': ':FullAff', 'group': 'modal', 'label': 'x'})
    with pytest.raises(ToolError, match="Unknown relation ':poss'"):
        ws.add_op({'kind': 'create_edge', 'document_id': 'umr1', 'sentence': 1,
                   'source_var': 's1b', 'target_var': 's1d', 'role': ':poss', 'label': 'x'})
    assert ws.ops == []
