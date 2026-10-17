"""grew_search and the Grew port under it.

The port is compared with plaid-ud's own compiler in test_grew_mirror.py. What
is here is the port's own reading of a few patterns, so a failure there names
a pattern without node, and the tool: what it refuses, and what it answers
over a real treebank in the session's core, which is the only engine that
can say whether a compiled query finds anything.
"""

import copy

import pytest

from plaid_agent.core.tools import ToolError
from plaid_agent.ud.grew import (GrewLayers, GrewParseError, GrewUnsupportedError,
                                 parse_and_compile)
from plaid_agent.ud.grew_search import t_grew_search
from plaid_agent.ud.project import load_project
from plaid_agent.ud.tools import Workspace
from plaid_agent.ud.toolkit import call_tool
from live import live_client  # noqa: F401 - fixture
from ud_fixtures import LEMMA, PID, document_raw, project_raw, ud_client

LAYERS = GrewLayers(sentence='SENT', word='MORPH', lemma='LEMMA', upos='UPOS', xpos='XPOS',
                    features='FEATS', form=None, relation='REL', enhanced='EREL')


def where(pattern, layers=LAYERS):
    return parse_and_compile(pattern, layers).query['where']


# --- the port's own reading ------------------------------------------------------

def test_a_single_node_is_one_word_in_one_sentence():
    q = parse_and_compile('pattern { X [upos=VERB] }', LAYERS).query
    assert q == {
        'find': ['?S', '?n_X'],
        'where': [['token', '?S', {'layer': 'SENT'}],
                  ['token', '?n_X', {'layer': 'MORPH'}],
                  ['within', '?n_X', '?S'],
                  ['span', '?s1', {'layer': 'UPOS', 'value': 'VERB'}],
                  ['covers', '?s1', '?n_X']],
        'return': 'entities',
        'order_by': [['?S', 'doc'], ['?S', 'begin']],
        'limit': 200,
    }


def test_an_edge_joins_lemma_spans_and_nodes_are_distinct_words():
    w = where('pattern { X [upos=VERB]; Y [upos=NOUN]; X -[nsubj]-> Y }')
    assert ['relation', '?r3', {'layer': 'REL', 'value': 'nsubj', 'source': '?lem_X',
                                'target': '?lem_Y'}] in w
    assert ['covers', '?lem_X', '?n_X'] in w
    assert w[-1] == ['!=', '?n_X', '?n_Y']


def test_a_feature_is_one_key_value_span():
    assert ['span', '?f1', {'layer': 'FEATS', 'value': 'Number=Sing'}] in where('pattern { X [Number=Sing] }')
    assert ['span', '?f1', {'layer': 'FEATS', 'value': {'regex': '^Number=(?!Sing$)'}}] \
        in where('pattern { X [Number<>Sing] }')


def test_without_is_a_not_and_a_root_is_written_from_a_star():
    w = where('pattern { X [upos=VERB] } without { X -[obj]-> Y }')
    assert w[-1][0] == 'not'
    with pytest.raises(GrewUnsupportedError, match=r'Write \* -\[root\]-> Y'):
        parse_and_compile('pattern { X -[root]-> Y }', LAYERS)


def test_an_unlabelled_edge_reads_both_graphs_in_one_clause():
    w = where('pattern { e: X -> Y }')
    assert ['relation', '?e_e', {'layer': '?rl1', 'value': {'regex': '.'}, 'source': '?lem_X',
                                 'target': '?lem_Y'}] in w
    assert ['relation-layer', '?rl1', {'span-layer': 'LEMMA'}] in w


def test_a_form_is_the_form_span_or_the_text():
    layers = GrewLayers(**{**LAYERS.__dict__, 'form': 'FORM'})
    [clause] = [c for c in where('pattern { X [form="el"] }', layers) if c[0] == 'or']
    assert clause[1][0] == ['span', '?fm1', {'layer': 'FORM', 'value': 'el'}]
    assert clause[2][0] == ['token', '?n_X', {'value': 'el'}]


def test_a_parse_error_says_where():
    with pytest.raises(GrewParseError) as e:
        parse_and_compile('pattern { X [upos=] }', LAYERS)
    assert (e.value.line, e.value.col) == (1, 19)
    assert e.value.message == "Expected a value but found ']'"


def test_a_missing_layer_is_named():
    with pytest.raises(GrewUnsupportedError, match='does not record xpos'):
        parse_and_compile('pattern { X [xpos=NN] }', GrewLayers(**{**LAYERS.__dict__, 'xpos': None}))


