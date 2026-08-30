"""Word split/merge/delete and sentence split/merge: plan tools and execution."""
import pytest
from fixtures import FakeClient, document_raw, GLOSS, VOCAB

from plaid_igt_agent.project import load_project
from plaid_igt_agent.tools import Workspace, call_tool
from plaid_igt_agent.plan import execute_plan, normalize_ops


def ws(raw=None):
    c = FakeClient(documents={'d1': raw} if raw else None)
    return Workspace(c, load_project(c, 'p1'))


def test_split_word_by_left_part_or_length():
    w = ws()
    out = call_tool(w, 'split_word', {'document': 'd1', 'ref': 's1.w1', 'at': 'Ali'})
    assert 'Planned 1 change' in out
    op = w.ops[0]
    assert (op['kind'], op['word_id'], op['position'], op['morpheme_ids']) == ('split_word', 'w-1', 3, ['m-1a', 'm-1b'])
    assert op['label'] == ('Text 1 s1.w1 "Ali-di": split into "Ali" + "-di" (its 2-morpheme analysis is deleted; '
                           're-analyse both parts afterwards) (word values and link stay on the left part)')
    w2 = ws()
    call_tool(w2, 'split_word', {'document': 'd1', 'ref': 's1.w3', 'at': '3'})
    assert w2.ops[0]['position'] == 14 and w2.ops[0]['morpheme_ids'] == [] and '(its' not in w2.ops[0]['label']
    assert 'between 1 and 4' in call_tool(w2, 'split_word', {'document': 'd1', 'ref': 's1.w3', 'at': 5})
    assert 'not the start of' in call_tool(w2, 'split_word', {'document': 'd1', 'ref': 's1.w3', 'at': 'xy'})
    # A later split or delete of the same word replaces the earlier one; a merge refuses it.
    assert 'superseded' in call_tool(w, 'delete_word', {'document': 'd1', 'refs': ['s1.w1']})
    assert [o['kind'] for o in w.ops] == ['delete_word']
    assert 'already split, merged, or deleted' in call_tool(w, 'merge_words', {'document': 'd1', 'refs': ['s1.w1', 's1.w2']})
    call_tool(w2, 'merge_words', {'document': 'd1', 'refs': ['s1.w1', 's1.w2']})
    assert 'already split, merged, or deleted' in call_tool(w2, 'split_word', {'document': 'd1', 'ref': 's1.w2', 'at': 1})


def test_merge_words_dedups_values_and_links():
    raw = document_raw()
    layers = raw['text_layers'][0]['token_layers']
    layers[1]['span_layers'][0]['spans'].append({'id': 'sp-g2', 'value': 'fish', 'tokens': ['w-2']})
    layers[1]['vocabs'][0]['vocab_links'].append({'id': 'l-w2', 'vocab_item': {'id': 'vi-gam', 'form': 'gam'}, 'tokens': ['w-2']})
    w = ws(raw)
    out = call_tool(w, 'merge_words', {'document': 'd1', 'refs': ['s1.w2', 's1.w1']})  # any order
    assert 'Planned 1 change' in out
    op = w.ops[0]
    assert op['word_id'] == 'w-1' and op['other_ids'] == ['w-2'] and op['morpheme_ids'] == ['m-1a', 'm-1b', 'm-2']
    assert op['spans'] == [{'layer_id': GLOSS, 'keep_id': 'sp-g1', 'value': 'Ali | fish', 'delete_ids': ['sp-g2']}]
    assert op['links'] == {'keep_id': 'l-1', 'delete_ids': ['l-w2']}
    assert op['label'] == ('Text 1 s1: merge w1 "Ali-di" + w2 "gam" → "Ali-di gam" (1 morpheme analysis deleted) '
                           '(values combined: Gloss "Ali | fish") (keeps the link "Ali", drops 1)')
    w2 = ws()
    call_tool(w2, 'merge_words', {'document': 'd1', 'refs': ['s1.w2', 's1.w3']})
    assert w2.ops[0]['spans'] == [] and w2.ops[0]['links'] == {'keep_id': None, 'delete_ids': []}
    assert w2.ops[0]['label'] == 'Text 1 s1: merge w2 "gam" + w3 "akuna" → "gam akuna"'
    assert 'not consecutive' in call_tool(ws(), 'merge_words', {'document': 'd1', 'refs': ['s1.w1', 's1.w3']})
    assert 'same sentence' in call_tool(ws(), 'merge_words', {'document': 'd1', 'refs': ['s1.w3', 's2.w1']})
    assert 'at least two' in call_tool(ws(), 'merge_words', {'document': 'd1', 'refs': ['s1.w3']})
    # Punctuation between the words would be swallowed: refused (same offsets, a comma for the space).
    raw = document_raw()
    raw['text_layers'][0]['text']['body'] = 'Ali-di gam,akuna. Gam-ar.'
    assert '"," lies between "gam" and "akuna"' in call_tool(ws(raw), 'merge_words', {'document': 'd1', 'refs': ['s1.w2', 's1.w3']})


