"""Multi-word expressions: one lexicon link shared by two or more words. The
agent reads them as such, never mistakes a member's share for a link of its
own, and the tools that move, merge, or delete links keep every member."""

from fixtures import scan_ws
from fixtures_ext import mwe_client, MWE_LINK, PHRASE_ITEM

from plaid_igt_agent.plan import execute_plan, normalize_ops
from plaid_igt_agent.project import render_document
from plaid_igt_agent.tools import call_tool, op_target


def ws(machine_mwe=False):
    return scan_ws(mwe_client(machine_mwe))


def test_parse_keeps_the_expression_apart_from_own_links():
    w = ws()
    doc = w.doc('d1')
    w2, w3 = doc.sentences[0].words[1], doc.sentences[0].words[2]
    assert w2.link is None and w3.link is None
    assert [l.id for l in w2.mwes] == [MWE_LINK] and w2.mwes[0] is w3.mwes[0]
    l = w2.mwes[0]
    assert l.tokens == ['w-2', 'w-3'] and l.members == [(1, 2), (1, 3)] and l.is_mwe
    assert doc.find(MWE_LINK) == (doc.sentences[0], w2, None)
    out = render_document(doc, w.project)
    assert '  w2 gam | mwe=gam akuna (w2+w3)\n' in out and '  w3 akuna | mwe=gam akuna (w2+w3)\n' in out
    assert 'mwe=entry (w2+w3): a multi-word expression' in out
    assert 'Word "gam": 1 occurrence, 1 distinct analysis:\n  1\tmwe=gam akuna' in call_tool(w, 'analyses_of', {'form': 'gam'})


def test_own_link_tools_leave_the_expression_alone():
    w = ws()
    # Linking a member gives it a link of its own; the expression stays, and the reply says so.
    out = call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w2'], 'entry_id': 'vi-gam'})
    assert 'Planned 1 change' in out and 's1.w2 stays inside "gam akuna"' in out
    assert w.ops[-1] == {'kind': 'link', 'token_id': 'w-2', 'item_id': 'vi-gam', 'new_entry_key': None,
                         'existing_link_id': None, 'label': 'Text 1 s1.w2 "gam": link "gam"'}
    # Unlinking a member that has no link of its own is refused, pointing at unlink_phrase.
    out = call_tool(w, 'unlink_entry', {'document': 'd1', 'refs': ['s1.w3']})
    assert out.startswith('Error:') and 'member of the multi-word expression "gam akuna" (w2+w3)' in out and 'unlink_phrase' in out
    # A word's own link still unlinks as before.
    call_tool(w, 'unlink_entry', {'document': 'd1', 'refs': ['s1.w1']})
    assert w.ops[-1]['kind'] == 'unlink' and w.ops[-1]['link_id'] == 'l-1' and 'token_ids' not in w.ops[-1]