# --- the tool, before any query --------------------------------------------------

@pytest.fixture
def fake_ws():
    client = ud_client()
    return Workspace(client, load_project(client, PID))


def test_the_tool_refuses_text_that_is_not_grew_with_a_caret(fake_ws):
    with pytest.raises(ToolError) as e:
        t_grew_search(fake_ws, 'pattern { X [upos=] }')
    assert str(e.value).splitlines() == [
        "Not a Grew pattern: Expected a value but found ']' (line 1, column 19)",
        '  pattern { X [upos=] }', '                    ^']


def test_features_written_after_a_relation_say_how_to_write_them(fake_ws):
    """`A < B [form="est"]` was refused 10 times in one bench run (q38-2)
    with only "Expected a node/edge identifier"."""
    with pytest.raises(ToolError) as e:
        t_grew_search(fake_ws, 'pattern { A < B [form="est"] }')
    assert str(e.value).endswith('declare the node, then relate it, e.g. B [form="est"]; A < B'), str(e.value)


def test_the_tool_refuses_what_the_search_tab_refuses(fake_ws):
    with pytest.raises(ToolError, match=r'^Not supported \(the Search tab refuses it too\): '
                                        r'delta/length distances above 50'):
        t_grew_search(fake_ws, 'pattern { X []; Y []; delta(X,Y) = 60 }')
    with pytest.raises(ToolError, match='Give a Grew pattern'):
        t_grew_search(fake_ws, '  ')


def test_a_pattern_no_tree_can_match_asks_nothing(fake_ws):
    """The fake runs no such query, so an answer here was not asked of one."""
    out = t_grew_search(fake_ws, 'pattern { X [] } global { is_cyclic }')
    assert 'No sentence can match this pattern.' in out
    assert 'pattern { X [] } global { is_cyclic }' in out
    assert '(note) Tree/cyclicity globals assume well-formed UD trees' in out


def test_the_tool_is_on_the_table(fake_ws):
    out = call_tool(fake_ws, 'grew_search', {'pattern': 'pattern { X [upos=] }'})
    assert 'Not a Grew pattern' in out


# --- the tool over a real treebank ----------------------------------------------

def _renamed(raw, prefix, name):
    """The fixture document under fresh entity ids, so two of it can live in
    one project (the seeder maps a fixture id to the last entity made for it)."""
    doc = copy.deepcopy(raw)
    doc['id'], doc['name'] = prefix + doc['id'], name
    for tl in doc['text_layers']:
        tl['text']['id'] = prefix + tl['text']['id']
        for tk in tl['token_layers']:
            for t in tk.get('tokens') or []:
                t['id'] = prefix + t['id']
            for sl in tk.get('span_layers') or []:
                for sp in sl.get('spans') or []:
                    sp['id'] = prefix + sp['id']
                    sp['tokens'] = [prefix + x for x in sp['tokens']]
                for rl in sl.get('relation_layers') or []:
                    for r in rl.get('relations') or []:
                        r['id'], r['source'], r['target'] = (prefix + r['id'], prefix + r['source'],
                                                             prefix + r['target'])
    return doc


@pytest.fixture(scope='module')
def treebank(live_client):
    """The fixture project in the core, twice over: "Viaje" and "Viaje dos",
    with their trees, which the shared seeder does not make."""
    from live import Seeded, seed
    docs = {'ud1': document_raw(), 'b-ud1': _renamed(document_raw(), 'b-', 'Viaje dos')}
    # The seeder knows IGT's three token roles, so the syntactic words go in
    # as morphemes under the surface tokens and take their own role after.
    raw = project_raw()
    words = raw['text_layers'][0]['token_layers'][2]
    words['config'] = {'plaid': {'role': 'morpheme'}}
    s = seed(live_client, raw, docs, {}, name='ud-agent grew_search test')
    lemma = next(sl for sl in words['span_layers'] if sl['id'] == LEMMA)
    with live_client.batched() as b:
        b.token_layers.set_config(s.ids[words['id']], 'plaid', 'role', 'syntactic-word')
        for rl in lemma['relation_layers']:
            rid = s._mint(rl['id'])
            b.relation_layers.create(s.ids[LEMMA], rl['name'], id=rid)
            Seeded._configs(b.relation_layers, rid, rl.get('config'))
        for doc in docs.values():
            words = doc['text_layers'][0]['token_layers'][2]
            for sl in words['span_layers']:
                for rl in sl.get('relation_layers') or []:
                    for r in rl['relations']:
                        b.relations.create(s.ids[rl['id']], s.ids[r['source']], s.ids[r['target']],
                                           r['value'], id=s._mint(r['id']))
    yield Workspace(live_client, load_project(live_client, s.project_id))
    s.delete()


