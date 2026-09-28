"""A link to a morpheme of an analysis planned in the same plan.

"Segment this word like its other occurrences, linked to the same entries" was
two turns: set_analysis planned the new chain, and link_entry refused
sN.wN.mN because those morphemes did not exist until the plan was applied. Now
link_entry on a word whose analysis the plan writes names the PLANNED chain.
The link carries the word and the place (and the form it read there), and the
executor writes it once the analysis has minted the morpheme. A later change
to that analysis takes out a link to a place it no longer has, and approval
refuses such a link before anything is written.
"""

import pytest

import test_stale_by_sentence as sbs
from fixtures import FakeClient, scan_ws
from test_apply_lock import _bracket

from plaid_agent.core.conversation import ConversationStore, assistant_item, build_meta, user_item
from plaid_agent.core.plan import change_of
from plaid_agent.igt.plan import execute_plan
from plaid_agent.igt.toolkit import call_tool

VERIFIED = {'prov': 'inferred', 'provConfirmed': True}

# s1.w3 "akuna" has no stored morphemes, s2.w1 "Gam-ar" has two (m-4a, m-4b),
# and s1.w1 "Ali-di" has two, the second linked to -di (l-2).
AKUNA = {'document': 'd1', 'ref': 's1.w3',
         'morphemes': [{'form': 'akun', 'type': 'stem', 'fields': {'Morph Gloss': 'see'}},
                       {'form': 'a', 'type': 'suffix', 'fields': {'Morph Gloss': 'ERG'}}]}


def _link(ref, entry_id):
    return {'document': 'd1', 'refs': [ref], 'entry_id': entry_id}


def _links(client):
    """(entry, tokens, metadata) of every link the plan created, in order."""
    return [(p['args'][0], p['args'][1], p['args'][2]) for p in client.payloads('vocab_links.create')]


def _segment_and_link(w):
    call_tool(w, 'set_analysis', dict(AKUNA))
    out1 = call_tool(w, 'link_entry', _link('s1.w3.m1', 'vi-gam'))
    out2 = call_tool(w, 'link_entry', _link('s1.w3.m2', 'vi-erg'))
    return out1, out2


def test_a_plan_segments_a_word_and_links_each_new_morpheme():
    w = scan_ws(FakeClient())
    out1, out2 = _segment_and_link(w)
    assert out1.startswith('Planned 1 change') and out2.startswith('Planned 1 change'), (out1, out2)
    analysis, m1, m2 = w.ops
    assert analysis['kind'] == 'set_analysis'
    assert (m1['kind'], m1['token_id'], m1['analysis_word_id'], m1['morpheme_index'], m1['morpheme_form'],
            m1['item_id']) == ('link', None, 'w-3', 1, 'akun', 'vi-gam')
    assert (m2['morpheme_index'], m2['morpheme_form'], m2['item_id']) == (2, 'a', 'vi-erg')
    assert m1['existing_link_id'] is None and m1['reuses_morpheme_id'] is None

    c = FakeClient()
    counts = execute_plan(c, w.plan_payload()['ops'], source='service:igt:assist:x', label='l')
    assert counts == {'analyses': 1, 'lexicon links': 2}
    created = [p for kind, p in c.batches[0] if kind == 'tokens.create']
    assert [p['kwargs']['metadata']['form'] for p in created] == ['akun', 'a']
    # Written once the morphemes have ids, after the batch that minted them,
    # and verified, as everything an approved plan writes is.
    links = _links(c)
    assert [(item, tokens) for item, tokens, _ in links] == [('vi-gam', ['tokens-1']), ('vi-erg', ['tokens-2'])]
    for _, _, stamp in links:
        assert stamp == {**VERIFIED, 'provSource': 'service:igt:assist:x'}
    assert all(kind != 'vocab_links.create' for kind, _ in c.batches[0])


def test_the_card_places_each_link_at_its_new_morpheme():
    w = scan_ws(FakeClient())
    _segment_and_link(w)
    payload = w.plan_payload()
    rows = payload['changes']
    assert len(rows) == 3
    for row, (index, form, entry) in zip(rows[1:], ((1, 'akun', 'gam'), (2, 'a', '-di'))):
        where = row['where']
        assert (where['kind'], where['sentence'], where['word'], where['morpheme'], where['surface']) == \
            ('token', 1, 3, index, form)
        assert where['document_name'] == 'Text 1'
        assert row['change'] == f'link "{entry}"'
    assert payload['labels'][1] == 'Text 1 s1.w3.m1 "akun": link "gam"'
    assert payload['summary'] == '1 analysis, 2 lexicon links'


