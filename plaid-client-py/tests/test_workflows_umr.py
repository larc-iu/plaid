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

from plaid_client.workflows.messages import SETUP_INCOMPLETE  # noqa: E402
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
                    {'id': 's1', 'begin': 0, 'end': 17},
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
                    {'id': 'n5', 'begin': 0, 'end': 0},     # a constant
                    # sentence 1's record
                    {'id': 'r1', 'begin': 0, 'end': 17, 'metadata': {'umr': {'snt': 1}}}],
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
def test_a_project_missing_a_layer_is_refused_by_name(drop, named, caplog):
    """One resolver for every reader, so a layer one of them forgot to ask for
    cannot be missing from its own copy: the draft service used to resolve no
    document graph layer and the adjudication service no morphemes. The
    requester reads the one setup line, the operator's log names the layer."""
    raw = _document()
    token_layers = raw['text_layers'][0]['token_layers']
    raw['text_layers'][0]['token_layers'] = [t for t in token_layers if t['id'] != drop]
    with pytest.raises(ValueError) as refused:
        resolve_layers(raw)
    assert str(refused.value) == SETUP_INCOMPLETE
    assert named in caplog.text


def test_the_document_graph_layer_is_required_of_every_reader(caplog):
    raw = _document()
    relation_layers = raw['text_layers'][0]['token_layers'][2]['span_layers'][0]['relation_layers']
    del relation_layers[1]
    with pytest.raises(ValueError, match=SETUP_INCOMPLETE):
        resolve_layers(raw)
    assert 'UMR document graph layer' in caplog.text


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


def test_a_node_whose_word_was_deleted_elsewhere_is_aligned_to_no_word():
    """IGT deleting a word leaves the node's anchor over its text with no word
    under it. The app reads that node as unaligned (sentenceGraph.js, ruling
    umr-igt-deleted-word) and exports it with 0-0, and so does this reader."""
    raw = _document()
    words = raw['text_layers'][0]['token_layers'][1]
    words['tokens'] = [t for t in words['tokens'] if t['id'] != 'w6']   # "ran"
    doc = read_document(raw, resolve_layers(raw))
    node = doc.sentences[1].node('s2r')
    assert node.sentence_token is None and not node.aligned
    assert node.alignment == []
    # A node with a word under its anchor is still aligned.
    assert doc.sentences[0].node('s1b').aligned


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


def _machine_drafted(raw):
    """Every node and in-sentence edge stamped machine-made, as a draft leaves
    them. The coreference triple is left as it was."""
    concept = raw['text_layers'][0]['token_layers'][2]['span_layers'][0]
    for span in concept['spans']:
        span.setdefault('metadata', {})['prov'] = 'inferred'
    for rel in concept['relation_layers'][0]['relations']:
        rel.setdefault('metadata', {})['prov'] = 'inferred'
    return concept


def _without_triples(raw):
    raw['text_layers'][0]['token_layers'][2]['span_layers'][0]['relation_layers'][1][
        'relations'] = []
    return raw


def test_a_sentence_a_person_built_is_told_from_a_drafted_one():
    """A service that overwrites redrafts machine graphs only, so the whole
    metadata is kept on a node, not just its `umr` half: what says who made it
    is the flat provenance keys BESIDE that half."""
    raw = _without_triples(_document())
    concept = _machine_drafted(raw)
    assert not _read(raw).sentences[0].person_made
    assert _read(raw).sentences[0].redraftable
    # One node a person confirmed makes the whole sentence one to keep.
    concept['spans'][0]['metadata']['provConfirmed'] = True
    assert _read(raw).sentences[0].person_made
    assert not _read(raw).sentences[0].redraftable


