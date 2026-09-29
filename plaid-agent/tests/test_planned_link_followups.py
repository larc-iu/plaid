"""Three follow-ups to the planned-morpheme links (review 2026-09-28).

1. An entry a plan links to (or otherwise names) that is deleted or merged
   away before approval, in a document that links it nowhere else, moved no
   version the staleness check reads. The link was written in the second
   batch and failed there, after the analysis had landed. Approval now asks
   the server for every such entry first and refuses the plan as out of date,
   with nothing written, naming the entry.
2. A link on a word or morpheme and a merge in the same plan that moves the
   link it replaces ended with two links on it. The merge now leaves such a
   link to the change that replaces or removes it, the model is told as it is
   staged, and approval refuses a plan that would still write two.
3. set_field, set_morpheme and set_morph_type on sN.wN.mN of a word whose
   analysis the plan writes read the stored chain. They now change the
   planned analysis, and one of them planned before the analysis is
   superseded by it with a note rather than dropped at approval.
"""

import pytest

import test_stale_by_sentence as sbs
from fixtures import FakeClient, scan_ws
from test_planned_morpheme_link import AKUNA, _link, _linked_kept_first, _links, _segment_and_link, _stage

from plaid_client.http import PlaidAPIError
from plaid_agent.core.plan import PlanOutOfDate
from plaid_agent.igt.plan import execute_plan
from plaid_agent.igt.toolkit import call_tool


def _forget(client, item_id):
    """The entry deleted on the server (in the fake's lexicon) without any
    document that links it changing."""
    client._lexicon['items'] = [it for it in client._lexicon['items'] if it['id'] != item_id]


# --- 1. an entry gone before approval --------------------------------------------

def test_approval_refuses_a_planned_link_to_an_entry_deleted_since_and_writes_nothing():
    """vi-gam is linked nowhere in d1, so deleting it moved no version the
    staleness check reads. The second batch used to fail with the analysis
    already written ("Stopped partway")."""
    client = FakeClient()
    spec, plan, store = _stage(client)
    _forget(client, 'vi-gam')
    helper = sbs._approve(spec, client, plan)
    assert helper.done == [] and len(helper.errors) == 1, helper.errors
    said = helper.errors[0]
    assert said.startswith('Nothing was written.') and 'lexicon entry "gam"' in said, said
    assert 'no longer exists' in said and 'Ask the assistant to plan again' in said, said
    assert client.batches == []
    conv, meta = store.load('c1')
    assert conv['display'][1]['status'] == 'stale' and meta['pending'] is None


def test_an_ordinary_link_to_an_entry_gone_is_refused_before_anything_is_written():
    w = scan_ws(FakeClient())
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'fish'})
    call_tool(w, 'link_entry', _link('s1.w2', 'vi-gam'))
    c = FakeClient()
    _forget(c, 'vi-gam')
    with pytest.raises(PlanOutOfDate) as e:
        execute_plan(c, w.plan_payload()['ops'], source='s', label='l')
    assert e.value.reasons == ['the lexicon entry "gam" no longer exists (deleted or merged away since the '
                               'plan was made)']
    assert c.batches == []


def test_a_merge_into_an_entry_gone_is_refused_and_an_entry_present_is_not():
    w = scan_ws(FakeClient())
    call_tool(w, 'merge_entries', {'keep_id': 'vi-ali', 'remove_id': 'vi-erg'})
    ops = w.plan_payload()['ops']
    c = FakeClient()
    _forget(c, 'vi-ali')
    with pytest.raises(PlanOutOfDate, match='no longer exists'):
        execute_plan(c, ops, source='s', label='l')
    assert c.batches == []
    execute_plan(FakeClient(), ops, source='s', label='l')


def test_an_entry_the_server_will_not_show_the_user_counts_as_gone():
    """The server answers 403 to a user who is not an administrator for an id
    that no longer exists (the 403-versus-404 ruling)."""
    w = scan_ws(FakeClient())
    call_tool(w, 'link_entry', _link('s1.w2', 'vi-gam'))
    c = FakeClient(fails={'vocab_items.get': PlaidAPIError('HTTP 403', status=403)})
    with pytest.raises(PlanOutOfDate, match='"gam" no longer exists'):
        execute_plan(c, w.plan_payload()['ops'], source='s', label='l')