def test_a_head_and_its_dependent_are_found_and_marked(treebank):
    out = t_grew_search(treebank, 'pattern { V [upos=VERB]; V -[obl]-> N }')
    assert out.splitlines() == [
        'Pattern (paste it into the Search tab as it is): pattern { V [upos=VERB]; V -[obl]-> N }',
        '2 matches in 2 sentences, 2 documents. Showing 2 sentences:',
        '"Viaje" (1 match in 1 sentence)',
        '  s1.w1,w4  V=w1 N=w4   [Vamos] al [mar].',
        '"Viaje dos" (1 match in 1 sentence)',
        '  s1.w1,w4  V=w1 N=w4   [Vamos] al [mar].',
    ]


def test_one_document_and_a_word_inside_a_multiword_token(treebank):
    out = t_grew_search(treebank, 'pattern { X [form="el"] }', document='Viaje dos')
    lines = out.splitlines()
    assert lines[1] == '1 match in 1 sentence, 1 document. Showing 1 sentence:'
    assert lines[3].startswith('  s1.w3  X=w3   Vamos [al] mar.')


def test_roots_named_edges_and_absence(treebank):
    roots = t_grew_search(treebank, 'pattern { * -[root]-> R }', document='Viaje')
    assert '  s1.w1  R=w1   [Vamos] al mar.' in roots
    named = t_grew_search(treebank, 'pattern { e: V -> N; N [upos=NOUN] }', document='Viaje')
    assert '  s1.w1,w4  V=w1 N=w4 e=obl   [Vamos] al [mar].' in named
    assert 'No matches in "Viaje".' in t_grew_search(
        treebank, 'pattern { N [upos=NOUN] } without { N -[det]-> D }', document='Viaje')
    bare = t_grew_search(treebank, 'pattern { X [!lemma] }', document='Viaje')
    assert '  s2.w1,w2  X=w1, X=w2   [Corre][.]' in bare


def test_past_the_fetch_the_totals_are_counted(treebank, monkeypatch):
    """A search with more matches than one fetch takes counts them instead,
    and says the sentences shown are from part of the corpus."""
    import plaid_agent.ud.grew_search as gs
    monkeypatch.setattr(gs, 'FETCH', 1)
    out = t_grew_search(treebank, 'pattern { V [upos=VERB]; V -[obl]-> N }')
    lines = out.splitlines()
    assert lines[1] == '2 matches in 2 sentences, 2 documents. Showing 1 sentence:'
    assert lines[2] == '"Viaje" (1 match in 1 sentence, of those fetched)'
    assert lines[-1].startswith('(note) The totals are exact, but only the first 1 matches')


def test_no_matches_over_an_edge_says_which_end_is_the_head(treebank):
    """A model that wrote A -[amod]-> N for an adjective on its noun answered
    0 (2026-10-13 survey)."""
    out = t_grew_search(treebank, 'pattern { A [upos=ADP]; A -[case]-> N; N [upos=NOUN] }', document='Viaje')
    assert out.splitlines()[-1] == 'In A -[case]-> N, A is the head and N the dependent: check the direction.'
    out = t_grew_search(treebank, 'pattern { A [upos=PUNCT]; A -> N }', document='Viaje')
    assert out.splitlines()[-1] == 'In X -[rel]-> Y, X is the head and Y the dependent: check the direction.'
    assert t_grew_search(treebank, 'pattern { X [upos=PRON] }', document='Viaje').endswith('No matches in "Viaje".')


def test_ud_query_points_structure_and_the_search_tab_at_grew_search(treebank):
    """A structural question went to query, and its QL JSON was given to the
    user for the Search tab (2026-10-13 survey). The words are ud's own."""
    from plaid_agent.igt.toolkit import TOOLS as IGT_TOOLS
    from plaid_agent.ud.toolkit import TOOLS
    desc = next(t['function']['description'] for t in TOOLS if t['function']['name'] == 'query')
    assert desc.endswith('use grew_search instead: the Search tab speaks Grew, not this language.')
    igt = next(t['function']['description'] for t in IGT_TOOLS if t['function']['name'] == 'query')
    assert 'grew_search' not in igt
    assert "is grew_search's, not this language's" in call_tool(treebank, 'query_help', {})