def test_a_confirmed_edge_keeps_the_sentence():
    """Replacing a graph deletes its anchors, which cascades every edge on its
    nodes, so a person's edge counts as much as a person's node."""
    raw = _without_triples(_document())
    concept = _machine_drafted(raw)
    concept['relation_layers'][0]['relations'][0]['metadata']['provConfirmed'] = True
    s1 = _read(raw).sentences[0]
    assert s1.person_made and not s1.redraftable


def test_a_triple_another_sentence_writes_keeps_the_sentence():
    """The coreference triple between s2t and s1d is written in sentence 2's
    block. Redrafting sentence 1 would delete it with s1d, so sentence 1 is
    kept even when the triple is machine-made, and sentence 2 too when a
    person made it."""
    raw = _document()
    concept = _machine_drafted(raw)
    doc = _read(raw)
    assert doc.sentences[0].triples == []
    assert [t.blocks for t in doc.sentences[1].triples] == [[2]]
    # Human-made: neither sentence may be replaced. It is sentence 2's work,
    # though: sentence 1 is kept as one another sentence links to.
    assert not doc.sentences[0].redraftable
    assert not doc.sentences[1].redraftable
    assert doc.sentences[1].person_made
    assert not doc.sentences[0].person_made
    # Machine-made: sentence 2 owns it and may replace it, sentence 1 may not.
    concept['relation_layers'][1]['relations'][0]['metadata'] = {'prov': 'inferred'}
    doc = _read(raw)
    assert not doc.sentences[0].person_made
    assert not doc.sentences[0].redraftable
    assert doc.sentences[1].redraftable


def test_an_edge_from_another_sentence_keeps_the_sentence():
    raw = _without_triples(_document())
    concept = _machine_drafted(raw)
    concept['relation_layers'][0]['relations'].append(
        {'id': 'r2', 'source': 'c-r', 'target': 'c-d', 'value': ':ARG1',
         'metadata': {'prov': 'inferred', 'umr': {'order': 0}}})
    doc = _read(raw)
    assert not doc.sentences[0].redraftable
    # The edge is sentence 2's own, so sentence 2 may still be redrafted.
    assert doc.sentences[1].redraftable


def test_the_writer_refuses_to_replace_a_sentence_it_may_not():
    """The guard is on the write itself, not only in the services' choice of
    targets, so no caller can replace a person's work by forgetting to ask."""
    doc = _read()
    plans = [{'sentence': doc.sentences[0], 'pieces': [(4, 7)],
              'nodes': [{'concept': 'dog', 'meta': {}, 'piece_indexes': [0]}], 'edges': []}]
    from plaid_client.testing import FakeClient
    client = FakeClient([_document()])
    with pytest.raises(ValueError, match='Sentence 1'):
        write_graphs(client, resolve_layers(_document()), plans, {})
    assert client.writes == []


# --- writing --------------------------------------------------------------------

def test_the_draft_notice_names_each_failed_sentence_and_sticks():
    from plaid_client.workflows.umr.write import build_draft_notice
    one = build_draft_notice(0, 0, [{'sentence': 3, 'reason': 'x is wrong'}])
    assert one == {'level': 'warning', 'title': 'Nothing drafted', 'sticky': True,
                   'message': 'Failed to draft sentence 3: x is wrong.'}
    many = build_draft_notice(2, 0, [{'sentence': 1, 'reason': 'A.'},
                                     {'sentence': 4, 'reason': 'B.'},
                                     {'sentence': 5, 'reason': 'A.'},
                                     {'sentence': 9, 'reason': 'A.'}])
    assert many['message'] == ('Failed to draft 4 sentences. Sentences 1, 5 and 9: A. '
                               'Sentence 4: B.')
    assert 'sticky' not in build_draft_notice(2, 0, [])


def test_the_overwrite_hint_is_worded_for_what_it_would_redraft():
    from plaid_client.workflows.umr.write import build_draft_notice
    assert build_draft_notice(0, 3)['message'] == (
        "All 3 sentences already have graphs. Enable 'Overwrite existing graphs' to draft "
        "over them.")
    assert build_draft_notice(0, 2, kept=1)['message'] == (
        "2 sentences already have graphs. Enable 'Overwrite existing graphs' to draft over "
        "them. Kept 1 sentence a person had worked on.")


