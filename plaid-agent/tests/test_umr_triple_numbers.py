"""A triple between two constants records the sentences whose blocks write
it by NUMBER, and the reader (graph.py's, and the app's
`sentenceNumberReader`) takes a number to the one sentence whose variables
carry it. A file whose snt numbers skip one (snt1, snt3, snt4) keeps its
variables until someone opens it, so the assistant must record the number
the sentence's variables carry, or its triple is read on another sentence.
"""

import copy

from plaid_client.workflows.umr import triple_sentence_number

from umr_fixtures import CONCEPT_LAYER, NODE_LAYER, SENT_LAYER, WORD_LAYER, document_raw, umr_client, umr_ws

from plaid_agent.umr.toolkit import call_tool


def _gapped_raw():
    """Three sentences stored as snt1, snt3, snt4, with the variables their
    file gave them: s1, s3 and s4. Nobody has opened it since import."""
    raw = copy.deepcopy(document_raw())
    tl = raw['text_layers'][0]
    body = tl['text']['body'] + 'It slept .\n'
    tl['text']['body'] = body
    layers = {layer['id']: layer for layer in tl['token_layers']}
    sents = layers[SENT_LAYER]['tokens']
    sents.append({'id': 'ms-3', 'begin': 31, 'end': 42})
    records = {t['id']: t for t in layers[NODE_LAYER]['tokens'] if (t.get('metadata') or {}).get('umr')}
    records['mr-2']['metadata'] = {'umr': {'snt': 3}}
    layers[NODE_LAYER]['tokens'].append(
        {'id': 'mr-3', 'begin': 31, 'end': 42, 'metadata': {'umr': {'snt': 4}}})
    layers[WORD_LAYER]['tokens'] += [{'id': 'mw-9', 'begin': 31, 'end': 33},
                                     {'id': 'mw-10', 'begin': 34, 'end': 39},
                                     {'id': 'mw-11', 'begin': 40, 'end': 41}]
    nodes = layers[NODE_LAYER]
    nodes['tokens'].append({'id': 'mn-5', 'begin': 34, 'end': 39})
    concepts = next(s for s in nodes['span_layers'] if s['id'] == CONCEPT_LAYER)
    for span in concepts['spans']:
        var = span['metadata']['umr']['var']
        if var.startswith('s2'):
            span['metadata']['umr']['var'] = 's3' + var[2:]
    concepts['spans'].append({'id': 'mc-s', 'value': 'sleep-01', 'tokens': ['mn-5'],
                              'metadata': {'umr': {'var': 's4s', 'root': True, 'attrs': []}}})
    assert body[31:42] == 'It slept .\n' and body[34:39] == 'slept'
    return raw


def test_a_triple_between_constants_on_a_gapped_document_is_read_on_its_own_sentence():
    client = umr_client(documents={'umr1': _gapped_raw()})
    ws = umr_ws(client)
    doc = ws.doc('Story')
    assert [s.index for s in doc.sentences] == [1, 2, 3]
    call_tool(ws, 'add_triple', {'document': 'Story', 'a': 'author', 'rel': ':before',
                                 'b': 'document-creation-time', 'sentence': 3})
    op = ws.ops[-1]
    assert op['kind'] == 'create_triple'
    # The sentence at position 3 goes by snt4 (its variables are s4...), and
    # position 3 is what the sentence before it carries.
    assert op['sentences'] == [4], op
    assert triple_sentence_number(doc.sentences, doc.sentences[2]) == 4
    # What the card and the pins go by stays the position.
    assert op['sentence'] == 3 and op['ref'] == 's3'


def test_a_sentence_whose_variables_carry_no_number_records_its_position():
    client = umr_client(documents={'umr1': _gapped_raw()})
    ws = umr_ws(client)
    call_tool(ws, 'add_triple', {'document': 'Story', 'a': 'author', 'rel': ':before',
                                 'b': 'document-creation-time', 'sentence': 1})
    assert ws.ops[-1]['sentences'] == [1]


def test_a_document_without_a_gap_records_the_position_as_before():
    ws = umr_ws()
    call_tool(ws, 'add_triple', {'document': 'Story', 'a': 'author', 'rel': ':before',
                                 'b': 'document-creation-time', 'sentence': 2})
    assert ws.ops[-1]['sentences'] == [2]
