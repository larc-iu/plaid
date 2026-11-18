"""A triple on a constant the document lacked when it was planned. When the
constant has been made since (on the canvas, by another person or another
approved plan), the approval hangs the triple on that one and makes no second:
constants are judged by name, so the document never gets two (plaid-umr's
umrRebase.js). H2-10-1."""

import copy

from umr_fixtures import CONCEPT_LAYER, NODE_LAYER, PID, document_raw, umr_client, umr_ws

from plaid_agent.umr.plan import execute_plan
from plaid_agent.umr.project import load_project
from plaid_agent.umr.toolkit import call_tool


def _layers(raw):
    return {layer['id']: layer for layer in raw['text_layers'][0]['token_layers']}


def _add_constant(raw, var, span_id):
    """The constant as the canvas makes one: a point at the text's start and
    a concept span over it."""
    layers = _layers(raw)
    layers[NODE_LAYER]['tokens'].append({'id': f'tok-{span_id}', 'begin': 0, 'end': 0})
    concepts = next(s for s in layers[NODE_LAYER]['span_layers'] if s['id'] == CONCEPT_LAYER)
    concepts['spans'].append({'id': span_id, 'value': var, 'tokens': [f'tok-{span_id}'],
                              'metadata': {'umr': {'var': var, 'attrs': [], 'constant': True}}})


def _plan(raw):
    client = umr_client(documents={'umr1': raw})
    ws = umr_ws(client)
    out = call_tool(ws, 'add_triple', {'document': 'Story', 'a': 'author', 'rel': ':full-affirmative',
                                       'b': 's1b'})
    assert out.startswith('Planned'), out
    return client, ws.plan_payload()['ops']


def _apply(client, ops, project):
    return execute_plan(client, ops, source='t', label='L', project=project, stamp_mode='verified',
                        contributor=None)


def _made_constants(client):
    return [p for p in client.payloads('spans.create')
            if len(p.get('args') or []) > 3 and (p['args'][3].get('umr') or {}).get('constant')]


def test_a_constant_made_since_planning_is_used_and_not_made_again():
    raw = copy.deepcopy(document_raw())
    client, ops = _plan(raw)
    assert any(op['kind'] == 'create_node' and op.get('constant') for op in ops)
    _add_constant(raw, 'author', 'mc-author')
    result = _apply(client, ops, load_project(client, PID))
    assert _made_constants(client) == [], 'no second author'
    [triple] = client.payloads('relations.create')
    assert triple['args'][1] == 'mc-author', 'the triple hangs on the author that is there'
    assert result.get('notes') == [
        'the constant author was already in the document, so it was not added again'], result


def test_a_constant_still_missing_at_approval_is_made():
    raw = copy.deepcopy(document_raw())
    client, ops = _plan(raw)
    _apply(client, ops, load_project(client, PID))
    [made] = _made_constants(client)
    [triple] = client.payloads('relations.create')
    assert triple['args'][1] == made['kwargs']['id']