def test_run_labels_name_one_sentence_and_count_several():
    from plaid_client.workflows.umr.write import run_label
    doc = _read(_document())
    assert run_label('UMR draft', [{'sentence': doc.sentences[1]}]) == 'UMR draft of sentence 2'
    assert run_label('UMR draft', [{'sentence': s} for s in doc.sentences]) == (
        f'UMR draft ({len(doc.sentences)} sentences)')


def test_a_drafted_graph_is_written_as_anchors_then_nodes_then_edges():
    """In ONE atomic batch, in the order the importer writes in, the old
    anchors' delete first. A node names its anchors, and an edge its nodes,
    by a ref to the ids an earlier op creates. In three batches, a failure or
    a lost answer after the first left anchors with no node (conc-2026-09-29
    H4-7)."""
    from plaid_client.testing import FakeClient
    raw = _without_triples(_document())
    _machine_drafted(raw)
    doc = _read(raw)
    layers = resolve_layers(raw)
    plans = [{'sentence': doc.sentences[0], 'pieces': [(4, 7), (8, 14)],
              'nodes': [{'concept': 'dog', 'meta': {'var': 's1d'}, 'piece_indexes': [0]},
                        {'concept': 'bark-01', 'meta': {'var': 's1b'}, 'piece_indexes': [1]}],
              'edges': [{'source': 1, 'target': 0, 'role': ':ARG0', 'order': 0}]}]
    client = FakeClient([raw])
    write_graphs(client, layers, plans, {'prov': 'inferred'})

    [batch] = client.batches
    assert [name for name, _ in batch] == [
        'tokens.bulk_delete', 'tokens.bulk_create', 'spans.bulk_create',
        'relations.bulk_create']
    [spans] = client.payloads('spans.bulk_create')
    assert [s['value'] for s in spans] == ['dog', 'bark-01']
    assert [s['tokens'] for s in spans] == [[{'$ref': 1, 'index': 0}], [{'$ref': 1, 'index': 1}]]
    # The provenance stamp is FLAT and the app's own half sits beside it.
    # provDetail records what was drafted, per item.
    assert spans[0]['metadata'] == {'prov': 'inferred', 'provDetail': {'value': 'dog'},
                                    'umr': {'var': 's1d'}}
    [[edge]] = client.payloads('relations.bulk_create')
    assert (edge['source'], edge['target'], edge['value']) == (
        {'$ref': 2, 'index': 1}, {'$ref': 2, 'index': 0}, ':ARG0')
    assert edge['metadata']['provDetail'] == {'value': ':ARG0'}


def test_a_draft_that_fails_partway_writes_nothing():
    from plaid_client.http import PlaidAPIError
    from plaid_client.testing import FakeClient
    raw = _without_triples(_document())
    _machine_drafted(raw)
    doc = _read(raw)
    plans = [{'sentence': doc.sentences[0], 'pieces': [(4, 7), (8, 14)],
              'nodes': [{'concept': 'dog', 'meta': {}, 'piece_indexes': [0]},
                        {'concept': 'bark-01', 'meta': {}, 'piece_indexes': [1]}],
              'edges': [{'source': 1, 'target': 0, 'role': ':ARG0', 'order': 0}]}]
    client = FakeClient([raw], fails={'relations.bulk_create': PlaidAPIError('HTTP 400 no', status=400)})
    with pytest.raises(PlaidAPIError):
        write_graphs(client, resolve_layers(raw), plans, {})
    assert client.writes == []