def _counting_lexicon_reads(monkeypatch):
    """How many times approval reads a whole lexicon."""
    reads = []
    real = FakeClient._VocabLayers.get

    def get(self, vid, include_items=None, **kw):
        reads.append((vid, include_items))
        return real(self, vid, include_items=include_items, **kw)
    monkeypatch.setattr(FakeClient._VocabLayers, 'get', get)
    return reads


def _renames(n):
    """A lexicon of ``n`` entries and a plan renaming every one of them, as a
    respelling carried into the headwords stages it."""
    from fixtures import lexicon_raw
    lex = lexicon_raw()
    lex['items'] = [{'id': f'vi-{i}', 'form': f'w{i}', 'metadata': {}} for i in range(n)]
    ops = [{'kind': 'rename_entry', 'item_id': f'vi-{i}', 'form': f'v{i}', 'label': f'rename {i}'}
           for i in range(n)]
    return lex, ops


def test_a_plan_naming_many_entries_reads_each_lexicon_once_not_each_entry(monkeypatch):
    """A respelling of the whole lexicon names thousands of entries. One GET
    each cost about 6 ms against a core on the same machine, 20 seconds for
    3000, with every document of the plan held locked."""
    lex, ops = _renames(300)
    project = scan_ws(FakeClient(lexicon=lex)).project
    c = FakeClient(lexicon=lex, fails={'vocab_items.get': AssertionError('asked one entry at a time')})
    reads = _counting_lexicon_reads(monkeypatch)
    execute_plan(c, ops, source='s', label='l', project=project)
    assert reads == [('v1', True)]
    _forget(c, 'vi-7')
    with pytest.raises(PlanOutOfDate) as e:
        execute_plan(c, ops, source='s', label='l', project=project)
    assert len(e.value.reasons) == 1 and 'no longer exists' in e.value.reasons[0], e.value.reasons


def test_a_403_is_gone_only_when_the_lexicon_says_so():
    """A delegated token gets a 403 for an id the server no longer has, and
    the same 403 for an entry in a lexicon it cannot read (one taken out of
    the project, say). The lexicons tell the two apart: an entry missing from
    every one the project can read is gone, and a lexicon that cannot be read
    is a failure to read, never "deleted"."""
    w = scan_ws(FakeClient())
    call_tool(w, 'link_entry', _link('s1.w2', 'vi-gam'))
    ops, project = w.plan_payload()['ops'], w.project
    denied = PlaidAPIError('HTTP 403 lacks read access', status=403)
    # Still in the lexicon: nothing to refuse.
    execute_plan(FakeClient(fails={'vocab_items.get': denied}), ops, source='s', label='l', project=project)
    # Gone from it.
    c = FakeClient(fails={'vocab_items.get': denied})
    _forget(c, 'vi-gam')
    with pytest.raises(PlanOutOfDate, match='"gam" no longer exists'):
        execute_plan(c, ops, source='s', label='l', project=project)
    # The lexicon itself cannot be read: not "gone".
    c = FakeClient(fails={'vocab_items.get': denied, 'vocab_layers.get': denied})
    with pytest.raises(PlanOutOfDate) as e:
        execute_plan(c, ops, source='s', label='l', project=project)
    assert 'could not be read' in e.value.reasons[0] and 'no longer exists' not in e.value.reasons[0], e.value.reasons
    assert c.batches == []


def test_an_entry_the_plan_creates_is_not_asked_for():
    w = scan_ws(FakeClient())
    call_tool(w, 'set_analysis', dict(AKUNA))
    call_tool(w, 'create_entry', {'form': 'akun', 'fields': {'gloss': 'see'}})
    call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w3.m1'], 'entry_form': 'akun'})
    c = FakeClient(fails={'vocab_items.get': PlaidAPIError('HTTP 500', status=500)})
    counts = execute_plan(c, w.plan_payload()['ops'], source='s', label='l')
    assert counts['lexicon links'] == 1


# --- 2. a link and a merge that moves the link it replaces ----------------------

def _own_links_on(client, token):
    return [item for item, tokens, _ in _links(client) if tokens == [token]]


