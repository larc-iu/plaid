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
    # Stored as the import stores a triple, with no writer's stamp: the
    # relation is the file's, not the approver's (the app's _heldResolved).
    assert triples[0][4] == {'umr': {'group': 'coref'}}
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


def _three():
    """`_kept`, with a third sentence "A cat sat ." (31-43) holding (s3s /
    sit-01 :ARG0 (s3c / cat)), and sentence 2's held list naming a node of
    sentence 1 and one of sentence 3."""
    doc = _kept()
    tl = doc['text_layers'][0]
    tl['text']['body'] += 'A cat sat .\n'
    for tk in tl['token_layers']:
        role = (tk.get('config') or {}).get('plaid', {}).get('role')
        if role == 'sentence':
            tk['tokens'].append({'id': 'ms-3', 'begin': 31, 'end': 43})
        elif role == 'word':
            tk['tokens'] += [{'id': 'mw-9', 'begin': 31, 'end': 32}, {'id': 'mw-10', 'begin': 33, 'end': 36},
                             {'id': 'mw-11', 'begin': 37, 'end': 40}, {'id': 'mw-12', 'begin': 41, 'end': 42}]
        elif tk['id'] == 'm-node':
            tk['tokens'] += [{'id': 'mn-5', 'begin': 37, 'end': 40}, {'id': 'mn-6', 'begin': 33, 'end': 36},
                             {'id': 'mr-3', 'begin': 31, 'end': 43, 'metadata': {'umr': {'snt': 3}}}]
            for t in tk['tokens']:
                if t['id'] == 'mr-2':
                    t['metadata']['umr']['held'] = [
                        {'source': 's2t', 'rel': ':same-entity', 'target': 's1d', 'group': 'coref'},
                        {'source': 's2t', 'rel': ':same-entity', 'target': 's3c', 'group': 'coref'}]
            sl = tk['span_layers'][0]
            sl['spans'] += [
                {'id': 'mc-s', 'value': 'sit-01', 'tokens': ['mn-5'],
                 'metadata': {'umr': {'var': 's3s', 'root': True, 'attrs': []}}},
                {'id': 'mc-c', 'value': 'cat', 'tokens': ['mn-6'],
                 'metadata': {'umr': {'var': 's3c', 'attrs': []}}}]
            for rl in sl['relation_layers']:
                if rl['id'] == 'm-rel':
                    rl['relations'].append({'id': 'mr-9', 'source': 'mc-s', 'target': 'mc-c',
                                            'value': ':ARG0', 'metadata': {'umr': {'order': 0}}})
    return doc


def test_two_applies_that_each_change_one_held_list_keep_both_changes():
    """Each apply read the held list as stored and wrote it whole, so the
    second undid the first: the list kept naming s1d, which named no node
    once the rename landed. The second now reads the list as the first
    leaves it."""
    client = umr_client(documents={'umr1': _three()})
    ws = umr_ws(client)
    a = call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': 1, 'text': (
        '(s1b / bark-01 :ARG0 (s1g / dog :refer-number singular) :aspect performance)')})
    b = call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': 3, 'text': '(s3s / sit-01)'})
    assert 'Planned' in a and 'Planned' in b, (a, b)
    _apply(client, ws)
    held = [o['value'] for ops in _record_patches(client) for o in ops if o['path'] == ['umr', 'held']]
    assert held[-1] == [{'source': 's2t', 'rel': ':same-entity', 'target': 's1g', 'group': 'coref'}], held


def test_a_mend_after_a_rename_in_the_same_plan_makes_the_relation_on_the_renamed_node():
    client = umr_client(documents={'umr1': _kept()})
    ws = umr_ws(client)
    call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': 1, 'text': (
        '(s1b / bark-01 :ARG0 (s1g / dog :refer-number singular) :aspect performance)')})
    out = call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': 2,
                                         'text': '(s2r / run-01 :ARG0 (s2t / thing))'})
    assert 'Planned' in out, out
    _apply(client, ws)
    triples = [p['args'] for p in client.payloads('relations.create') if p['args'][0] == DOC_LAYER]
    assert [t[2:4] for t in triples] == [('mc-d', ':same-entity')]
    # The held list is gone, whichever apply wrote it last.
    final = {}
    for ops in _record_patches(client):
        for o in ops:
            if o['path'] == ['umr', 'held']:
                final['held'] = o.get('value') if o['op'] == 'set' else None
    assert final == {'held': None}