def test_the_kept_first_morpheme_is_linked_by_its_id_and_the_rest_once_minted():
    """An analysis of a word analysed before keeps the stored first morpheme
    and creates the others."""
    w = scan_ws(FakeClient())
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's2.w1',
                                  'morphemes': [{'form': 'Gam'}, {'form': 'a'}, {'form': 'r'}]})
    call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s2.w1.m1', 's2.w1.m3'], 'entry_id': 'vi-gam'})
    first = w.ops[1]
    assert first['reuses_morpheme_id'] == 'm-4a' and w.ops[2]['reuses_morpheme_id'] is None
    c = FakeClient()
    execute_plan(c, w.plan_payload()['ops'], source='s', label='l')
    assert [(item, tokens) for item, tokens, _ in _links(c)] == [('vi-gam', ['m-4a']), ('vi-gam', ['tokens-2'])]


def test_a_link_by_place_replaces_one_planned_on_the_same_kept_morpheme():
    """Linking s1.w1.m1 before and after its analysis was planned names the
    same morpheme, the stored first one the analysis keeps: one link, the
    later, and never two links written on it."""
    w = scan_ws(FakeClient())
    call_tool(w, 'link_entry', _link('s1.w1.m1', 'vi-ali'))
    assert w.ops[0]['token_id'] == 'm-1a'
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1',
                                  'morphemes': [{'form': 'Ali'}, {'form': 'd'}, {'form': 'i'}]})
    out = call_tool(w, 'link_entry', _link('s1.w1.m1', 'vi-gam'))
    assert 'superseded' in out
    assert [op['kind'] for op in w.ops] == ['link', 'set_analysis']
    assert w.ops[0]['analysis_word_id'] == 'w-1' and w.ops[0]['item_id'] == 'vi-gam'
    c = FakeClient()
    execute_plan(c, w.plan_payload()['ops'], source='s', label='l')
    assert [(item, tokens) for item, tokens, _ in _links(c)] == [('vi-gam', ['m-1a'])]


def test_a_morpheme_later_than_the_first_starts_with_no_link():
    """m-1b's link to -di goes with m-1b, which the analysis deletes, so a
    link at m2 replaces nothing."""
    w = scan_ws(FakeClient())
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': [{'form': 'Ali'}, {'form': 'di'}]})
    call_tool(w, 'link_entry', _link('s1.w1.m2', 'vi-erg'))
    assert w.ops[-1]['existing_link_id'] is None
    assert w.plan_payload()['changes'][-1]['change'] == 'link "-di"'


def test_dropping_the_analysis_drops_the_links_to_its_morphemes():
    w = scan_ws(FakeClient())
    _segment_and_link(w)
    out = call_tool(w, 'drop_planned', {'indexes': [1]})
    assert 'Links to the morphemes of a dropped analysis were dropped with it.' in out
    assert w.ops == []


def test_a_new_analysis_keeps_a_link_to_the_same_morpheme_and_drops_one_it_no_longer_has():
    w = scan_ws(FakeClient())
    _segment_and_link(w)
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w3',
                                        'morphemes': [{'form': 'akun'}, {'form': 'na'}]})
    assert '1 planned link to a morpheme of a planned analysis was dropped' in out
    assert [(op['kind'], op.get('morpheme_index')) for op in w.ops] == [('set_analysis', None), ('link', 1)]


def test_a_discard_of_the_planned_analysis_takes_its_links():
    """A discard of the word is its analysis's target too, and replaces it."""
    c = FakeClient()
    doc = c._documents['d1']
    morphs = next(t for t in doc['text_layers'][0]['token_layers'] if t['id'] == 'tk-morph')
    for m in morphs['tokens']:
        if m['id'] == 'm-4b':
            m['metadata'] = {**m['metadata'], 'prov': 'inferred', 'provSource': 'service:x'}
    w = scan_ws(c)
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's2.w1', 'morphemes': [{'form': 'Gam'}, {'form': 'ar'}]})
    call_tool(w, 'link_entry', _link('s2.w1.m2', 'vi-erg'))
    out = call_tool(w, 'discard_analysis', {'document': 'd1', 'refs': ['s2.w1']})
    assert [op['kind'] for op in w.ops] == ['discard_analysis'], out
    assert 'planned link to a morpheme of a planned analysis was dropped' in out