@pytest.mark.parametrize('merge_first', [False, True])
def test_a_merge_leaves_a_link_the_plan_replaces_and_the_morpheme_keeps_one_link(merge_first):
    """s1.w1.m2 is linked to -di (l-2). Relinking it to gam and merging -di
    into Ali wrote gam's link AND the merge's move of l-2 onto it."""
    w = scan_ws(FakeClient())
    merge = {'keep_id': 'vi-ali', 'remove_id': 'vi-erg'}
    steps = [('link_entry', _link('s1.w1.m2', 'vi-gam')), ('merge_entries', merge)]
    outs = [call_tool(w, tool, args) for tool, args in (reversed(steps) if merge_first else steps)]
    assert 'leaves 1 link' in outs[1] and 's1.w1.m2' in outs[1], outs
    assert ('1 link(s) will move' if merge_first else '0 link(s) will move') in outs[0 if merge_first else 1], outs
    assert 'move 0 links' in call_tool(w, 'plan_status', {})
    payload = w.plan_payload()
    [merged] = [op for op in payload['ops'] if op['kind'] == 'merge_entries']
    assert merged['links'] == [] and 'move 0 links' in merged['label'], merged
    c = FakeClient()
    execute_plan(c, payload['ops'], source='s', label='l')
    assert _own_links_on(c, 'm-1b') == ['vi-gam']


def test_an_unlink_is_not_undone_by_a_merge_moving_the_same_link():
    w = scan_ws(FakeClient())
    call_tool(w, 'unlink_entry', {'document': 'd1', 'refs': ['s1.w1.m2']})
    call_tool(w, 'merge_entries', {'keep_id': 'vi-ali', 'remove_id': 'vi-erg'})
    c = FakeClient()
    execute_plan(c, w.plan_payload()['ops'], source='s', label='l')
    assert _own_links_on(c, 'm-1b') == []


def test_a_link_by_place_on_a_kept_first_morpheme_and_a_merge_of_its_entry():
    w = scan_ws(_linked_kept_first())
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's2.w1', 'morphemes': [{'form': 'Gam'}, {'form': 'ar'}]})
    call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s2.w1.m1'], 'entry_id': 'vi-ali'})
    call_tool(w, 'merge_entries', {'keep_id': 'vi-gam', 'remove_id': 'vi-gam2'})
    c = _linked_kept_first()
    execute_plan(c, w.plan_payload()['ops'], source='s', label='l')
    assert _own_links_on(c, 'm-4a') == ['vi-ali']


def test_a_merge_does_not_move_a_link_onto_a_morpheme_an_analysis_deletes():
    """l-2 sits on m-1b, which a new analysis of s1.w1 deletes: moving it
    would create a link on a token the same batch deleted."""
    w = scan_ws(FakeClient())
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': [{'form': 'Ali'}, {'form': 'di'}]})
    call_tool(w, 'merge_entries', {'keep_id': 'vi-ali', 'remove_id': 'vi-erg'})
    c = FakeClient()
    execute_plan(c, w.plan_payload()['ops'], source='s', label='l')
    assert _own_links_on(c, 'm-1b') == []


def test_dropping_the_link_gives_the_merge_its_move_back():
    w = scan_ws(FakeClient())
    call_tool(w, 'link_entry', _link('s1.w1.m2', 'vi-gam'))
    call_tool(w, 'merge_entries', {'keep_id': 'vi-ali', 'remove_id': 'vi-erg'})
    call_tool(w, 'drop_planned', {'indexes': [1]})
    [merged] = w.plan_payload()['ops']
    assert [l['link_id'] for l in merged['links']] == ['l-2'] and 'move 1 link' in merged['label']


def test_approval_settles_a_plan_built_before_the_staging_rule():
    """The ops as a plan stored before this change carries them."""
    link = {'kind': 'link', 'token_id': 'm-1b', 'item_id': 'vi-gam', 'existing_link_id': 'l-2', 'label': 'x'}
    merge = {'kind': 'merge_entries', 'keep_id': 'vi-ali', 'remove_id': 'vi-erg',
             'links': [{'link_id': 'l-2', 'token_ids': ['m-1b']}], 'label': 'Merge: move 1 link, delete the former'}
    c = FakeClient()
    counts = execute_plan(c, [link, merge], source='s', label='l')
    assert _own_links_on(c, 'm-1b') == ['vi-gam']
    assert any('move 0 links' in n or 'leaves' in n for n in counts.get('notes', [])), counts


