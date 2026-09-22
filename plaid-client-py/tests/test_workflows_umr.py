"""Tests for plaid_client.workflows.umr (the one reading of the UMR storage
model, shared by the bundled UMR services and by the assistant).

Run with::

    cd plaid-client-py && python -m pytest tests/ -q
"""

import copy
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.workflows.umr import (  # noqa: E402
    DOC_CONSTANTS, group_of, is_variable, next_variable, parse_attribute_line, parse_penman,
    read_document, resolve_layers, serialize_penman, tree_edges, variable_from, write_graphs,
)


# --- the notation ---------------------------------------------------------------

def test_a_re_entrant_node_is_read_as_an_edge_and_not_as_an_atom():
    g = parse_penman('(s1w / want-01 :ARG0 (s1b / boy) :ARG1 (s1g / go-02 :ARG0 s1b))')
    assert g.errors == []
    assert g.root == 's1w'
    assert [c.kind for c in g.nodes['s1g'].children] == ['node']
    assert g.nodes['s1g'].children[0].value == 's1b'
    # The tree edge is the FIRST visit, which is the one under want-01.
    assert ('s1w', 0) in tree_edges(g)
    assert ('s1g', 0) not in tree_edges(g)


def test_a_forward_reference_is_still_read_as_a_reference():
    """A reference may point at a node defined later in the text, so whether a
    bare token is a node or an atom cannot be decided where it is read."""
    g = parse_penman('(s1s / say-01\n    :ARG0 s1p\n    :ARG1 (s1p / person))')
    assert not g.errors
    assert g.nodes['s1s'].children[0].kind == 'node'


def test_a_quoted_string_is_kept_whole_and_told_from_an_atom():
    g = parse_penman('(s1n / name :op1 "New York" :quant 3)')
    assert [(c.rel, c.kind, c.value) for c in g.nodes['s1n'].children] == [
        (':op1', 'string', '"New York"'), (':quant', 'atom', '3')]


def test_a_graph_that_cannot_be_read_comes_back_as_errors_rather_than_raising():
    assert any('without closing' in e.message for e in parse_penman('(s1b / bark-01 :ARG0').errors)
    assert 'opening bracket' in parse_penman('not a graph').errors[0].message
    assert parse_penman('').root is None


def test_the_round_trip_is_exact():
    text = '(s1b / bark-01\n    :ARG0 (s1d / dog\n        :refer-number singular)\n    :aspect state)'
    assert serialize_penman(parse_penman(text)) == text


def test_a_variable_is_s_then_digits_then_a_run_of_lowercase_letters():
    """UFAL's ``^s[0-9]+\\p{Ll}+[0-9]*$``, which is a Unicode category and not
    "any letter": reading ``s1P`` as a node reference would turn an atom into a
    dangling edge."""
    assert is_variable('s1b') and is_variable('s12abc3') and is_variable('s1ρ')
    assert not is_variable('s1') and not is_variable('s1P') and not is_variable('bark')
    assert not is_variable('s1Р')            # Cyrillic capital ER
    assert not is_variable('s1生')            # a letter with no case
    # A released file writes `(s6t/ thing)` with no space before the slash.
    assert variable_from('s6t/') == 's6t'


def test_the_variable_rule_matches_the_apps_own():
    taken = set()
    assert next_variable(1, 'bark-01', taken) == 's1b'
    taken.add('s1b')
    assert next_variable(1, 'boy', taken) == 's1b2'
    # A concept that does not start with a lowercase letter falls back to x,
    # which is why the Chinese data is full of s1x35.
    assert next_variable(3, '生活-01', set()) == 's3x'
    assert next_variable(2, '-91', set()) == 's2x'


def test_an_attribute_line_is_read_with_the_graph_grammar():
    attrs, problems = parse_attribute_line(':aspect state :polarity -')
    assert not problems
    assert [(a['rel'], a['value'], a['order']) for a in attrs] == [
        (':aspect', 'state', 0), (':polarity', '-', 1)]
    assert parse_attribute_line('') == ([], [])
    _attrs, problems = parse_attribute_line(':ARG0 (s1p / person)')
    assert problems and 'names a node' in problems[0]


