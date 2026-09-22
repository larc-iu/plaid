"""apply_penman: what the diff plans, and what an approval writes.

The diff rule is the app's own (``UmrDocument.planPenman``): nodes are matched
BY VARIABLE and relations BY ROLE AND TARGET. Each case below is one of the
five edits that rule has to tell apart, first as plan ops and then as the
writes the executor makes against the fake client.
"""

import pytest

from umr_fixtures import SENTENCE_1_PENMAN, umr_client, umr_ws

from plaid_agent.umr.diff import plan_penman
from plaid_agent.umr.plan import execute_plan
from plaid_agent.umr.toolkit import call_tool


@pytest.fixture
def client():
    return umr_client()


@pytest.fixture
def ws(client):
    return umr_ws(client)


def diff_for(ws, text, sentence=1):
    doc = ws.doc('Story')
    return plan_penman(doc, doc.sentences[sentence - 1], text, ws.project)


def kinds(diff):
    return sorted(op['kind'] for op in diff.ops)


def applied(client, ws, plan=None):
    """Approve what the workspace has planned and hand back the write log."""
    payload = plan or ws.plan_payload()
    execute_plan(client, payload['ops'], source='test', label='Assistant: test',
                 project=ws.project, stamp_mode='verified', contributor=None)
    return client.log


# --- the five edits ------------------------------------------------------------

def test_the_stored_graph_written_back_plans_nothing(ws):
    """The property the other four rest on: a text the model did not change
    must not become a plan. Without it every edit would look like a rewrite."""
    assert diff_for(ws, SENTENCE_1_PENMAN).ops == []


def test_a_new_node_is_a_create_and_the_edge_that_reaches_it(ws):
    text = SENTENCE_1_PENMAN.replace('    :aspect performance)',
                                     '    :place (s1y / yard)\n    :aspect performance)')
    diff = diff_for(ws, text)
    assert kinds(diff) == ['create_edge', 'create_node']
    create = next(op for op in diff.ops if op['kind'] == 'create_node')
    assert (create['var'], create['concept']) == ('s1y', 'yard')
    # Aligned to no word: the anchor stands over the WHOLE sentence until
    # somebody anchors it on the canvas, so an edit to the text around it
    # resizes the anchor rather than deleting the node, and the sentence it
    # records is what says it is aligned to nothing.
    s1 = ws.doc('Story').sentences[0]
    assert (create['begin'], create['end']) == (s1.begin, s1.end)
    assert create['sentence_id'] == s1.id
    edge = next(op for op in diff.ops if op['kind'] == 'create_edge')
    assert (edge['source_var'], edge['role'], edge['target_var']) == ('s1b', ':place', 's1y')
    # The source exists, so the executor needs no id for it; the target does
    # not, and is left for the pass that mints it.
    assert edge['source_span_id'] == 'mc-b'
    assert 'target_span_id' not in edge


def test_a_concept_change_keeps_the_node(ws):
    diff = diff_for(ws, SENTENCE_1_PENMAN.replace('bark-01', 'bark-02'))
    assert kinds(diff) == ['set_concept']
    assert diff.ops[0]['span_id'] == 'mc-b'
    assert diff.ops[0]['concept'] == 'bark-02'


def test_an_attribute_change_rewrites_the_whole_attribute_set(ws):
    diff = diff_for(ws, SENTENCE_1_PENMAN.replace('singular', 'plural'))
    assert kinds(diff) == ['set_attrs']
    op = diff.ops[0]
    assert [(a['rel'], a['value']) for a in op['attrs']] == [(':refer-number', 'plural')]
    # The op carries its delta over the namespace as it was read, and the
    # executor composes the whole object, because a metadata patch replaces a
    # namespace wholesale. The variable is in the base and so survives.
    assert op['umr_set'] == {'attrs': op['attrs']}
    assert op['umr_base']['var'] == 's1d'


def test_a_dropped_edge_deletes_the_relation_and_the_node_it_orphaned(ws):
    """The text is the root's graph, so a node the text no longer writes is
    gone with its relation. The relation delete is dropped: the server's
    cascade takes it with the node, and a second delete would be a 404."""
    diff = diff_for(ws, '(s1b / bark-01\n    :aspect performance)')
    assert kinds(diff) == ['delete_node']
    assert diff.ops[0]['token_ids'] == ['mn-2']


def test_a_re_root_moves_the_mark_off_the_old_root(ws):
    text = ('(s1y / yard\n    :location (s1b / bark-01\n        :ARG0 (s1d / dog\n'
            '            :refer-number singular)\n        :aspect performance))')
    diff = diff_for(ws, text)
    assert kinds(diff) == ['create_edge', 'create_node', 'unset_root']
    off = next(op for op in diff.ops if op['kind'] == 'unset_root')
    assert off['span_id'] == 'mc-b'
    assert off['umr_unset'] == ('root',) and off['umr_base']['root'] is True
    # The new root is created with the mark on it rather than patched after.
    create = next(op for op in diff.ops if op['kind'] == 'create_node')
    assert create['root'] is True


def test_a_fragment_the_root_does_not_reach_is_left_alone(ws):
    """Only what the root reaches is the text's to delete."""
    doc = ws.doc('Story')
    # s2t hangs off s2r, so writing s2r alone drops it. A node in ANOTHER
    # sentence is never reached at all.
    diff = plan_penman(doc, doc.sentences[1], '(s2r / run-01)', ws.project)
    assert kinds(diff) == ['delete_node']
    assert diff.ops[0]['var'] == 's2t'