def test_approval_never_writes_two_own_links_on_one_token():
    ops = [{'kind': 'link', 'token_id': 'm-2', 'item_id': 'vi-gam', 'label': 'a'},
           {'kind': 'link', 'token_id': 'm-2', 'item_id': 'vi-ali', 'label': 'b'}]
    c = FakeClient()
    with pytest.raises(ValueError, match='two lexicon links'):
        execute_plan(c, ops, source='s', label='l')
    assert c.batches == []


# --- 3. set_field, set_morpheme, set_morph_type on a planned analysis ----------------

def _analyse_ali(w, **first):
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1',
                                  'morphemes': [{'form': 'Ali', 'fields': {'Morph Gloss': 'A'}, **first},
                                                {'form': 'd'}, {'form': 'i'}]})


def _gloss_of(m):
    return next((fv['value'] for fv in m['fields'] if fv['layer_id'] == 'sl-mgloss'), None)


def test_set_field_on_a_morpheme_of_a_planned_analysis_changes_that_analysis():
    """It used to update the stored first morpheme's span, which the analysis
    deletes in the same batch: a request against something gone."""
    w = scan_ws(FakeClient())
    _analyse_ali(w)
    out = call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1.m1', 's1.w1.m3'],
                                     'field': 'Morph Gloss', 'value': 'NEW'})
    assert out.startswith('Planned 2 changes'), out
    [analysis] = w.ops
    assert [_gloss_of(m) for m in analysis['morphemes']] == ['NEW', None, 'NEW']
    assert 'Morph Gloss NEW-_-NEW' in analysis['label'], analysis['label']
    c = FakeClient()
    execute_plan(c, w.plan_payload()['ops'], source='s', label='l')
    assert c.payloads('spans.bulk_update') == []
    assert [p['args'][2] for p in c.payloads('spans.create')] == ['NEW', 'NEW']


def test_set_field_on_a_word_nobody_analysed_reads_the_planned_chain():
    w = scan_ws(FakeClient())
    call_tool(w, 'set_analysis', dict(AKUNA))
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w3.m2'], 'field': 'Morph Gloss', 'value': 'ABS'})
    [analysis] = w.ops
    assert [_gloss_of(m) for m in analysis['morphemes']] == ['see', 'ABS']
    out = call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w3.m2'], 'field': 'Morph Gloss', 'value': ''})
    assert [_gloss_of(m) for m in w.ops[0]['morphemes']] == ['see', None], out


def test_set_morpheme_type_on_the_kept_first_morpheme_is_written_not_dropped():
    w = scan_ws(FakeClient())
    _analyse_ali(w)
    out = call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's1.w1.m1', 'type': 'root'})
    assert out.startswith('Planned 1 change'), out
    [analysis] = w.ops
    assert analysis['morphemes'][0]['morph_type'] == 'root'
    c = FakeClient()
    counts = execute_plan(c, w.plan_payload()['ops'], source='s', label='l')
    assert 'notes' not in counts, counts
    [(mid, patch)] = c.payloads('tokens.patch_metadata')
    assert mid == 'm-1a' and {'op': 'set', 'path': ['morphType'], 'value': 'root'} in patch


def test_set_morpheme_form_on_a_planned_morpheme_carries_its_planned_link():
    w = scan_ws(FakeClient())
    _segment_and_link(w)
    out = call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's1.w3.m2', 'form': 'aa'})
    assert out.startswith('Planned 1 change') and 'dropped' not in out, out
    analysis, m1, m2 = w.ops
    assert [m['form'] for m in analysis['morphemes']] == ['akun', 'aa']
    assert m2['morpheme_form'] == 'aa' and '"aa"' in m2['label']
    c = FakeClient()
    execute_plan(c, w.plan_payload()['ops'], source='s', label='l')
    [batch] = c.batches
    made = [i for i, (kind, _) in enumerate(batch) if kind == 'tokens.create']
    assert [(item, tokens) for item, tokens, _ in _links(c)] == [('vi-gam', [{'$ref': made[0]}]),
                                                                 ('vi-erg', [{'$ref': made[1]}])]


def test_set_morpheme_past_the_end_of_the_planned_analysis_is_refused():
    w = scan_ws(FakeClient())
    call_tool(w, 'set_analysis', dict(AKUNA))
    out = call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's1.w3.m3', 'type': 'suffix'})
    assert 'the analysis this plan gives "akuna" has 2 morphemes' in out
    assert len(w.ops) == 1