# --- the layers and the document ------------------------------------------------

BODY = 'The dog barked .\nIt ran away .\n'


def _document():
    """Two sentences, one graph each, one coreference triple between them, and
    one constant. A document read carries every layer's config, which is how a
    reader tells the layers apart."""
    return {
        'id': 'd1', 'name': 'Story', 'version': 3, 'metadata': {'genre': 'narrative'},
        'text_layers': [{
            'id': 'tl', 'config': {'plaid': {'role': 'baseline'}},
            'text': {'id': 'tx', 'body': BODY},
            'token_layers': [
                {'id': 'sent', 'config': {'plaid': {'role': 'sentence'}}, 'tokens': [
                    {'id': 's1', 'begin': 0, 'end': 17, 'metadata': {'umr': {'snt': 1}}},
                    {'id': 's2', 'begin': 17, 'end': 31}]},
                {'id': 'word', 'config': {'plaid': {'role': 'word'}}, 'tokens': [
                    {'id': 'w1', 'begin': 0, 'end': 3}, {'id': 'w2', 'begin': 4, 'end': 7},
                    {'id': 'w3', 'begin': 8, 'end': 14}, {'id': 'w4', 'begin': 15, 'end': 16},
                    {'id': 'w5', 'begin': 17, 'end': 19}, {'id': 'w6', 'begin': 20, 'end': 23}],
                 'span_layers': [
                     {'id': 'gloss', 'name': 'Word Gloss',
                      'config': {'igt': {'scope': 'word', 'lang': 'en'}},
                      'spans': [{'id': 'g1', 'value': 'dog', 'tokens': ['w2']}]}]},
                {'id': 'node', 'config': {'umr': {'nodes': True}}, 'tokens': [
                    {'id': 'n1', 'begin': 8, 'end': 14},    # barked
                    {'id': 'n2', 'begin': 4, 'end': 7},     # dog
                    {'id': 'n3', 'begin': 20, 'end': 23},   # ran
                    {'id': 'n4', 'begin': 17, 'end': 31},   # the whole of sentence 2
                    {'id': 'n5', 'begin': 0, 'end': 0}],    # a constant
                 'span_layers': [
                     {'id': 'concept', 'config': {'umr': {'concepts': True}}, 'spans': [
                         {'id': 'c-b', 'value': 'bark-01', 'tokens': ['n1'],
                          'metadata': {'umr': {'var': 's1b', 'root': True, 'attrs': [
                              {'rel': ':aspect', 'value': 'performance', 'order': 1}]}}},
                         {'id': 'c-d', 'value': 'dog', 'tokens': ['n2'],
                          'metadata': {'umr': {'var': 's1d', 'attrs': []}}},
                         {'id': 'c-r', 'value': 'run-01', 'tokens': ['n3'],
                          'metadata': {'umr': {'var': 's2r', 'root': True, 'attrs': []}}},
                         {'id': 'c-t', 'value': 'thing', 'tokens': ['n4'],
                          'metadata': {'umr': {'var': 's2t', 'attrs': [],
                                               'sentence': 's2'}}},
                         {'id': 'c-a', 'value': 'author', 'tokens': ['n5'],
                          'metadata': {'umr': {'var': 'author', 'constant': True}}}],
                      'relation_layers': [
                          {'id': 'rel', 'config': {'umr': {'relations': True}}, 'relations': [
                              {'id': 'r1', 'source': 'c-b', 'target': 'c-d', 'value': ':ARG0',
                               'metadata': {'umr': {'order': 0}}}]},
                          {'id': 'doc', 'config': {'umr': {'documentGraph': True}},
                           'relations': [
                               {'id': 'd1', 'source': 'c-t', 'target': 'c-d',
                                'value': ':same-entity'}]}]}]},
            ]}],
    }


def _read(raw=None):
    raw = raw or _document()
    return read_document(raw, resolve_layers(raw))