def test_a_text_that_does_not_parse_plans_nothing_and_says_why(ws):
    diff = diff_for(ws, '(s1b / bark-01 :ARG0')
    assert diff.ops == []
    assert diff.errors and 'line 1' in diff.errors[0]


# --- the same five, as writes ----------------------------------------------------

def test_a_created_node_is_written_as_a_token_then_a_span_then_its_relation(client, ws):
    text = SENTENCE_1_PENMAN.replace('    :aspect performance)',
                                     '    :place (s1y / yard)\n    :aspect performance)')
    call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': 1, 'text': text})
    log = applied(client, ws)
    assert [(e[0], e[1]) for e in log] == [
        ('tokens', 'bulk_create'), ('spans', 'create'), ('relations', 'create')]
    # Three batches, because a span cannot name a token its own batch minted.
    assert [len(b) for b in client.batches] == [1, 1, 1]
    # The anchor covers the whole sentence, not a point at its start: core
    # deletes a zero-width token a text edit spans, and the node would go
    # with it (c6313696).
    s1 = ws.doc('Story').sentences[0]
    token = next(e for e in log if e[0] == 'tokens')
    assert (token[2][0][0]['begin'], token[2][0][0]['end']) == (s1.begin, s1.end)
    span = next(e for e in log if e[0] == 'spans')
    assert span[2][0] == 'm-concept' and span[2][2] == 'yard'
    assert span[2][1] == ['new-tokens-0']          # the token the first batch made
    # Unaligned, so it records its sentence.
    assert span[2][3]['umr'] == {
        'var': 's1y', 'attrs': [], 'sentence': ws.doc('Story').sentences[0].id}
    relation = next(e for e in log if e[0] == 'relations')
    assert relation[2][:4] == ('m-rel', 'mc-b', 'new-spans-0', ':place')


def test_a_concept_change_is_one_span_update_carrying_the_approval_stamp(client, ws):
    call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': 1,
                                   'text': SENTENCE_1_PENMAN.replace('bark-01', 'bark-02')})
    log = applied(client, ws)
    assert ('spans', 'update', ('mc-b', 'bark-02'), {}) in log
    stamp = next(e for e in log if e[1] == 'patch_metadata')[2][1]
    assert stamp['provConfirmed'] is True and stamp['provSource'] == 'test'


def test_an_attribute_change_patches_the_whole_namespace(client, ws):
    call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': 1,
                                   'text': SENTENCE_1_PENMAN.replace('singular', 'plural')})
    log = applied(client, ws)
    patch = next(e for e in log if e[0] == 'spans' and e[1] == 'patch_metadata')
    assert patch[2][0] == 'mc-d'
    assert patch[2][1]['umr'] == {'var': 's1d',
                                  'attrs': [{'rel': ':refer-number', 'value': 'plural',
                                             'order': 0}]}


def test_a_dropped_node_is_written_as_deleting_its_anchor_tokens(client, ws):
    call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': 1,
                                   'text': '(s1b / bark-01\n    :aspect performance)'})
    log = applied(client, ws)
    assert [(e[0], e[1], e[2]) for e in log] == [('tokens', 'bulk_delete', (['mn-2'],))]


def test_a_re_root_takes_the_mark_off_before_the_new_root_wears_one(client, ws):
    text = ('(s1y / yard\n    :location (s1b / bark-01\n        :ARG0 (s1d / dog\n'
            '            :refer-number singular)\n        :aspect performance))')
    call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': 1, 'text': text})
    log = applied(client, ws)
    off = next(e for e in log if e[0] == 'spans' and e[1] == 'patch_metadata')
    assert off[2][0] == 'mc-b' and 'root' not in off[2][1]['umr']
    on = next(e for e in log if e[0] == 'spans' and e[1] == 'create')
    assert on[2][3]['umr']['root'] is True
    # The mark comes off in an EARLIER batch than the one that puts it on, so
    # no two nodes wear it, whichever way a failure falls.
    assert client.batches[0][-1][1] == 'patch_metadata'
    assert client.batches[1][0][1] == 'create'


def test_a_node_re_rooted_and_re_attributed_at_once_keeps_both(client, ws):
    """One plan, two ops on one node. Each is built from the node as it was
    BEFORE the plan ran, so the attribute write used to restate the namespace
    without the root mark the root op had just put on, and a node came out of
    its own re-root not being the root. The executor composes them instead."""
    text = ('(s1d / dog\n    :refer-number plural\n'
            '    :ARG0-of (s1b / bark-01\n        :aspect performance))')
    call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': 1, 'text': text})
    kinds_on_d = sorted(op['kind'] for op in ws.ops if op.get('span_id') == 'mc-d')
    assert kinds_on_d == ['set_attrs', 'set_root']
    log = applied(client, ws)
    written = [e[2][1]['umr'] for e in log
               if e[0] == 'spans' and e[1] == 'patch_metadata' and e[2][0] == 'mc-d']
    assert written, 'the node was never patched'
    assert written[-1]['root'] is True
    assert [(a['rel'], a['value']) for a in written[-1]['attrs']] \
        == [(':refer-number', 'plural')]


def test_the_same_sentence_cannot_be_rewritten_twice_in_one_plan(ws):
    call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': 1,
                                   'text': SENTENCE_1_PENMAN.replace('bark-01', 'bark-02')})
    out = call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': 1,
                                         'text': SENTENCE_1_PENMAN.replace('bark-01', 'bark-03')})
    assert 'already replaces the graph of s1' in out
    assert len(ws.ops) == 1
