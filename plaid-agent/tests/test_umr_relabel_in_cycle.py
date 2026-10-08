"""A relabel in a graph that already stands in a cycle is not a new cycle.

The bench's umr-hard-opening-hunt (Kukama text 2, sentence 1): the man
``s1a`` is written ``:actor-of`` the going ``s1u``, whose ``:purpose`` is the
looking-for ``s1c``, and ``s1c :experiencer s1a`` closes the loop UMR's
cycle rule reads (an inverse role counts as written, as validate.py reads
it). Relabelling that edge ``:actor`` was refused as "would close a cycle",
though the edge it replaces joined the same two nodes, and the model rebuilt
the user's tree with inverse roles to get around it. The canvas's setRole
lets the relabel through, and apply_penman now does too. A new cycle in the
same graph, or a ``:quote`` edge relabelled to a role that closes one, is
still refused.
"""

import copy

from umr_fixtures import (CONCEPT_LAYER, NODE_LAYER, RELATION_LAYER, document_raw,
                          umr_client, umr_ws)

from plaid_agent.umr.toolkit import call_tool

#: Sentence 1 of Kukama text 2 as the assistant read it in the run.
OPENING = '''(s1x / ɨmɨntsara
    :actor (s1p / person
        :refer-person 1st
        :refer-number singular)
    :recipient (s1p2 / person
        :refer-person 2nd
        :refer-number singular)
    :theme (s1a / awa
        :mod (s1i2 / ikian)
        :actor-of (s1u / utsu
            :goal (s1x2 / ɨwɨrati)
            :purpose (s1c / chikari
                :experiencer s1a
                :theme (s1s / shirinkero)
                :aspect state
                :modal-strength full-affirmative
                :quote s1x)
            :aspect performance
            :modal-strength full-affirmative
            :quote s1x)
        :refer-number singular)
    :aspect performance
    :modal-strength full-affirmative
    :temporal (s1i3 / ikun))'''

#: The first text the model sent: the asked relabel and aspect, nothing else.
ASKED = (OPENING.replace(':experiencer s1a', ':actor s1a')
         .replace(':aspect state', ':aspect process'))

NODES = [  # var, concept, attrs
    ('s1x', 'ɨmɨntsara', [(':aspect', 'performance'), (':modal-strength', 'full-affirmative')]),
    ('s1p', 'person', [(':refer-person', '1st'), (':refer-number', 'singular')]),
    ('s1p2', 'person', [(':refer-person', '2nd'), (':refer-number', 'singular')]),
    ('s1a', 'awa', [(':refer-number', 'singular')]),
    ('s1i2', 'ikian', []),
    ('s1u', 'utsu', [(':aspect', 'performance'), (':modal-strength', 'full-affirmative')]),
    ('s1x2', 'ɨwɨrati', []),
    ('s1c', 'chikari', [(':aspect', 'state'), (':modal-strength', 'full-affirmative')]),
    ('s1s', 'shirinkero', []),
    ('s1i3', 'ikun', []),
]

EDGES = [  # source, role, target, order (the child's place among all of its parent's)
    ('s1x', ':actor', 's1p', 0), ('s1x', ':recipient', 's1p2', 1), ('s1x', ':theme', 's1a', 2),
    ('s1x', ':temporal', 's1i3', 5),
    ('s1a', ':mod', 's1i2', 0), ('s1a', ':actor-of', 's1u', 1),
    ('s1u', ':goal', 's1x2', 0), ('s1u', ':purpose', 's1c', 1), ('s1u', ':quote', 's1x', 4),
    ('s1c', ':experiencer', 's1a', 0), ('s1c', ':theme', 's1s', 1), ('s1c', ':quote', 's1x', 4),
]

#: Where each node's attributes go among its children, as the file has them.
ATTR_ORDER = {'s1x': 3, 's1p': 0, 's1p2': 0, 's1a': 2, 's1u': 2, 's1c': 2}


def _opening_doc():
    """The fixture document with sentence 1's graph swapped for the opening
    sentence's, every node aligned to no word (over its whole sentence)."""
    raw = copy.deepcopy(document_raw())
    layers = raw['text_layers'][0]['token_layers']
    node_layer = next(t for t in layers if t['id'] == NODE_LAYER)
    concepts = next(s for s in node_layer['span_layers'] if s['id'] == CONCEPT_LAYER)
    relations = next(r for r in concepts['relation_layers'] if r['id'] == RELATION_LAYER)
    node_layer['tokens'] = [t for t in node_layer['tokens'] if t['id'] not in ('mn-1', 'mn-2')]
    concepts['spans'] = [s for s in concepts['spans'] if s['id'] not in ('mc-b', 'mc-d')]
    relations['relations'] = [r for r in relations['relations'] if r['id'] != 'mr-1']
    for var, concept, attrs in NODES:
        node_layer['tokens'].append({'id': f'tok-{var}', 'begin': 0, 'end': 17})
        start = ATTR_ORDER.get(var, 0)
        concepts['spans'].append({
            'id': f'c-{var}', 'value': concept, 'tokens': [f'tok-{var}'],
            'metadata': {'umr': {
                'var': var, 'sentence': 'ms-1', **({'root': True} if var == 's1x' else {}),
                'attrs': [{'rel': r, 'value': v, 'order': start + i}
                          for i, (r, v) in enumerate(attrs)]}}})
    for source, role, target, order in EDGES:
        relations['relations'].append({
            'id': f'e-{source}-{role[1:]}-{target}', 'source': f'c-{source}',
            'target': f'c-{target}', 'value': role, 'metadata': {'umr': {'order': order}}})
    # The coreference triple named a node this sentence no longer has.
    doc_layer = next(r for r in concepts['relation_layers'] if r['id'] != RELATION_LAYER)
    doc_layer['relations'] = []
    return raw


def _ws():
    return umr_ws(umr_client(documents={'umr1': _opening_doc()}))


def _apply(ws, text):
    return call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': 1, 'text': text})


def test_the_fixture_reads_back_as_the_opening_sentence():
    ws = _ws()
    out = _apply(ws, OPENING)
    assert 'would close a cycle' not in out
    assert ws.ops == []


def test_relabelling_the_experiencer_actor_is_planned_as_asked():
    ws = _ws()
    out = _apply(ws, ASKED)
    assert 'would close a cycle' not in out
    kinds = sorted((op['kind'], op.get('role') or '') for op in ws.ops)
    assert kinds == [('create_edge', ':actor'), ('delete_edge', ''), ('set_attrs', '')]
    deleted = next(op for op in ws.ops if op['kind'] == 'delete_edge')
    assert deleted['relation_id'] == 'e-s1c-experiencer-s1a'
    added = next(op for op in ws.ops if op['kind'] == 'create_edge')
    assert (added['source_var'], added['target_var']) == ('s1c', 's1a')


def test_a_new_cycle_in_the_same_graph_is_still_refused():
    ws = _ws()
    out = _apply(ws, ASKED.replace('(s1s / shirinkero)', '(s1s / shirinkero :mod s1u)'))
    assert ':mod from s1s to s1u would close a cycle' in out
    assert ws.ops == []


def test_a_quote_relabelled_to_a_role_that_closes_a_cycle_is_refused():
    # The canvas's setRole refuses this one too: the cycle was allowed only
    # through the quote.
    ws = _ws()
    text = OPENING.replace(':modal-strength full-affirmative\n                :quote s1x',
                           ':modal-strength full-affirmative\n                :theme s1x')
    out = _apply(ws, text)
    assert ':theme from s1c to s1x would close a cycle' in out
    assert ws.ops == []