def test_the_resolver_finds_every_layer_by_its_tag():
    layers = resolve_layers(_document())
    assert (layers.sentence_layer['id'], layers.word_layer['id']) == ('sent', 'word')
    assert (layers.node_layer['id'], layers.concept_layer['id']) == ('node', 'concept')
    assert (layers.relation_layer['id'], layers.document_graph_layer['id']) == ('rel', 'doc')
    # The morphemes are IGT's and never required.
    assert layers.morpheme_layer is None
    assert [g.id for g in layers.gloss_layers] == ['gloss']
    assert layers.gloss_layers[0].scope == 'word' and layers.gloss_layers[0].lang == 'en'
    assert layers.body == BODY and layers.text_id == 'tx'


@pytest.mark.parametrize('drop,named', [
    ('sent', 'Sentence layer'),
    ('word', 'Word layer'),
    ('node', 'UMR node layer'),
])
def test_a_project_missing_a_layer_is_refused_by_name(drop, named):
    """One resolver for every reader, so a layer one of them forgot to ask for
    cannot be missing from its own copy: the draft service used to resolve no
    document graph layer and the adjudication service no morphemes."""
    raw = _document()
    token_layers = raw['text_layers'][0]['token_layers']
    raw['text_layers'][0]['token_layers'] = [t for t in token_layers if t['id'] != drop]
    with pytest.raises(ValueError, match=named):
        resolve_layers(raw)


def test_the_document_graph_layer_is_required_of_every_reader():
    raw = _document()
    relation_layers = raw['text_layers'][0]['token_layers'][2]['span_layers'][0]['relation_layers']
    del relation_layers[1]
    with pytest.raises(ValueError, match='UMR document graph layer'):
        resolve_layers(raw)


def test_a_document_reads_back_as_sentences_with_their_graphs():
    doc = _read()
    assert [s.index for s in doc.sentences] == [1, 2]
    assert doc.sentences[0].text == 'The dog barked .'
    assert [w.text for w in doc.sentences[0].words] == ['The', 'dog', 'barked', '.']
    assert [n.var for n in doc.sentences[0].nodes] == ['s1d', 's1b']  # anchor order
    assert doc.sentences[0].roots[0].var == 's1b'
    assert doc.node_count == 4
    assert doc.taken_variables == {'s1b', 's1d', 's2r', 's2t', 'author'}


def test_a_constant_belongs_to_no_sentence():
    """Its anchor is a zero-width token at offset 0, which would otherwise fall
    inside the first sentence."""
    doc = _read()
    assert [c.var for c in doc.constants] == ['author']
    assert all(n.var != 'author' for s in doc.sentences for n in s.nodes)
    assert doc.constant('author') is doc.node_named('author')
    assert 'author' in DOC_CONSTANTS


def test_a_node_standing_over_its_whole_sentence_is_aligned_to_no_word():
    """What says a node is unaligned is its sentence record, not the anchor's
    width: reading the width would align it to every word of the sentence."""
    doc = _read()
    unaligned = doc.sentences[1].node('s2t')
    assert unaligned.sentence_token == 's2' and not unaligned.aligned
    assert unaligned.alignment == []
    assert doc.sentences[1].node('s2r').alignment == [(2, 2)]


def test_a_document_level_triple_is_written_in_the_later_sentence_s_block():
    doc = _read()
    assert [t.rel for t in doc.sentences[0].triples] == []
    [triple] = doc.sentences[1].triples
    assert (triple.rel, triple.group) == (':same-entity', 'coref')
    assert group_of(':same-entity') == 'coref' and group_of(':before') == 'temporal'
    assert group_of(':anything-else') == 'modal'


