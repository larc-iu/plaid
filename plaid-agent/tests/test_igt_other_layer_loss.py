"""The igt assistant's reshapes name what they take from the layers it does not
read.

A project several apps annotate keeps every app's work on the same sentences
and words. Deleting a word deletes what is nested under it on any layer (a
syntactic word, its lemma, the dependencies on it), merging words takes the
nested tokens of a layer that keeps them coextensive with the words, and
splitting a sentence deletes every relation a layer keeps inside one sentence
whose ends the cut leaves on two sides. All of it went without a word on the
card, and the fixture had only igt's layers, so nothing showed it: the fake
client does not apply a write, and before it modelled the cascade a deleted
word looked as if it took only what igt reads. Proved on a real core (D7-FAKES).
"""

import copy

import pytest

from fixtures import FakeClient, MORPH_LAYER, PID, SENT_LAYER, WORD_LAYER, document_raw, project_raw
from plaid_agent.igt import shape
from plaid_agent.igt.project import load_project
from plaid_agent.igt.workspace import Workspace

OTHER, LEMMA, DEPS, GRAPH, EDGES = 'tk-other', 'sl-lemma', 'rl-deps', 'sl-graph', 'rl-edges'


def _document():
    """The fixture document with another app's layers: a token per word nested
    under the words (each with a lemma, a tree inside each sentence), and a
    root layer of nodes with an edge from 'Ali' to 'akuna', both kept inside
    one sentence by ``same-ancestor``."""
    doc = copy.deepcopy(document_raw())
    layers = doc['text_layers'][0]['token_layers']
    parents = {WORD_LAYER: SENT_LAYER, MORPH_LAYER: WORD_LAYER}
    for layer in layers:
        layer['parent_token_layer'] = parents.get(layer['id'])
    words = next(layer for layer in layers if layer['id'] == WORD_LAYER)['tokens']
    within = {'same-ancestor': {'type': 'same-ancestor', 'token_layer': SENT_LAYER}}
    layers.append({
        'id': OTHER, 'parent_token_layer': WORD_LAYER,
        'tokens': [{'id': f'o-{w["id"]}', 'begin': w['begin'], 'end': w['end']} for w in words],
        'span_layers': [{'id': LEMMA, 'spans': [
            {'id': f'lem-{w["id"]}', 'value': 'x', 'tokens': [f'o-{w["id"]}']} for w in words],
            'relation_layers': [{'id': DEPS, 'constraints': {'ud': [within['same-ancestor']]},
                                 'relations': [
                                     # s1: Ali heads gam and akuna
                                     {'id': 'd1', 'source': 'lem-w-1', 'target': 'lem-w-2', 'value': 'obj'},
                                     {'id': 'd2', 'source': 'lem-w-1', 'target': 'lem-w-3', 'value': 'obl'},
                                     # s2: Gam-ar heads the stop
                                     {'id': 'd3', 'source': 'lem-w-4', 'target': 'lem-w-p2', 'value': 'punct'}]}]}],
    })
    layers.append({
        'id': 'tk-nodes', 'parent_token_layer': None,
        'tokens': [{'id': 'n-1', 'begin': 0, 'end': 6}, {'id': 'n-3', 'begin': 11, 'end': 16}],
        'span_layers': [{'id': GRAPH, 'spans': [
            {'id': 'c-1', 'value': 'ali', 'tokens': ['n-1']},
            {'id': 'c-3', 'value': 'akuna', 'tokens': ['n-3']}],
            'relation_layers': [{'id': EDGES, 'constraints': {'umr': [within['same-ancestor']]},
                                 'relations': [{'id': 'e1', 'source': 'c-1', 'target': 'c-3',
                                                'value': ':ARG1'}]}]}],
    })
    return doc


@pytest.fixture
def ws():
    client = FakeClient(documents={'d1': _document()})
    return Workspace(client, load_project(client, PID))


def _label(ws):
    return ws.ops[-1]['label']


def test_a_deleted_word_names_what_goes_on_other_layers(ws):
    # 'gam': its own lemma and the dependency onto it.
    shape.t_delete_word(ws, 'd1', ['s1.w2'])
    assert '(2 annotations of other layers go with it)' in _label(ws)


def test_a_deleted_head_names_every_dependency_on_it(ws):
    # 'Ali': its lemma and the two dependencies it heads. The node over the
    # same letters is on a root layer, not under the word, and stays.
    shape.t_delete_word(ws, 'd1', ['s1.w1'])
    assert '(3 annotations of other layers go with it)' in _label(ws)


def test_two_deleted_words_count_the_dependency_between_them_once(ws):
    shape.t_delete_word(ws, 'd1', ['s1.w1', 's1.w2'])
    labels = [op['label'] for op in ws.ops]
    assert '(3 annotations of other layers go with it)' in labels[0]
    # gam's lemma only: the dependency Ali -> gam is on the row before.
    assert '(1 annotation of other layers go with it)' in labels[1]


def test_the_card_counts_what_the_server_cascades(ws):
    """The card's number is the fake client's model of core's cascade for the
    same delete, which a real core was checked against."""
    from plaid_agent.igt.plan import execute_plan
    shape.t_delete_word(ws, 'd1', ['s1.w1'])
    execute_plan(ws.client, ws.ops, source='s', label='l')
    other = [e for e in ws.client.cascaded_work()
             if e['kind'] in ('spans', 'relations') and not e['id'].startswith(('sp-', 'l-'))]
    assert len(other) == 3


def test_a_word_with_nothing_on_other_layers_says_nothing_more():
    client = FakeClient()  # igt's layers only
    w = Workspace(client, load_project(client, PID))
    shape.t_delete_word(w, 'd1', ['s1.w2'])
    assert 'other layers' not in w.ops[-1]['label']


def test_a_merge_names_the_nested_tokens_a_coextensive_layer_loses(ws):
    # gam + akuna: two lemmas, and the dependencies onto both.
    shape.t_merge_words(ws, 'd1', ['s1.w2', 's1.w3'])
    assert '(4 annotations of other layers go with it)' in _label(ws)


def test_a_sentence_split_names_the_relations_the_cut_takes(ws):
    # Before 'akuna': Ali -> akuna crosses in the tree and in the graph.
    shape.t_split_sentence(ws, 'd1', 's1', 3)
    assert '(2 annotations of other layers go with it)' in _label(ws)


def test_a_sentence_split_that_crosses_nothing_says_nothing_more():
    client = FakeClient()  # igt's layers only
    w = Workspace(client, load_project(client, PID))
    shape.t_split_sentence(w, 'd1', 's1', 3)
    assert 'other layers' not in w.ops[-1]['label']