def test_delete_word_and_sentence_ops():
    w = ws()
    out = call_tool(w, 'delete_word', {'document': 'd1', 'refs': ['s1.w3', 's1.w1']})
    assert 'Planned 2 changes' in out
    assert w.ops[0] == {'kind': 'delete_word', 'word_id': 'w-3', 'morpheme_ids': [],
                        'label': 'Text 1 s1.w3 "akuna": delete the word token (the text stays)'}
    assert w.ops[1]['word_id'] == 'w-1' and w.ops[1]['morpheme_ids'] == ['m-1a', 'm-1b'] and 'analysis, values, and link go' in w.ops[1]['label']

    out = call_tool(w, 'split_sentence', {'document': 'd1', 'ref': 's1', 'before_word': 2})
    assert 'Planned 1 change' in out
    assert w.ops[-1] == {'kind': 'split_sentence', 'sentence_id': 's-1', 'position': 7,
                         'label': 'Text 1 s1: split before w2 "gam" → "Ali-di" | "gam akuna." '
                                  '(sentence values such as the translation stay with the first part)'}
    assert 'between 2 and 3' in call_tool(w, 'split_sentence', {'document': 'd1', 'ref': 's1', 'before_word': 1})
    assert 'superseded' in call_tool(w, 'split_sentence', {'document': 'd1', 'ref': 's1', 'before_word': 3})
    assert w.ops[-1]['position'] == 11 and sum(o['kind'] == 'split_sentence' for o in w.ops) == 1
    assert 'already split' in call_tool(w, 'merge_sentences', {'document': 'd1', 'ref': 's2'})

    w2 = ws()
    out = call_tool(w2, 'merge_sentences', {'document': 'd1', 'ref': 's2'})
    assert 'Planned 1 change' in out
    assert w2.ops[0] == {'kind': 'merge_sentences', 'sentence_id': 's-1', 'other_id': 's-2', 'spans': [],
                         'label': 'Text 1: merge s2 "Gam-ar." into s1 "Ali-di gam akuna."'}
    assert 'first sentence' in call_tool(w2, 'merge_sentences', {'document': 'd1', 'ref': 's1'})
    # A translation on both sentences is combined.
    raw = document_raw()
    raw['text_layers'][0]['token_layers'][0]['span_layers'][0]['spans'].append({'id': 'sp-t2', 'value': 'Fish.', 'tokens': ['s-2']})
    w3 = ws(raw)
    call_tool(w3, 'merge_sentences', {'document': 'd1', 'ref': 's2'})
    assert w3.ops[0]['spans'] == [{'layer_id': 'sl-trans', 'keep_id': 'sp-t1', 'value': 'Ali saw a fish. | Fish.', 'delete_ids': ['sp-t2']}]
    assert '(values combined: Translation "Ali saw a fish. | Fish.")' in w3.ops[0]['label']


