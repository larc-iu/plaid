"""delete_sentence: a whole sentence deleted, its text with it, as plaid-igt
deletes text (BRIEF-JS). The tool's refusals, the op and its card row, and the
executor through the fake client. On a real core: test_delete_sentence_live.py."""

import pytest
from fixtures import FakeClient, document_raw, fake_ws

from plaid_agent.igt.plan import KIND, PlanError, execute_plan
from plaid_agent.igt.project import load_project
from plaid_agent.igt.shape import deleted_stretch
from plaid_agent.igt.toolkit import call_tool
from test_shape import _TextServer


def ws(raw=None):
    return fake_ws(FakeClient(documents={'d1': raw or document_raw()}))


def test_the_stretch_is_the_one_the_app_deletes_with_a_segment():
    # plaid-igt's planDeleteText: the whitespace around the text goes, one
    # separator kept when text is left on both sides.
    body = 'ka ta.\n\nsa.\n\nga.'
    assert deleted_stretch(body, 8, 13) == (7, 13)  # "sa.\n\n" in the middle: one "\n" kept
    assert deleted_stretch(body, 0, 8) == (0, 8)  # the first: nothing before it
    assert deleted_stretch(body, 13, 16) == (11, 16)  # the last: the whitespace before it goes
    assert deleted_stretch('sa.', 0, 3) == (0, 3)  # the only one
    assert deleted_stretch('  ', 0, 2) == (0, 2)


def test_it_stages_one_deletion_per_sentence_named_with_its_text():
    w = ws()
    out = call_tool(w, 'delete_sentence', {'document': 'd1', 'refs': ['s1', 's1']})
    assert out.startswith('Planned 1 change'), out
    [op] = w.ops
    assert op == {'kind': 'delete_sentence', 'document_id': 'd1', 'sentence_id': 's-1', 'old': 'Ali-di gam akuna.',
                  'word_ids': ['w-1', 'w-2', 'w-3'], 'morpheme_ids': ['m-1a', 'm-1b', 'm-2', 'virtual:w-3'],
                  'span_ids': ['sp-t1', 'sp-g1', 'sp-m1a', 'sp-m1b'], 'link_ids': ['l-1', 'l-2'], 'mwe_ids': [],
                  'label': 'Text 1 s1: delete the sentence "Ali-di gam akuna." and everything on it',
                  'change_at': 11}
    w2 = ws()
    assert call_tool(w2, 'delete_sentence', {'document': 'd1', 'refs': ['s2', 's1']}).startswith('Planned 2 changes')
    assert [o['sentence_id'] for o in w2.ops] == ['s-2', 's-1']


def test_a_long_sentence_is_cut_on_the_card_as_a_retype_is():
    raw = document_raw()
    raw['text_layers'][0]['text']['body'] = 'Ali-di gam akuna. Gam-ar akuna akuna akuna akuna akuna akuna.'
    raw['text_layers'][0]['token_layers'][0]['tokens'][1]['end'] = len(raw['text_layers'][0]['text']['body'])
    w = ws(raw)
    call_tool(w, 'delete_sentence', {'document': 'd1', 'refs': ['s2']})
    assert w.ops[0]['label'] == ('Text 1 s2: delete the sentence "Gam-ar akuna akuna akuna akuna akuna aku…" '
                                 'and everything on it')


def test_a_plan_of_deletions_offers_one_approve_and_is_marked_as_changing_the_text():
    w = ws()
    call_tool(w, 'delete_sentence', {'document': 'd1', 'refs': ['s2']})
    p = w.plan_payload()
    assert p['stamp_choice'] is False
    [row] = p['changes']
    assert row['writes_text'] == 1
    assert KIND['delete_sentence'].stamped is False
    # Ann's (the fixture's) values and analysis are someone's work it deletes.
    w2 = ws()
    call_tool(w2, 'delete_sentence', {'document': 'd1', 'refs': ['s1']})
    assert w2.plan_payload()['changes'][0]['replaces_work'] > 0


@pytest.mark.parametrize('refs, said', [
    ([], 'Give the sentences to delete'),
    (['s9'], 's9'),
    (['s1.w1'], 's1.w1'),
])
def test_it_refuses_what_is_no_sentence(refs, said):
    w = ws()
    out = call_tool(w, 'delete_sentence', {'document': 'd1', 'refs': refs})
    assert said in out and not out.startswith('Planned'), out
    assert not w.ops