@pytest.mark.parametrize('tool, args', [
    ('set_field', {'refs': ['s1.w1.m1'], 'field': 'Morph Gloss', 'value': 'NEW'}),
    ('set_morpheme', {'ref': 's1.w1.m1', 'type': 'root'}),
    ('set_morpheme', {'ref': 's1.w1.m1', 'form': 'Alo'}),
])
def test_a_change_to_a_stored_morpheme_is_superseded_by_a_later_analysis_of_its_word(tool, args):
    """The analysis replaces the chain and every value on it, so the earlier
    change is moot. It used to stay on the card and be dropped at approval,
    or (a field value) fail the batch."""
    w = scan_ws(FakeClient())
    call_tool(w, tool, {'document': 'd1', **args})
    assert len(w.ops) == 1
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': [{'form': 'Ali'}, {'form': 'di'}]})
    assert [op['kind'] for op in w.ops] == ['set_analysis'], out
    assert '1 change planned on the morphemes of a word this analysis replaces was taken out' in out, out
    c = FakeClient()
    counts = execute_plan(c, w.plan_payload()['ops'], source='s', label='l')
    assert 'notes' not in counts and c.payloads('spans.bulk_update') == []


def test_a_morpheme_change_by_id_on_a_planned_analysis_is_refused_at_staging():
    """Every path that names a stored morpheme the planned analysis rewrites,
    not only the tools that read sN.wN.mN."""
    w = scan_ws(FakeClient())
    _analyse_ali(w)
    with pytest.raises(Exception, match='analysis planned'):
        w.add_op({'kind': 'set_morph_type', 'morpheme_id': 'm-1a', 'morph_type': 'root', 'label': 'x'})
    with pytest.raises(Exception, match='analysis planned'):
        w.add_op({'kind': 'set_span', 'layer_id': 'sl-mgloss', 'token_id': 'm-1a', 'span_id': 'sp-m1a',
                  'value': 'X', 'label': 'x'})
    assert len(w.ops) == 1


def test_set_field_for_form_reads_the_planned_chain():
    w = scan_ws(FakeClient())
    _analyse_ali(w)
    out = call_tool(w, 'set_field_for_form', {'form': 'd', 'field': 'Morph Gloss', 'value': 'DAT'})
    assert [op['kind'] for op in w.ops] == ['set_analysis'], out
    assert [_gloss_of(m) for m in w.ops[0]['morphemes']] == ['A', 'DAT', None]
    # The stored "Ali" of s1.w1 is on its way out, and the planned one
    # already has a value, so only_empty leaves it.
    call_tool(w, 'set_field_for_form', {'form': 'Ali', 'field': 'Morph Gloss', 'value': 'ALI'})
    assert [_gloss_of(m) for m in w.ops[0]['morphemes']] == ['A', 'DAT', None]


def test_a_replacement_over_stored_morphemes_leaves_the_ones_a_planned_analysis_rewrites():
    w = scan_ws(FakeClient())
    _analyse_ali(w)
    out = call_tool(w, 'replace_in_field', {'field': 'morpheme forms', 'pattern': 'a', 'replacement': 'o'})
    # m-1a "Ali" is the analysis's now. m-4a "Gam" and m-4b "ar" are not.
    assert sorted(op['morpheme_id'] for op in w.ops if op['kind'] == 'set_morpheme_form') == ['m-4a', 'm-4b'], out
    assert '1 morpheme of words whose analysis this plan rewrites was left as planned' in out, out


def test_the_query_path_leaves_them_too():
    """Under the cap a corpus-wide tool's query path stages its ops as they
    are, and the funnel would refuse the whole call over one of them."""
    from plaid_agent.igt.bulk import _stage
    w = scan_ws(FakeClient())
    _analyse_ali(w)
    ops = [{'kind': 'set_span', 'layer_id': 'sl-mgloss', 'token_id': tid, 'span_id': sid, 'value': 'X',
            'doc': 'd1', 'label': f'{tid}: X'} for tid, sid in (('m-1a', 'sp-m1a'), ('m-4a', None))]
    out = _stage(w, 'set_field_for_form', {}, ops, 'set_span', 'values')
    assert [op.get('token_id') for op in w.ops] == [None, 'm-4a'], out
    assert 'was left as planned' in out


