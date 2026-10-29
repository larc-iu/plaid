"""apply_penman and the relations a graph kept as text holds by name.

A sentence whose graph an import kept as text (``rawGraph``) holds the
document-level relations its block wrote by name on its record (``held``).
The app's applyPenman follows them (``UmrDocument._heldResolved``): a node the
apply renames takes its relations to its new name, one it deletes takes them
with it, and the mend of the kept sentence makes them real triples, drops
them from the record and clears the kept text (HUNT-recent 3).
"""

from umr_fixtures import DOC_LAYER, document_raw, umr_client, umr_ws

from plaid_agent.umr.plan import execute_plan
from plaid_agent.umr.toolkit import call_tool

HELD = [{'source': 's2t', 'rel': ':same-entity', 'target': 's1d', 'group': 'coref'}]
RAW = '(s2r / run-01\n    :ARG0 (s2t / thing'


def _kept():
    """Sentence 2's graph kept as text, its coreference to s1d held by name."""
    doc = document_raw()
    for tk in doc['text_layers'][0]['token_layers']:
        if tk['id'] != 'm-node':
            continue
        tk['tokens'] = [t for t in tk['tokens'] if t['id'] not in ('mn-3', 'mn-4')]
        for t in tk['tokens']:
            if t['id'] == 'mr-2':
                t['metadata'] = {'umr': {'snt': 2, 'rawGraph': RAW, 'rawAlignment': 's2r: 0-0',
                                         'held': [dict(h) for h in HELD]}}
        sl = tk['span_layers'][0]
        sl['spans'] = [sp for sp in sl['spans'] if sp['id'] not in ('mc-r', 'mc-t')]
        for rl in sl['relation_layers']:
            rl['relations'] = [r for r in rl['relations'] if r['source'] not in ('mc-r', 'mc-t')]
    return doc


def _apply(client, ws):
    execute_plan(client, ws.plan_payload()['ops'], source='test', label='Assistant: test',
                 project=ws.project, stamp_mode='verified', contributor=None)


def _record_patches(client):
    return [ops for rid, ops in client.patches('tokens') if rid == 'mr-2']


def test_a_rename_takes_the_held_relations_to_the_new_name():
    client = umr_client(documents={'umr1': _kept()})
    ws = umr_ws(client)
    out = call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': 1, 'text': (
        '(s1b / bark-01 :ARG0 (s1g / dog :refer-number singular) :aspect performance)')})
    assert 'Planned' in out, out
    assert any(op['kind'] == 'rename_node' for op in ws.ops)
    _apply(client, ws)
    assert _record_patches(client) == [[{'op': 'set', 'path': ['umr', 'held'], 'value': [
        {'source': 's2t', 'rel': ':same-entity', 'target': 's1g', 'group': 'coref'}]}]]


def test_a_delete_takes_the_held_relations_with_the_node():
    client = umr_client(documents={'umr1': _kept()})
    ws = umr_ws(client)
    call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': 1,
                                   'text': '(s1b / bark-01 :aspect performance)'})
    _apply(client, ws)
    assert _record_patches(client) == [[{'op': 'delete', 'path': ['umr', 'held']}]]


def test_mending_the_kept_graph_makes_the_held_relations_real_and_clears_the_kept_text():
    client = umr_client(documents={'umr1': _kept()})
    ws = umr_ws(client)
    out = call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': 2,
                                         'text': '(s2r / run-01 :ARG0 (s2t / thing))'})
    assert 'Planned' in out, out
    _apply(client, ws)
    made = {p['kwargs']['id']: p['args'] for p in client.payloads('spans.create')}
    s2t = next(i for i, args in made.items() if args[3]['umr']['var'] == 's2t')
    triples = [p['args'] for p in client.payloads('relations.create') if p['args'][0] == DOC_LAYER]
    assert [t[:4] for t in triples] == [(DOC_LAYER, s2t, 'mc-d', ':same-entity')]
    assert triples[0][4]['umr'] == {'group': 'coref'}
    [ops] = _record_patches(client)
    assert sorted(o['path'][1] for o in ops) == ['held', 'rawAlignment', 'rawGraph']
    assert all(o['op'] == 'delete' for o in ops)


def test_a_graph_without_held_relations_touches_no_record():
    client = umr_client()
    ws = umr_ws(client)
    call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': 1, 'text': (
        '(s1b / bark-01 :ARG0 (s1g / dog :refer-number singular) :aspect performance)')})
    _apply(client, ws)
    assert not client.patches('tokens')


def _joined():
    """`_kept`, with sentence 2 joined to sentence 1 in another app: one
    sentence token over both, and sentence 2's record, with its held list,
    standing in it after sentence 1's own."""
    doc = _kept()
    for tk in doc['text_layers'][0]['token_layers']:
        if tk['config'].get('plaid', {}).get('role') == 'sentence':
            tk['tokens'] = [{'id': 'ms-1', 'begin': 0, 'end': 31}]
    return doc


def test_a_rename_takes_the_held_relations_of_a_joined_sentences_other_record_along():
    # REV-R4-UDUMR, the Python half: the app's _heldResolved follows every
    # record (graph.records), and the assistant followed only each sentence's
    # own, so the second record's relation kept naming s1d.
    client = umr_client(documents={'umr1': _joined()})
    ws = umr_ws(client)
    out = call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': 1, 'text': (
        '(s1b / bark-01 :ARG0 (s1g / dog :refer-number singular) :aspect performance)')})
    assert 'Planned' in out, out
    _apply(client, ws)
    assert _record_patches(client) == [[{'op': 'set', 'path': ['umr', 'held'], 'value': [
        {'source': 's2t', 'rel': ':same-entity', 'target': 's1g', 'group': 'coref'}]}]]


def test_a_name_a_graph_kept_as_text_defines_is_taken_for_a_new_node():
    """R4-3: a kept graph's names stay taken, as the app's takenVariables
    holds them, so a node another sentence's plan creates does not take one
    (here a name carrying sentence 1's number, as after IGT removed a
    sentence before it), and the relation held for it does not land there.
    The kept sentence's own mend still writes its names, whatever sentence
    number they carry, as Text mode mends it."""
    doc = _kept()
    for tk in doc['text_layers'][0]['token_layers']:
        for t in tk['tokens']:
            if t['id'] == 'mr-2':
                t['metadata']['umr']['rawGraph'] = '(s2r / run-01\n    :ARG0 (s1k / thing'
    client = umr_client(documents={'umr1': doc})
    ws = umr_ws(client)
    out = call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': 1, 'text': (
        '(s1b / bark-01 :ARG0 (s1d / dog :refer-number singular) :aspect performance'
        ' :ARG1 (s1k / thing))')})
    assert 's1k is already in use' in out, out
    assert not ws.ops
    out = call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': 2,
                                         'text': '(s2r / run-01 :ARG0 (s1k / thing))'})
    assert 'Planned' in out, out