def test_execute_shape_ops_in_order():
    c = FakeClient()
    ops = [{'kind': 'split_word', 'word_id': 'w-1', 'position': 3, 'morpheme_ids': ['m-1a', 'm-1b'], 'label': ''},
           {'kind': 'merge_words', 'word_id': 'w-2', 'other_ids': ['w-3', 'w-x'], 'morpheme_ids': ['m-2'],
            'spans': [{'layer_id': GLOSS, 'keep_id': 'sp-a', 'value': 'a | b', 'delete_ids': ['sp-b']},
                      {'layer_id': 'L2', 'keep_id': 'sp-c', 'value': None, 'delete_ids': ['sp-d']}],
            'links': {'keep_id': 'l-a', 'delete_ids': ['l-b']}, 'label': ''},
           {'kind': 'delete_word', 'word_id': 'w-4', 'morpheme_ids': ['m-4a', 'm-4b'], 'label': ''},
           {'kind': 'split_sentence', 'sentence_id': 's-1', 'position': 7, 'label': ''},
           {'kind': 'merge_sentences', 'sentence_id': 's-1', 'other_id': 's-2',
            'spans': [{'layer_id': 'sl-trans', 'keep_id': 'sp-t1', 'value': 'x | y', 'delete_ids': ['sp-t2']}], 'label': ''}]
    counts = execute_plan(c, ops, source='s', label='l')
    assert counts == {'split words': 1, 'merged words': 1, 'deleted words': 1, 'split sentences': 1, 'merged sentences': 1}
    calls = [(r, m, a) for r, m, a, k in c.batches[0]]
    assert calls == [
        ('tokens', 'bulk_delete', (['m-1a', 'm-1b'],)), ('tokens', 'split', ('w-1', 3)),
        ('tokens', 'bulk_delete', (['m-2'],)), ('tokens', 'merge', ('w-2', 'w-3')), ('tokens', 'merge', ('w-2', 'w-x')),
        ('spans', 'update', ('sp-a', 'a | b')), ('spans', 'delete', ('sp-b',)), ('spans', 'delete', ('sp-d',)),
        ('vocab_links', 'delete', ('l-b',)),
        ('tokens', 'delete', ('w-4',)),
        ('tokens', 'split', ('s-1', 7)),
        ('tokens', 'merge', ('s-1', 's-2')), ('spans', 'update', ('sp-t1', 'x | y')), ('spans', 'delete', ('sp-t2',))]


def test_ops_on_tokens_a_shape_op_removes_are_refused_or_filtered():
    dead = [{'kind': 'delete_word', 'word_id': 'w-4', 'morpheme_ids': ['m-4a', 'm-4b'], 'label': ''}]
    with pytest.raises(ValueError, match='deleted or merged away'):
        normalize_ops(dead + [{'kind': 'set_span', 'layer_id': 'L', 'token_id': 'w-4', 'span_id': None, 'value': 'v', 'label': 'gloss w4'}])
    with pytest.raises(ValueError, match='deleted or merged away'):
        normalize_ops(dead + [{'kind': 'set_morpheme_form', 'morpheme_id': 'm-4b', 'form': 'x', 'label': ''}])
    with pytest.raises(ValueError, match='deleted or merged away'):
        normalize_ops([{'kind': 'merge_words', 'word_id': 'w-2', 'other_ids': ['w-3'], 'morpheme_ids': [], 'spans': [], 'links': {}, 'label': ''},
                       {'kind': 'link', 'token_id': 'w-3', 'item_id': 'vi', 'label': ''}])
    out, notes = normalize_ops(dead + [{'kind': 'confirm', 'span_ids': [], 'token_ids': ['m-4a', 'm-9'], 'link_ids': [], 'label': ''}])
    assert out[1]['token_ids'] == ['m-9'] and notes == []
    # The survivor of a merge may still be written to.
    out, _ = normalize_ops([{'kind': 'merge_words', 'word_id': 'w-2', 'other_ids': ['w-3'], 'morpheme_ids': [], 'spans': [], 'links': {}, 'label': ''},
                            {'kind': 'set_span', 'layer_id': 'L', 'token_id': 'w-2', 'span_id': None, 'value': 'v', 'label': ''}])
    assert len(out) == 2