def test_nothing_else_in_the_plan_may_write_in_a_sentence_it_deletes_in_either_order():
    later = [('set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'fish'}),
             ('set_field', {'document': 'd1', 'refs': ['s1'], 'field': 'Translation', 'value': 'x'}),
             ('split_word', {'document': 'd1', 'ref': 's1.w1', 'at': 'Ali'}),
             ('respell', {'document': 'd1', 'ref': 's1.w2', 'new_text': 'gham'}),
             ('retype_sentence', {'document': 'd1', 'ref': 's1', 'text': 'Ali-di gam.'}),
             ('merge_sentences', {'document': 'd1', 'ref': 's2'}),
             ('add_comment', {'document': 'd1', 'ref': 's1', 'body': 'Check this.'})]
    for name, args in later:
        w = ws()
        assert call_tool(w, 'delete_sentence', {'document': 'd1', 'refs': ['s1']}).startswith('Planned')
        out = call_tool(w, name, args)
        assert not out.startswith('Planned'), (name, out)
        assert [o['kind'] for o in w.ops] == ['delete_sentence'], name
    for name, args in later:
        w = ws()
        first = call_tool(w, name, args)
        assert first.startswith('Planned'), (name, first)
        kinds = [o['kind'] for o in w.ops]
        out = call_tool(w, 'delete_sentence', {'document': 'd1', 'refs': ['s1']})
        assert not out.startswith('Planned') and [o['kind'] for o in w.ops] == kinds, (name, out)


def test_a_split_of_the_sentence_is_replaced_by_its_deletion_as_with_a_word():
    w = ws()
    call_tool(w, 'split_sentence', {'document': 'd1', 'ref': 's1', 'before_word': 2})
    out = call_tool(w, 'delete_sentence', {'document': 'd1', 'refs': ['s1']})
    assert 'superseded' in out and [o['kind'] for o in w.ops] == ['delete_sentence']


def test_other_sentences_of_the_document_are_written_in_beside_it():
    w = ws()
    for name, args in (('delete_sentence', {'document': 'd1', 'refs': ['s2']}),
                       ('set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'fish'}),
                       ('retype_sentence', {'document': 'd1', 'ref': 's1', 'text': 'Ali-di gam gam akuna.'}),
                       ('append_text', {'document': 'd1', 'text': 'Gam akuna.'})):
        out = call_tool(w, name, args)
        assert out.startswith('Planned'), (name, out)
    assert [o['kind'] for o in w.ops] == ['delete_sentence', 'set_span', 'edit_text', 'edit_text']


def _executed(ops, raw=None):
    c = FakeClient(documents={'d1': raw or document_raw()})
    server = _TextServer(c)
    counts = execute_plan(c, ops, source='service:igt:assist:m', label='l', project=load_project(c, 'p1'))
    return c, server, counts


def test_applied_the_text_goes_through_the_text_edit_and_core_takes_the_rest():
    w = ws()
    call_tool(w, 'delete_sentence', {'document': 'd1', 'refs': ['s2']})
    c, _s, counts = _executed(w.ops)
    assert counts == {'deleted sentences': 1}
    assert c.payloads('texts.edit') == [('text1', [{'type': 'delete', 'index': 17, 'value': 8}])]
    assert c._documents['d1']['text_layers'][0]['text']['body'] == 'Ali-di gam akuna.'
    # Nothing deleted one by one: the text edit's own cascade takes them.
    assert not [k for k, _ in c.calls if k.startswith(('tokens.', 'spans.', 'vocab_links.'))]
    w2 = ws()
    call_tool(w2, 'delete_sentence', {'document': 'd1', 'refs': ['s1']})
    c2, _s, _n = _executed(w2.ops)
    assert c2.payloads('texts.edit') == [('text1', [{'type': 'delete', 'index': 0, 'value': 18}])]
    assert c2._documents['d1']['text_layers'][0]['text']['body'] == 'Gam-ar.'


def test_both_sentences_deleted_leave_an_empty_text():
    w = ws()
    call_tool(w, 'delete_sentence', {'document': 'd1', 'refs': ['s1', 's2']})
    c, _s, counts = _executed(w.ops)
    assert counts == {'deleted sentences': 2}
    assert c._documents['d1']['text_layers'][0]['text']['body'] == ''


def test_a_deletion_with_a_retype_of_another_sentence_finds_its_sentence_where_the_retype_left_it():
    w = ws()
    call_tool(w, 'delete_sentence', {'document': 'd1', 'refs': ['s2']})
    call_tool(w, 'retype_sentence', {'document': 'd1', 'ref': 's1', 'text': 'Ali-di gam gam akuna.'})
    c, _s, _n = _executed(w.ops)
    assert c._documents['d1']['text_layers'][0]['text']['body'] == 'Ali-di gam gam akuna.'


def test_a_sentence_gone_or_changed_since_is_not_deleted_and_nothing_else_is():
    w = ws()
    call_tool(w, 'delete_sentence', {'document': 'd1', 'refs': ['s2']})
    gone = document_raw()
    gone['text_layers'][0]['token_layers'][0]['tokens'] = gone['text_layers'][0]['token_layers'][0]['tokens'][:1]
    changed = document_raw()
    changed['text_layers'][0]['text']['body'] = 'Ali-di gam akuna. Gam-ox.'
    for raw in (gone, changed):
        with pytest.raises(PlanError, match='no longer there as it was'):
            _executed(w.ops, raw)


def test_a_multi_word_expression_left_with_one_member_goes_first():
    raw = document_raw()
    raw['text_layers'][0]['token_layers'][1]['vocabs'][0]['vocab_links'].append(
        {'id': 'l-mwe', 'vocab_item': {'id': 'vi-gam', 'form': 'gam'}, 'tokens': ['w-3', 'w-4']})
    w = ws(raw)
    call_tool(w, 'delete_sentence', {'document': 'd1', 'refs': ['s2']})
    assert w.ops[0]['mwe_ids'] == ['l-mwe']
    c, _s, _n = _executed(w.ops, raw)
    kinds = [k for k, _ in c.calls]
    assert kinds.index('vocab_links.delete') < kinds.index('texts.edit')


def test_a_retype_to_nothing_names_the_tool_that_deletes_a_sentence():
    w = ws()
    out = call_tool(w, 'retype_sentence', {'document': 'd1', 'ref': 's2', 'text': '  '})
    assert 'delete_sentence' in out and not w.ops