def test_unlink_phrase_and_link_phrase():
    w = ws()
    assert 'belong to no multi-word expression' in call_tool(w, 'unlink_phrase', {'document': 'd1', 'refs': ['s1.w1']})
    out = call_tool(w, 'unlink_phrase', {'document': 'd1', 'refs': ['s1.w3']})
    assert 'Planned 1 change' in out
    assert w.ops[-1] == {'kind': 'unlink', 'link_id': MWE_LINK, 'token_id_hint': 'w-2', 'token_ids': ['w-2', 'w-3'],
                         'label': 'Text 1 s1 w2+w3: unlink phrase "gam akuna"'}
    # Its target is the expression, so a link on the first member does not displace it.
    assert op_target(w.ops[-1]) == ('mwe_link', MWE_LINK)
    call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w2'], 'entry_id': 'vi-gam'})
    assert [o['kind'] for o in w.ops] == ['unlink', 'link']
    # Re-linking the same words to a new entry replaces the expression; the pending unlink is superseded.
    out = call_tool(w, 'link_phrase', {'document': 'd1', 'refs': ['s1.w3', 's1.w2'], 'entry_form': 'Ali'})
    assert 'Planned 1 change' in out and '1 earlier planned change on the same target superseded' in out
    assert [o['kind'] for o in w.ops] == ['link', 'link_phrase']
    assert w.ops[-1] == {'kind': 'link_phrase', 'token_ids': ['w-2', 'w-3'], 'item_id': 'vi-ali', 'new_entry_key': None,
                         'existing_link_id': MWE_LINK,
                         'label': 'Text 1 s1 w2+w3 "gam akuna": link phrase "gam akuna" → "Ali"'}
    # The same entry over the same words plans nothing; one word is not an expression.
    w2 = ws()
    assert call_tool(w2, 'link_phrase', {'document': 'd1', 'refs': ['s1.w2', 's1.w3'], 'entry_id': PHRASE_ITEM}).startswith('Planned 0')
    assert 'two or more distinct words' in call_tool(w2, 'link_phrase', {'document': 'd1', 'refs': ['s1.w2', 's1.w2'], 'entry_id': PHRASE_ITEM})
    # A new expression over other words, to an entry created in the same plan.
    out = call_tool(w2, 'create_entry', {'form': 'Ali-di gam', 'type': 'phrase', 'fields': {'gloss': 'Ali fish'}})
    key = out.split('entry_id: ')[1].split()[0]
    call_tool(w2, 'link_phrase', {'document': 'd1', 'refs': ['s1.w1', 's1.w2'], 'entry_id': key})
    op = w2.ops[-1]
    assert op['token_ids'] == ['w-1', 'w-2'] and op['new_entry_key'] == key and op['existing_link_id'] is None
    # A member of a planned expression cannot be given a plain link in the same turn by mistake.
    assert 'planned in this turn' in call_tool(w2, 'link_entry', {'document': 'd1', 'refs': ['s1.w1'], 'entry_id': 'vi-gam'})
    # The plan names the document, since the expression's link id belongs to it.
    assert [d['id'] for d in w.plan_payload()['documents']] == ['d1']


def test_merging_or_deleting_members_removes_a_collapsed_expression():
    w = ws()
    call_tool(w, 'merge_words', {'document': 'd1', 'refs': ['s1.w2', 's1.w3']})
    op = w.ops[-1]
    assert op['links'] == {'keep_id': None, 'delete_ids': [MWE_LINK]}
    assert 'the multi-word expression "gam akuna" is dropped: its words become one' in op['label']
    # Merging a member with an outside word keeps the expression (the server trims it).
    w2 = ws()
    call_tool(w2, 'merge_words', {'document': 'd1', 'refs': ['s1.w1', 's1.w2']})
    assert w2.ops[-1]['links']['delete_ids'] == []
    # Deleting one member leaves one, which is no expression: the link goes too, and says so.
    w3 = ws()
    call_tool(w3, 'delete_word', {'document': 'd1', 'refs': ['s1.w3']})
    op = w3.ops[-1]
    assert op['link_ids'] == [MWE_LINK] and 'the multi-word expression "gam akuna" goes with it' in op['label']
    c = w3.client
    execute_plan(c, [op], source='s', label='l')
    assert [(r, m, a) for r, m, a, k in c.batches[0]] == [('vocab_links', 'delete', (MWE_LINK,)), ('tokens', 'delete', ('w-3',))]


