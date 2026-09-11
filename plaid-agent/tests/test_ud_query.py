"""The query escape hatch: the half that is shared, and UD's half.

What is worth pinning is the translation. The model writes layer NAMES and
gets ids; it writes a question and gets rows named positionally. Both are what
make the tool usable, and neither is checked by anything else.
"""

import pytest

from plaid_agent.core.query import QueryRefused, parse_query, resolve_layer, rewrite
from plaid_agent.ud.project import load_project
from plaid_agent.ud.tools import Workspace, call_tool
from ud_fixtures import PID, ud_client


@pytest.fixture
def ws():
    client = ud_client()
    return Workspace(client, load_project(client, PID))


IDX = {'upos': [('span-layer', 'L-upos', 'upos')],
       'words': [('token-layer', 'L-words', 'words')],
       'both': [('span-layer', 'L-a', 'A'), ('span-layer', 'L-b', 'B')]}
SHOW = lambda lid: {'L-a': 'A', 'L-b': 'B'}.get(lid, lid)  # noqa: E731


# --- naming a layer ---------------------------------------------------------

def test_a_layer_name_becomes_its_id():
    assert resolve_layer('upos', IDX, SHOW) == 'L-upos'


def test_an_id_and_a_variable_pass_straight_through():
    uuid = '019ed0b2-b51a-7378-a89c-f2a2f13ff6a0'
    assert resolve_layer(uuid, IDX, SHOW) == uuid
    assert resolve_layer('?w', IDX, SHOW) == '?w'


def test_an_unknown_name_lists_what_there_is():
    with pytest.raises(QueryRefused, match='No layer named "nope"'):
        resolve_layer('nope', IDX, SHOW)


def test_an_ambiguous_name_is_refused_rather_than_guessed():
    """Two layers sharing a name is ordinary. Picking one would return rows
    from the wrong layer and look like an answer."""
    with pytest.raises(QueryRefused, match='names 2 layers'):
        resolve_layer('both', IDX, SHOW)


def test_names_are_substituted_wherever_they_sit():
    q = {'where': [['span', '?s', {'layer': 'upos'}],
                   ['seq', {'layer': 'words'}, ['span', {'layer': 'upos'}]]]}
    out = rewrite(q, IDX, SHOW)
    assert out['where'][0][2]['layer'] == 'L-upos'
    assert out['where'][1][1]['layer'] == 'L-words'
    assert out['where'][1][2][1]['layer'] == 'L-upos'   # nested, inside a seq


# --- what a malformed query is told -----------------------------------------

def test_a_query_needs_a_where():
    with pytest.raises(QueryRefused, match='at least "where"'):
        parse_query({'find': ['?w']})


def test_find_is_required_unless_the_return_is_an_aggregate():
    """The engine says ":find must be a non-empty list of vars", which is about
    a JSON shape rather than about what was asked for."""
    with pytest.raises(QueryRefused, match='needs "find"'):
        parse_query({'where': [], 'return': 'count'})
    # An aggregate may leave it out, and does.
    parse_query({'where': [], 'return': {'group': ['?d'], 'aggregates': [['count']]}})


def test_a_string_query_is_parsed_as_json():
    assert parse_query('{"find": ["?w"], "where": []}')['find'] == ['?w']
    with pytest.raises(QueryRefused, match='must be a JSON object'):
        parse_query('{not json')


# --- UD's own vocabulary ----------------------------------------------------

def test_the_help_says_where_UD_annotations_actually_live(ws):
    """A model that thinks a dependency joins two words writes queries that
    return nothing, so the help says it joins two LEMMA SPANS."""
    help_text = call_tool(ws, 'query_help', {})
    assert 'LEMMA SPANS' in help_text
    assert 'words (the syntactic words)' in help_text
    # And the project's own field names, so the model need not guess them.
    assert 'upos' in help_text and 'lemma' in help_text


def test_the_help_carries_the_language_itself(ws):
    help_text = call_tool(ws, 'query_help', {})
    for clause in ('["span"', '["token"', '["covers"', '["precedes"', '["within"'):
        assert clause in help_text, clause
