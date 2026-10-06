"""A triple between two constants belongs to no sentence by itself: the
records of the sentences whose blocks write it list it. The assistant puts it
there in the batch that makes it, as the editor does, so it never stands on a
sentence number another app's edit before it would make wrong, and an open of
the document has nothing to move."""

import copy

from umr_fixtures import NODE_LAYER, TEXT_ID, document_raw, umr_client, umr_ws

from plaid_agent.umr.plan import execute_plan
from plaid_agent.umr.toolkit import call_tool

TRIPLE = {'document': 'Story', 'a': 'author', 'rel': ':before', 'b': 'document-creation-time'}


def _apply(client, ws):
    execute_plan(client, ws.plan_payload()['ops'], source='t', label='L', project=ws.project,
                 stamp_mode='verified', contributor=None)


def _triple_ids(client):
    return [p['kwargs']['id'] for p in client.payloads('relations.create')]


def test_the_record_of_its_sentence_lists_it_in_the_same_batch():
    client = umr_client()
    ws = umr_ws(client)
    call_tool(ws, 'add_triple', {**TRIPLE, 'sentence': 2})
    _apply(client, ws)
    [triple] = _triple_ids(client)
    meta = client.payloads('relations.create')[0]['args'][4]['umr']
    assert meta == {'group': 'temporal'}, 'no sentence number is stored'
    assert client.patches('tokens') == [
        ('mr-2', [{'op': 'set', 'path': ['umr', 'triples'], 'value': [triple]}])]
    assert len(client.batches) == 1


def test_two_in_one_block_are_both_listed():
    client = umr_client()
    ws = umr_ws(client)
    call_tool(ws, 'add_triple', {**TRIPLE, 'sentence': 1})
    call_tool(ws, 'add_triple', {**TRIPLE, 'rel': ':after', 'sentence': 1})
    _apply(client, ws)
    ids = _triple_ids(client)
    assert len(ids) == 2
    last = client.patches('tokens')[-1]
    assert last == ('mr-1', [{'op': 'set', 'path': ['umr', 'triples'], 'value': ids}])


def test_a_record_that_lists_others_keeps_them():
    raw = copy.deepcopy(document_raw())
    layers = {layer['id']: layer for layer in raw['text_layers'][0]['token_layers']}
    record = next(t for t in layers[NODE_LAYER]['tokens'] if t['id'] == 'mr-2')
    record['metadata']['umr']['triples'] = ['md-old']
    client = umr_client(documents={'umr1': raw})
    ws = umr_ws(client)
    call_tool(ws, 'add_triple', {**TRIPLE, 'sentence': 2})
    _apply(client, ws)
    [triple] = _triple_ids(client)
    [(_, ops)] = client.patches('tokens')
    assert ops[0]['value'] == ['md-old', triple]


def test_a_sentence_with_no_record_gets_one_over_the_sentence():
    raw = copy.deepcopy(document_raw())
    layers = {layer['id']: layer for layer in raw['text_layers'][0]['token_layers']}
    layers[NODE_LAYER]['tokens'] = [t for t in layers[NODE_LAYER]['tokens'] if t['id'] != 'mr-2']
    client = umr_client(documents={'umr1': raw})
    ws = umr_ws(client)
    call_tool(ws, 'add_triple', {**TRIPLE, 'sentence': 2})
    _apply(client, ws)
    [triple] = _triple_ids(client)
    assert client.patches('tokens') == []
    made = [t for p in client.payloads('tokens.bulk_create') for t in p
            if (t.get('metadata') or {}).get('umr')]
    assert len(made) == 1
    assert made[0]['metadata'] == {'umr': {'triples': [triple]}}
    assert (made[0]['token_layer_id'], made[0]['text']) == (NODE_LAYER, TEXT_ID)
    assert (made[0]['begin'], made[0]['end']) == (17, 31)
    assert len(client.batches) == 1


def test_a_triple_with_a_node_at_one_end_is_listed_in_no_record():
    client = umr_client()
    ws = umr_ws(client)
    call_tool(ws, 'add_triple', {'document': 'Story', 'a': 's2r', 'rel': ':before',
                                 'b': 'document-creation-time'})
    _apply(client, ws)
    assert client.patches('tokens') == []