def test_mending_a_kept_graph_anchors_its_new_nodes_on_the_words_the_file_aligned():
    """The app's applyPenman (keptPieces, cab995804): a node the mend makes
    stands on the words the kept alignment block gives its variable, with its
    hold, and records them. The assistant made every node unaligned over the
    whole sentence and deleted the block in the same batch, so the file's
    alignment for the sentence was gone. A variable the block aligns to
    nothing (0-0) or does not name is made unaligned, as before."""
    doc = _kept()
    for tk in doc['text_layers'][0]['token_layers']:
        for t in tk['tokens']:
            if t['id'] == 'mr-2':
                t['metadata']['umr']['rawAlignment'] = 's2r: 2-2\ns2t: 0-0'
    client = umr_client(documents={'umr1': doc})
    ws = umr_ws(client)
    out = call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': 2, 'text': (
        '(s2r / run-01 :ARG0 (s2t / thing) :manner (s2a / away))')})
    assert 'Planned' in out, out
    _apply(client, ws)
    tokens = {t['id']: t for batch in client.payloads('tokens.bulk_create') for t in batch}
    made = {args[3]['umr']['var']: (args[1], args[3]['umr']) for args in
            (p['args'] for p in client.payloads('spans.create'))}
    # s2r on "ran" (20-23) and its hold to the sentence's end, recording the word.
    anchors, meta = made['s2r']
    assert [(tokens[a]['begin'], tokens[a]['end'], tokens[a].get('metadata')) for a in anchors] == [
        (20, 23, None), (20, 31, {'umr': {'hold': True}})]
    assert meta['words'] == ['mw-6'] and 'sentence' not in meta
    # s2t (0-0) and s2a (not in the block) over the whole sentence, recording it.
    for var in ('s2t', 's2a'):
        anchors, meta = made[var]
        assert [(tokens[a]['begin'], tokens[a]['end']) for a in anchors] == [(17, 31)]
        assert meta['sentence'] == 'ms-2' and 'words' not in meta
    # The block is cleared only now that the nodes carry it.
    [ops] = _record_patches(client)
    assert {'op': 'delete', 'path': ['umr', 'rawAlignment']} in ops


def _two_kept():
    """`_three`, with sentence 3's graph kept as text too, so sentence 2's
    record holds (s2t :same-entity s3c) between two kept graphs."""
    doc = _three()
    for tk in doc['text_layers'][0]['token_layers']:
        if tk['id'] != 'm-node':
            continue
        tk['tokens'] = [t for t in tk['tokens'] if t['id'] not in ('mn-5', 'mn-6')]
        for t in tk['tokens']:
            if t['id'] == 'mr-3':
                t['metadata'] = {'umr': {'snt': 3, 'rawGraph': '(s3s / sit-01\n    :ARG0 (s3c / cat',
                                         'rawAlignment': 's3s: 0-0'}}
        sl = tk['span_layers'][0]
        sl['spans'] = [sp for sp in sl['spans'] if sp['id'] not in ('mc-s', 'mc-c')]
        for rl in sl['relation_layers']:
            rl['relations'] = [r for r in rl['relations'] if r['id'] != 'mr-9']
    return doc


def test_two_kept_graphs_mended_in_one_plan_make_the_relation_between_them_real():
    """As the app's second apply finds the node its first made: the second
    mend read only stored nodes and renames, so the relation between the two
    kept graphs stayed held, never made real, in either order."""
    for first, second in ((3, 2), (2, 3)):
        client = umr_client(documents={'umr1': _two_kept()})
        ws = umr_ws(client)
        texts = {2: '(s2r / run-01 :ARG0 (s2t / thing))', 3: '(s3s / sit-01 :ARG0 (s3c / cat))'}
        for n in (first, second):
            out = call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': n, 'text': texts[n]})
            assert 'Planned' in out, out
        _apply(client, ws)
        made = {p['kwargs']['id']: p['args'][3]['umr']['var'] for p in client.payloads('spans.create')}
        triples = [p['args'] for p in client.payloads('relations.create') if p['args'][0] == DOC_LAYER]
        ends = sorted((made.get(t[1], t[1]), made.get(t[2], t[2])) for t in triples)
        assert ends == [('s2t', 'mc-d'), ('s2t', 's3c')], (first, ends)
        held = [o for ops in _record_patches(client) for o in ops if o['path'] == ['umr', 'held']]
        assert held[-1]['op'] == 'delete', (first, held)