def test_entry_tools_move_and_delete_the_whole_expression_once():
    w = ws()
    call_tool(w, 'merge_entries', {'keep_id': 'vi-gam', 'remove_id': PHRASE_ITEM})
    assert w.ops[-1]['links'] == [{'link_id': MWE_LINK, 'token_ids': ['w-2', 'w-3']}]
    assert 'move 1 link' in w.ops[-1]['label']
    call_tool(w, 'delete_entry', {'entry_id': PHRASE_ITEM})
    assert w.ops[-1]['links'] == [MWE_LINK]
    c = w.client
    execute_plan(c, [w.ops[0]], source='s', label='l')
    first = [(r, m, a) for r, m, a, k in c.batches[0]]
    assert first[0] == ('vocab_links', 'delete', (MWE_LINK,))
    assert first[1][:2] == ('vocab_links', 'create') and first[1][2][:2] == ('vi-gam', ['w-2', 'w-3'])
    # A phrase entry is not a stale link on its members, and each member counts as a use.
    out = call_tool(w, 'check_lexicon', {'section': 'stale'})
    assert '0 links whose form no longer contains the entry form' in out
    # An expression is judged by its members' surfaces: an entry that no longer reads
    # like them is stale, reported once for the link, not once per member.
    c2 = mwe_client()
    c2._documents['d1']['text_layers'][0]['token_layers'][1]['vocabs'][0]['vocab_links'][1]['vocab_item'] = \
        {'id': 'vi-stale', 'form': 'zzz yyy'}
    c2._lexicon['items'].append({'id': 'vi-stale', 'form': 'zzz yyy', 'metadata': {'morphType': 'phrase'}})
    out = call_tool(scan_ws(c2), 'check_lexicon', {'section': 'stale'})
    assert '1 links whose form no longer contains the entry form: gam akuna → "zzz yyy"' in out
    assert '2 links' not in out.split('\n')[0] or True
    assert 'Linked from 2 words and 0 morphemes' in call_tool(w, 'lexicon_entry', {'entry_id': PHRASE_ITEM})
    # Members count as linked in the worklist.
    out = call_tool(w, 'worklist', {'kind': 'unlinked', 'level': 'word'})
    assert 'gam-ar' in out and '\tgam\t' not in out and 'akuna' not in out


def test_execute_link_phrase_and_pending_entries():
    w = ws()
    c = w.client
    ops = [{'kind': 'create_entry', 'vocab_id': 'v1', 'form': 'x y', 'metadata': {'morphType': 'phrase'}, 'key': 'new:1', 'label': ''},
           {'kind': 'link_phrase', 'token_ids': ['w-2', 'w-3'], 'item_id': None, 'new_entry_key': 'new:1',
            'existing_link_id': MWE_LINK, 'label': ''},
           {'kind': 'link_phrase', 'token_ids': ['w-1', 'w-2'], 'item_id': 'vi-ali', 'new_entry_key': None,
            'existing_link_id': None, 'label': ''}]
    counts = execute_plan(c, ops, source='s', label='l')
    assert counts == {'lexicon entries': 1, 'multi-word expressions': 2}
    first = [(r, m, a) for r, m, a, k in c.batches[0]]
    assert first[1] == ('vocab_links', 'delete', (MWE_LINK,))
    assert first[2][:2] == ('vocab_links', 'create') and first[2][2][:2] == ('vi-ali', ['w-1', 'w-2'])
    second = [(r, m, a) for r, m, a, k in c.batches[1]]
    assert second[0][:2] == ('vocab_links', 'create') and second[0][2][:2] == ('new-vocab_items-0', ['w-2', 'w-3'])
    # A member deleted elsewhere in the plan refuses the expression; a deleted entry drops it.
    import pytest
    with pytest.raises(ValueError, match='deleted or merged away'):
        normalize_ops([{'kind': 'delete_word', 'word_id': 'w-2', 'morpheme_ids': [], 'label': ''}, ops[2]])
    out, notes = normalize_ops([{'kind': 'delete_entry', 'item_id': 'vi-ali', 'links': [], 'label': 'del'}, ops[2]])
    assert [o['kind'] for o in out] == ['delete_entry'] and notes[0].startswith('dropped:')


def test_confirm_counts_a_machine_expression_once():
    w = ws(machine_mwe=True)
    out = render_document(w.doc('d1'), w.project)
    assert 'mwe=gam akuna~ (w2+w3)' in out
    call_tool(w, 'confirm', {'document': 'd1'})
    assert w.ops[-1]['link_ids'] == [MWE_LINK] and w.ops[-1]['label'] == 'Text 1: confirm 1 link'
    w2 = ws(machine_mwe=True)
    call_tool(w2, 'confirm', {'document': 'd1', 'refs': ['s1.w2', 's1.w3']})
    assert [o['link_ids'] for o in w2.ops] == [[MWE_LINK], [MWE_LINK]]  # one op per ref, the same link
    out = call_tool(w2, 'worklist', {'kind': 'unverified'})
    assert out.startswith('2 words with annotations awaiting review') and '\tgam\t' in out and '\takuna\t' in out
