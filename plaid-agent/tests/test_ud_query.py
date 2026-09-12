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


def test_the_commonest_forms_can_be_asked_for_project_wide(ws):
    """A form is the token's surface unless a Form span overrides it. The
    engine answers both halves (surfaces of tokens with no Form span, and
    Form spans by value), and the tool sums them: before, it read the first
    twelve documents by name and called that the corpus."""
    from plaid_agent.ud.tools import call_tool

    asked = []

    def engine(body):
        asked.append(body)
        rows = [['the', 5], ['a', 2]] if len(asked) == 1 else [['a', 1], ['el', 1]]
        return {'return': 'aggregate', 'columns': ['value', 'count'], 'results': rows}

    ws.client.query = engine
    out = call_tool(ws, 'frequency_list', {'what': 'form'})
    assert out.startswith('form by frequency across the project: 3 distinct value(s), 9 in all.')
    assert out.split('\n')[1:] == ['        5  the', '        3  a', '        1  el']
    assert len(asked) == 2 and asked[0]['where'][1][0] == 'not'  # tokens WITHOUT a Form span


def test_a_clipped_read_is_never_reported_as_the_whole_corpus(ws):
    """Including when it comes back EMPTY, which is the most misleading of
    all: this is the tool a session starts from, and it said there was
    nothing to review."""
    from plaid_agent.ud.tools import call_tool

    ws.client.query = lambda body: {'return': body.get('return'), 'columns': [], 'results': [], 'count': 0,
                                    'truncated': True}
    for tool, args in [('worklist', {'kind': 'unverified'}),
                       ('worklist', {'kind': 'missing'}),
                       ('frequency_list', {'what': 'lemma'}),
                       ('check_consistency', {})]:
        out = call_tool(ws, tool, args)
        assert 'come from part of the corpus and not all of it' in out, (tool, out)


def test_a_limit_the_model_wrote_into_the_query_is_refused_in_words(ws):
    """Every other refusal here is a sentence the model can act on. This one
    reached int() and came back as a Python message about base 10."""
    from plaid_agent.core.query import run

    with pytest.raises(QueryRefused, match='has to be a number'):
        run(ws.client, {'where': [], 'find': ['?t'], 'limit': 'about twenty'}, 'p1')


def test_every_tool_that_takes_a_limit_refuses_a_non_number_in_words(ws):
    """Nine sites did `int(limit or N)` unguarded, so the model got a Python
    message about base 10 from tools whose contract is a readable refusal."""
    from plaid_agent.ud.tools import call_tool

    for tool, args in [
        ('search', {'field': 'lemma', 'pattern': 'x'}),
        ('worklist', {'kind': 'unverified', 'document': 'Viaje'}),
        ('recent_changes', {}),
        ('frequency_list', {}),
    ]:
        out = call_tool(ws, tool, {**args, 'limit': 'about twenty'})
        assert 'has to be a number' in out, f'{tool}: {out}'
        assert 'base 10' not in out