def test_a_morpheme_reads_as_its_own_form_and_not_as_the_word_it_spans():
    """A morpheme token covers the WHOLE of its word: the segmentation is in
    `metadata.form` and the extent says only which word it belongs to."""
    raw = _document()
    raw['text_layers'][0]['token_layers'].append({
        'id': 'morph', 'config': {'plaid': {'role': 'morpheme'}}, 'tokens': [
            {'id': 'm1', 'begin': 8, 'end': 14, 'precedence': 1, 'metadata': {'form': 'bark'}},
            {'id': 'm2', 'begin': 8, 'end': 14, 'precedence': 2, 'metadata': {'form': '-ed'}}]})
    doc = _read(raw)
    assert [m.text for m in doc.sentences[0].morphemes] == ['bark', '-ed']
    word = doc.sentences[0].words[2]
    assert [m.text for m in doc.sentences[0].morphemes_of(word)] == ['bark', '-ed']


def test_a_sentence_a_person_built_is_told_from_a_drafted_one():
    """A service that overwrites redrafts machine graphs only, so the whole
    metadata is kept on a node, not just its `umr` half: what says who made it
    is the flat provenance keys BESIDE that half."""
    raw = _document()
    spans = raw['text_layers'][0]['token_layers'][2]['span_layers'][0]['spans']
    for span in spans:
        span['metadata']['prov'] = 'inferred'
    assert not _read(raw).sentences[0].person_made
    # One node a person confirmed makes the whole sentence one to keep.
    spans[0]['metadata']['provConfirmed'] = True
    assert _read(raw).sentences[0].person_made


# --- writing --------------------------------------------------------------------

class _Client:
    """Records the three batches and hands back ids in order."""

    def __init__(self):
        self.calls = []
        self.tokens = self._Res(self, 'tokens')
        self.spans = self._Res(self, 'spans')
        self.relations = self._Res(self, 'relations')

    class _Res:
        def __init__(self, client, name):
            self._client, self._name = client, name

        def bulk_create(self, ops):
            self._client.calls.append((f'{self._name}.bulk_create', ops))
            return {'ids': [f'{self._name}{i}' for i in range(len(ops))]}

        def bulk_delete(self, ids):
            self._client.calls.append((f'{self._name}.bulk_delete', ids))


def test_a_drafted_graph_is_written_as_anchors_then_nodes_then_edges():
    """An op cannot reference an id produced earlier in the same batch, so the
    three passes are three batches, in the order the importer writes in."""
    doc = _read()
    layers = resolve_layers(_document())
    plans = [{'sentence': doc.sentences[0], 'pieces': [(4, 7), (8, 14)],
              'nodes': [{'concept': 'dog', 'meta': {'var': 's1d'}, 'piece_indexes': [0]},
                        {'concept': 'bark-01', 'meta': {'var': 's1b'}, 'piece_indexes': [1]}],
              'edges': [{'source': 1, 'target': 0, 'role': ':ARG0', 'order': 0}]}]
    client = _Client()
    write_graphs(client, layers, plans, ['n1'], {'prov': 'inferred'})

    assert [name for name, _ in client.calls] == [
        'tokens.bulk_delete', 'tokens.bulk_create', 'spans.bulk_create',
        'relations.bulk_create']
    spans = client.calls[2][1]
    assert [s['value'] for s in spans] == ['dog', 'bark-01']
    # The provenance stamp is FLAT and the app's own half sits beside it.
    assert spans[0]['metadata'] == {'prov': 'inferred', 'umr': {'var': 's1d'}}
    [edge] = client.calls[3][1]
    assert (edge['source'], edge['target'], edge['value']) == ('spans1', 'spans0', ':ARG0')


def test_the_writer_refuses_a_short_answer_rather_than_writing_the_wrong_ids():
    class _Short(_Client):
        class _Res(_Client._Res):
            def bulk_create(self, ops):
                super().bulk_create(ops)
                return {'ids': []}

    doc = _read()
    plans = [{'sentence': doc.sentences[0], 'pieces': [(4, 7)],
              'nodes': [{'concept': 'dog', 'meta': {}, 'piece_indexes': [0]}], 'edges': []}]
    with pytest.raises(RuntimeError, match='anchor ids'):
        write_graphs(_Short(), resolve_layers(_document()), plans, [], {})


def test_reading_a_document_does_not_change_it():
    raw = _document()
    before = copy.deepcopy(raw)
    _read(raw)
    assert raw == before