@pytest.mark.parametrize('analysis_first', [True, False])
def test_a_deleted_entry_never_deletes_a_link_an_analysis_took_with_its_morpheme(analysis_first):
    """A new analysis of s1.w1 deletes m-1b, and the server takes l-2 (-di)
    with it. Deleting -di in the same plan deleted l-2 by id as well, after
    the morpheme, which the server refuses for a link it no longer has, and
    the atomic batch took the whole plan down on every approval. The entry's
    own delete takes its links with it."""
    w = scan_ws(FakeClient())
    steps = [('set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': [{'form': 'Alidi'}]}),
             ('delete_entry', {'entry_id': 'vi-erg'})]
    for tool, args in (steps if analysis_first else reversed(steps)):
        assert call_tool(w, tool, args).startswith('Planned'), w.ops
    c = FakeClient()
    execute_plan(c, w.plan_payload()['ops'], source='s', label='l', project=w.project)
    kinds = [(k, p) for k, p in c.calls if k in ('tokens.delete', 'vocab_links.delete', 'vocab_items.delete')]
    at = kinds.index(('tokens.delete', 'm-1b'))
    assert ('vocab_links.delete', 'l-2') not in kinds[at:], kinds
    # The fake does not apply the writes, so l-2 is still there to count.
    assert ('vocab_items.delete', {'args': ('vi-erg',), 'kwargs': {'expected_link_count': 1}}) in kinds


@pytest.mark.parametrize('reshape', [
    ('split_word', {'document': 'd1', 'ref': 's1.w1', 'at': '2'}),
    ('merge_words', {'document': 'd1', 'refs': ['s1.w1', 's1.w2']}),
    ('delete_word', {'document': 'd1', 'refs': ['s1.w1']}),
])
def test_an_unlink_on_a_morpheme_a_word_change_deletes_is_not_sent_again(reshape):
    """Reshaping s1.w1 deletes its morphemes, and the server takes l-2 on
    m-1b with them. Unlinking s1.w1.m2 in the same plan deleted l-2 by id
    after that, which the server refuses for a link it no longer has, and
    every approval failed. The link is gone either way."""
    w = scan_ws(FakeClient())
    assert call_tool(w, *reshape).startswith('Planned')
    assert call_tool(w, 'unlink_entry', {'document': 'd1', 'refs': ['s1.w1.m2']}).startswith('Planned')
    c = FakeClient()
    counts = execute_plan(c, w.plan_payload()['ops'], source='s', label='l')
    assert ('vocab_links.delete', 'l-2') not in c.calls, c.calls
    assert counts.get('unlinks') == 1, counts


def test_the_model_is_told_an_analysis_took_the_changes_planned_on_its_morphemes():
    """The note used to read as the generic "on the same targets", which a
    gloss planned on a morpheme and a new segmentation of its word are not:
    the model has to know the gloss is no longer planned, and how to plan it
    again."""
    w = scan_ws(FakeClient())
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1.m2'], 'field': 'Morph Gloss', 'value': 'DAT'})
    call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's1.w1.m1', 'type': 'root'})
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': [{'form': 'Ali'}, {'form': 'di'}]})
    assert '2 changes planned on the morphemes of a word this analysis replaces were taken out' in out, out
    assert 'set_field or set_morpheme with sN.wN.mN' in out, out
    # Said once.
    assert 'taken out' not in call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss',
                                                         'value': 'fish'})


@pytest.mark.parametrize('tool, args', [
    ('add_sense', {'entry_id': 'vi-gam', 'fields': {'gloss': 'fishing'}}),
    ('make_sense_of', {'entry_id': 'vi-gam2', 'under_id': 'vi-gam'}),
])
def test_a_sense_under_an_entry_gone_is_refused(tool, args):
    """The entry a new or moved sense hangs off is named in the metadata
    the plan writes, not by a key of the change. Deleted since, the sense
    was written hanging off nothing, which the lexicon then shows as an
    entry of its own."""
    w = scan_ws(FakeClient())
    assert call_tool(w, tool, args).startswith('Planned'), w.ops
    ops = w.plan_payload()['ops']
    c = FakeClient()
    _forget(c, 'vi-gam')
    with pytest.raises(PlanOutOfDate, match='no longer exists'):
        execute_plan(c, ops, source='s', label='l', project=w.project)
    assert c.batches == []
    execute_plan(FakeClient(), ops, source='s', label='l', project=w.project)