def _many_plans(count):
    """COUNT one-sentence plans, each replacing a machine-made graph of two
    nodes with a new one of two nodes and an edge."""
    import types as _types
    plans = []
    for i in range(count):
        old = [_types.SimpleNamespace(piece_ids=[f'old-{i}-a']),
               _types.SimpleNamespace(piece_ids=[f'old-{i}-b'])]
        sentence = _types.SimpleNamespace(index=i + 1, nodes=old, redraftable=True)
        plans.append({'sentence': sentence, 'pieces': [(i * 20, i * 20 + 3), (i * 20 + 4, i * 20 + 9)],
                      'nodes': [{'concept': 'dog', 'meta': {'var': f's{i}d'}, 'piece_indexes': [0]},
                                {'concept': 'bark-01', 'meta': {'var': f's{i}b'},
                                 'piece_indexes': [1]}],
                      'edges': [{'source': 1, 'target': 0, 'role': ':ARG0', 'order': 0}]})
    return plans


def test_a_long_draft_goes_in_batches_the_server_takes_each_holding_whole_sentences():
    """A redraft of a very long document passed the server's JSON body cap in
    one batch and was refused whole with a 413 (conc-2026-09-29 REV-F-PY
    R1b). Each batch now holds whole sentences, sized from GET /info."""
    from plaid_client.testing import FakeClient
    raw = _without_triples(_document())
    layers = resolve_layers(raw)
    plans = _many_plans(80)
    client = FakeClient([raw], limits={'json_body_bytes': 30_000})
    write_graphs(client, layers, plans, {'prov': 'inferred'})

    assert len(client.batches) > 2
    seen = []
    for batch in client.batches:
        kinds = [name for name, _ in batch]
        assert kinds == ['tokens.bulk_delete', 'tokens.bulk_create', 'spans.bulk_create',
                         'relations.bulk_create']
        gone = batch[0][1]
        [spans] = [p for name, p in batch if name == 'spans.bulk_create']
        [edges] = [p for name, p in batch if name == 'relations.bulk_create']
        here = sorted({int(s['metadata']['umr']['var'][1:-1]) for s in spans})
        # Its old anchors go in the batch that writes its new graph.
        assert sorted(gone) == sorted(f'old-{i}-{x}' for i in here for x in 'ab')
        assert len(edges) == len(here)
        for s in spans:
            [ref] = s['tokens']
            assert ref.op == 1
        for e in edges:
            assert e['source'].op == e['target'].op == 2
        seen += here
    assert seen == list(range(80))


def test_a_draft_whose_later_batch_fails_says_how_many_sentences_it_wrote():
    from plaid_client.http import PlaidAPIError
    from plaid_client.testing import FakeClient
    raw = _without_triples(_document())
    client = FakeClient([raw], limits={'json_body_bytes': 30_000})
    real = client.batched
    opened = []

    def batched():
        opened.append(1)
        if len(opened) == 2:
            client.fails['relations.bulk_create'] = PlaidAPIError('HTTP 409 Document version mismatch',
                                                                  status=409)
        return real()

    client.batched = batched
    with pytest.raises(RuntimeError) as caught:
        write_graphs(client, resolve_layers(raw), _many_plans(80), {'prov': 'inferred'})
    [batch] = client.batches
    written = len([p for name, p in batch if name == 'relations.bulk_create'][0])
    assert str(caught.value) == (f'{written} of 80 sentences were drafted, each in full. '
                                 f'HTTP 409 Document version mismatch')


def _finish(client, raw, plans):
    import contextlib as _contextlib
    from plaid_client.workflows.requester import Requester
    from plaid_client.workflows.umr.write import DraftRun, finish_draft

    class _Helper:
        def progress(self, *a, **k): pass
        def complete(self, *a): pass
        def critical(self): return _contextlib.nullcontext()

    class _Progress:
        def report(self, *a, **k): pass

    doc = _read(raw)
    run = DraftRun(document_id='d1', project_id='p1', read_version=raw['version'],
                   layers=resolve_layers(raw), document=doc, progress=_Progress(), targets=[],
                   skipped=0, kept=0, linked=0, taken=set(), requester=Requester())
    finish_draft(client, _Helper(), run, plans, [], {}, operation='UMR draft',
                 writing='Writing', service_id='umr:draft:x')