def test_a_place_the_planned_analysis_does_not_have_is_refused():
    w = scan_ws(FakeClient())
    call_tool(w, 'set_analysis', dict(AKUNA))
    out = call_tool(w, 'link_entry', _link('s1.w3.m3', 'vi-gam'))
    assert 'the analysis this plan gives "akuna" has 2 morphemes' in out
    assert len(w.ops) == 1


def test_without_a_planned_analysis_the_refusal_says_how_to_link_a_new_morpheme():
    w = scan_ws(FakeClient())
    out = call_tool(w, 'link_entry', _link('s1.w3.m1', 'vi-gam'))
    assert 'plan its analysis first (set_analysis), then link sN.wN.mN in the same plan' in out
    assert w.ops == []


def test_a_link_to_a_new_entry_on_a_new_morpheme_waits_for_both():
    w = scan_ws(FakeClient())
    call_tool(w, 'set_analysis', dict(AKUNA))
    out = call_tool(w, 'create_entry', {'form': 'akun', 'fields': {'gloss': 'see'}})
    key = out.split('entry_id: ')[1].split()[0]
    call_tool(w, 'link_entry', _link('s1.w3.m1', key))
    c = FakeClient()
    execute_plan(c, w.plan_payload()['ops'], source='s', label='l')
    [(item, tokens, _)] = _links(c)
    # Both ids come from the first batch: the entry's and the morpheme's.
    assert item.startswith('vocab_items-') and tokens == ['tokens-1']
    assert [k for k, _ in c.batches[0]].count('vocab_items.create') == 1
    assert ('vocab_links.create' in [k for k, _ in c.batches[1]])


def test_approval_refuses_a_link_whose_analysis_the_plan_does_not_hold_before_writing():
    w = scan_ws(FakeClient())
    _segment_and_link(w)
    link = dict(w.ops[1])
    for ops in ([link], [dict(w.ops[0], morphemes=[{'form': 'aku', 'fields': []}, {'form': 'na', 'fields': []}]),
                         link]):
        c = FakeClient()
        with pytest.raises(ValueError, match='names morpheme 1 of an analysis this plan does not hold'):
            execute_plan(c, ops, source='s', label='l')
        assert c.batches == []


def test_approval_as_human_writes_the_link_with_no_provenance():
    w = scan_ws(FakeClient())
    _segment_and_link(w)
    c = FakeClient()
    execute_plan(c, w.plan_payload()['ops'], source='s', label='l', stamp_mode='human')
    assert [stamp for _, _, stamp in _links(c)] == [{}, {}]


def test_the_link_depends_on_its_words_sentence():
    w = scan_ws(FakeClient())
    _segment_and_link(w)
    doc = w.doc('d1')
    assert w.op_sentences(w.ops[1], doc) == {'s-1'}
    [pinned] = w.plan_payload()['documents']
    assert [s['id'] for s in pinned['sentences']] == ['s-1']


# --- approved end to end, through the service --------------------------------

def _stage(client):
    """The analysis and its links planned as a turn would, and the card stored
    with an approval under way (test_stale_by_sentence's shape)."""
    spec = sbs._igt()
    w = spec['workspace'](client, spec['load'](client, spec['pid']))
    _segment_and_link(w)
    plan = w.plan_payload()
    store = ConversationStore(client, 'u@x', spec['pid'], 'igt')
    item = assistant_item('Planned.', plan, [], [], '', 'fake/model')
    conv = {'messages': [{'role': 'user', 'content': 'do it'}, {'role': 'assistant', 'content': 'Planned.'}],
            'display': [user_item('do it'), item]}
    meta = build_meta(None, 'c1', conv, 'igt:assist:fake', 'fake/model',
                      pending={'kind': 'apply', 'request_id': 'r9', 'plan_id': plan['id']})
    store.save('c1', conv, meta)
    return spec, plan, store