def test_a_draft_refused_before_writing_reads_nothing_back():
    from plaid_client.testing import FakeClient
    raw = _without_triples(_document())    # a person's graph: not redraftable
    client = FakeClient([raw])
    doc = _read(raw)
    plans = [{'sentence': doc.sentences[0], 'pieces': [(4, 7)],
              'nodes': [{'concept': 'dog', 'meta': {}, 'piece_indexes': [0]}], 'edges': []}]
    with pytest.raises(ValueError, match='may not replace'):
        _finish(client, raw, plans)
    assert client.writes == []


def test_reading_a_document_does_not_change_it():
    raw = _document()
    before = copy.deepcopy(raw)
    _read(raw)
    assert raw == before


# --- which gloss layer is which line --------------------------------------------

def _gloss_layers(*specs):
    from plaid_client.workflows.umr import GlossLayer, UmrLayers
    return UmrLayers(*([{}] * 7), gloss_layers=[
        GlossLayer(id=i, name=name, scope=scope, lang=lang) for i, name, scope, lang in specs])


def test_only_a_line_filed_as_a_gloss_is_a_lexical_gloss_layer():
    from plaid_client.workflows.umr.layers import lexical_gloss_layers
    layers = _gloss_layers(('pos', 'POS', 'word', None), ('g', 'Gloss', 'word', 'en'),
                           ('cat', 'Category', 'morpheme', None),
                           ('mg', 'Morpheme gloss', 'morpheme', 'en'),
                           ('tr', 'Translation', 'sentence', 'en'), ('n', 'Notes', 'word', None))
    assert [g.id for g in lexical_gloss_layers(None, layers)] == ['mg', 'g']


def test_the_projects_mapping_overrides_the_names_and_a_gloss_in_its_language_comes_first():
    from plaid_client.workflows.umr.layers import lexical_gloss_layers
    layers = _gloss_layers(('en', 'Gloss', 'word', 'en'), ('es', 'Glosa', 'word', 'es'),
                           ('pos', 'POS', 'word', None))
    project = {'config': {'umr': {'language': 'es-MX', 'ilg': [
        {'header': 'word-gloss', 'lang': 'en', 'source': 'layer:en'},
        {'header': 'word-gloss', 'lang': 'es', 'source': 'layer:es'},
        {'header': 'word-gloss', 'lang': 'es', 'source': 'layer:es'},
        {'header': 'pos', 'lang': None, 'source': 'layer:pos'},
        {'header': 'word-gloss', 'lang': 'fr', 'source': 'layer:missing'},
    ]}}}
    assert [g.id for g in lexical_gloss_layers(project, layers)] == ['es', 'en']
    # With no language of its own, the mapping's order stands.
    project['config']['umr'].pop('language')
    assert [g.id for g in lexical_gloss_layers(project, layers)] == ['en', 'es']


def test_a_gloss_in_the_projects_language_comes_first_whatever_its_scope():
    from plaid_client.workflows.umr.layers import lexical_gloss_layers
    layers = _gloss_layers(('en', 'Gloss', 'morpheme', 'en'), ('es', 'Glosa', 'word', 'es'),
                           ('mes', 'Glosa', 'morpheme', 'es'))
    project = {'config': {'umr': {'language': 'es', 'ilg': [
        {'header': 'morpheme-gloss', 'lang': 'en', 'source': 'layer:en'},
        {'header': 'word-gloss', 'lang': 'es', 'source': 'layer:es'},
        {'header': 'morpheme-gloss', 'lang': 'es', 'source': 'layer:mes'},
    ]}}}
    assert [g.id for g in lexical_gloss_layers(project, layers)] == ['mes', 'es', 'en']