def test_an_approved_plan_writes_the_links_under_the_lock_and_verified():
    client = FakeClient()
    spec, plan, store = _stage(client)
    helper = sbs._approve(spec, client, plan)
    assert not helper.errors, helper.errors
    assert helper.done[-1]['kind'] == 'applied'
    links = _links(client)
    assert [(item, len(tokens)) for item, tokens, _ in links] == [('vi-gam', 1), ('vi-erg', 1)]
    for _, _, stamp in links:
        assert {k: stamp.get(k) for k in VERIFIED} == VERIFIED and stamp.get('provSource')
    lock, unlock = _bracket(client, 'd1')
    writes = [i for i, (k, _) in enumerate(client.calls) if k == 'vocab_links.create']
    assert len(writes) == 2 and all(lock < i < unlock for i in writes)
    conv, meta = store.load('c1')
    assert conv['display'][1]['status'] == 'applied' and meta['pending'] is None


def test_an_edit_to_the_words_sentence_refuses_the_plan_and_writes_nothing():
    client = FakeClient()
    spec, plan, store = _stage(client)
    sbs._edit(client, spec, spec['same'])  # a gloss on s1.w3
    helper = sbs._approve(spec, client, plan)
    assert helper.done == [] and len(helper.errors) == 1
    assert 'has changed since the plan was made' in helper.errors[0]
    assert client.payloads('vocab_links.create') == [] and client.payloads('tokens.create') == []
    conv, _ = store.load('c1')
    assert conv['display'][1]['status'] == 'stale'


def test_an_edit_to_another_sentence_leaves_the_plan_approvable():
    client = FakeClient()
    spec, plan, _store = _stage(client)
    sbs._edit(client, spec, spec['other'])  # a gloss in s2
    helper = sbs._approve(spec, client, plan)
    assert not helper.errors, helper.errors
    assert len(client.payloads('vocab_links.create')) == 2


def test_the_change_is_read_off_the_label_on_every_link_row():
    w = scan_ws(FakeClient())
    _segment_and_link(w)
    payload = w.plan_payload()
    for op, row in zip(payload['ops'][1:], payload['changes'][1:]):
        assert row['change'] == change_of(op)


# --- review 2026-09-28 -------------------------------------------------------

def _linked_kept_first():
    """The fixture with s2.w1's stored first morpheme m-4a linked to gam#2
    (l-3): the morpheme an analysis of s2.w1 keeps."""
    c = FakeClient()
    morph = c._documents['d1']['text_layers'][0]['token_layers'][2]
    morph['vocabs'][0]['vocab_links'].append(
        {'id': 'l-3', 'vocab_item': {'id': 'vi-gam2', 'form': 'gam'}, 'tokens': ['m-4a']})
    return c


def test_the_link_a_planned_link_replaces_goes_in_the_batch_that_writes_its_replacement():
    """The replacement is written in the second batch, once the analysis has
    run. Deleting the stored link in the first left the morpheme with no link
    at all when the second failed (an entry deleted since the plan was made)."""
    w = scan_ws(_linked_kept_first())
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's2.w1', 'morphemes': [{'form': 'Gam'}, {'form': 'ar'}]})
    call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s2.w1.m1'], 'entry_id': 'vi-ali'})
    c = _linked_kept_first()
    execute_plan(c, w.plan_payload()['ops'], source='s', label='l')
    [second] = [b for b in c.batches if any(k == 'vocab_links.create' for k, _ in b)]
    assert ('vocab_links.delete', 'l-3') in second
    assert ('vocab_links.delete', 'l-3') not in c.batches[0]


def test_a_link_by_place_on_the_kept_first_morpheme_must_name_the_morpheme_the_analysis_keeps():
    """The executor writes a link at m1 on whatever the analysis keeps. A link
    made against another first morpheme (a chain read in another order) would
    replace the link of a morpheme the analysis deletes."""
    w = scan_ws(_linked_kept_first())
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's2.w1', 'morphemes': [{'form': 'Gam'}, {'form': 'ar'}]})
    call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s2.w1.m1'], 'entry_id': 'vi-ali'})
    analysis, link = w.ops
    moved = dict(analysis, existing=list(reversed(analysis['existing'])))
    with pytest.raises(ValueError, match='names morpheme 1 of an analysis this plan does not hold'):
        execute_plan(FakeClient(), [moved, link], source='s', label='l')
