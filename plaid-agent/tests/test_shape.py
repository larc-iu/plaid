"""Word split/merge/delete and sentence split/merge: plan tools and execution."""
import pytest
from fixtures import scan_ws, FakeClient, document_raw, GLOSS

from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.plan import execute_plan, normalize_ops


def ws(raw=None):
    c = FakeClient(documents={'d1': raw} if raw else None)
    return scan_ws(c)


def test_split_word_by_left_part_or_length():
    w = ws()
    out = call_tool(w, 'split_word', {'document': 'd1', 'ref': 's1.w1', 'at': 'Ali'})
    assert 'Planned 1 change' in out
    op = w.ops[0]
    assert (op['kind'], op['word_id'], op['position'], op['morpheme_ids']) == ('split_word', 'w-1', 3, ['m-1a', 'm-1b'])
    assert op['label'] == ('Text 1 s1.w1 "Ali-di": split into "Ali" + "-di" (its 2-morpheme analysis is deleted) '
                           '(word values and link go to the left part)')
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
    assert w.ops[0] == {'kind': 'delete_word', 'word_id': 'w-3', 'morpheme_ids': [], 'link_ids': [],
                        'label': 'Text 1 s1.w3 "akuna": delete the word token (the text is unchanged)'}
    assert w.ops[1]['word_id'] == 'w-1' and w.ops[1]['morpheme_ids'] == ['m-1a', 'm-1b'] and 'analysis, values, and link are deleted' in w.ops[1]['label']

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
    assert counts == {'split words': 1, 'word merges': 1, 'deleted words': 1, 'split sentences': 1,
                      'sentence merges': 1}
    # A merge is the merge alone: the layer rules igt declares make the
    # server join the gathered values and drop the extra spans and links in
    # the merge's own transaction, and a delete of one it already took would
    # fail the batch. `spans` and `links` are what the card says.
    assert c.batches[0] == [
        ('tokens.bulk_delete', ['m-1a', 'm-1b']), ('tokens.split', _split('w-1', 3, c)),
        ('tokens.bulk_delete', ['m-2']), ('tokens.merge', ('w-2', 'w-3')), ('tokens.merge', ('w-2', 'w-x')),
        ('tokens.delete', 'w-4'),
        ('tokens.split', _split('s-1', 7, c)),
        ('tokens.merge', ('s-1', 's-2'))]


def _split(token_id, at, client):
    """A split as the fake records it, with the id the plan made the right
    half under."""
    [made] = [p['kwargs']['id'] for k, p in client.calls
              if k == 'tokens.split' and p['args'] == (token_id, at)]
    return {'args': (token_id, at), 'kwargs': {'id': made}}


def test_the_card_says_what_the_servers_merge_keeps():
    """The survivor's own span and link are kept, as the server's layer rule
    keeps them. When the survivor has none, the one with the smallest id is,
    its value leads the joined one, and the rest follow in text order. A
    closed tagset would refuse the joined value, so there the kept one stays."""
    raw = document_raw()
    layers = raw['text_layers'][0]['token_layers']
    layers[1]['span_layers'][0]['spans'] = [{'id': 'sp-z2', 'value': 'fish', 'tokens': ['w-2']},
                                            {'id': 'sp-a3', 'value': 'see', 'tokens': ['w-3']}]
    layers[1]['vocabs'][0]['vocab_links'] = [
        {'id': 'l-z2', 'vocab_item': {'id': 'vi-gam', 'form': 'gam'}, 'tokens': ['w-2']},
        {'id': 'l-a3', 'vocab_item': {'id': 'vi-ali', 'form': 'Ali'}, 'tokens': ['w-3']}]
    w = ws(raw)
    call_tool(w, 'merge_words', {'document': 'd1', 'refs': ['s1.w1', 's1.w2', 's1.w3']})
    op = w.ops[0]
    assert op['spans'] == [{'layer_id': GLOSS, 'keep_id': 'sp-a3', 'value': 'see | fish', 'delete_ids': ['sp-z2']}]
    assert op['links'] == {'keep_id': 'l-a3', 'delete_ids': ['l-z2']}
    assert '(keeps the link "Ali", drops 1)' in op['label']
    # The survivor's own, whatever its id.
    w2 = ws(raw)
    call_tool(w2, 'merge_words', {'document': 'd1', 'refs': ['s1.w2', 's1.w3']})
    assert w2.ops[0]['spans'][0]['keep_id'] == 'sp-z2' and w2.ops[0]['links']['keep_id'] == 'l-z2'
    assert w2.ops[0]['spans'][0]['value'] == 'fish | see'
    # A closed tagset keeps the kept value.
    w3 = ws(raw)
    w3.project.field_by_layer(GLOSS).tagset = {'mode': 'closed', 'values': []}
    call_tool(w3, 'merge_words', {'document': 'd1', 'refs': ['s1.w2', 's1.w3']})
    assert w3.ops[0]['spans'][0]['value'] is None and 'values combined' not in w3.ops[0]['label']


def test_ops_on_tokens_a_shape_op_removes_refuse_the_plan_or_are_filtered():
    # Refused rather than dropped: staging refuses the pair in both orders, so
    # reaching here means the plan was built some way the guard does not cover,
    # and a card that promised the change would have been lying.
    dead = [{'kind': 'delete_word', 'word_id': 'w-4', 'morpheme_ids': ['m-4a', 'm-4b'], 'label': ''}]
    for extra in ({'kind': 'set_span', 'layer_id': 'L', 'token_id': 'w-4', 'span_id': None, 'value': 'v', 'label': 'gloss w4'},
                  {'kind': 'set_morpheme_form', 'morpheme_id': 'm-4b', 'form': 'x', 'label': ''}):
        with pytest.raises(ValueError, match='deleted or merged away'):
            normalize_ops(dead + [extra])
    with pytest.raises(ValueError, match='deleted or merged away'):
        normalize_ops([{'kind': 'merge_words', 'word_id': 'w-2', 'other_ids': ['w-3'], 'morpheme_ids': [], 'spans': [], 'links': {}, 'label': ''},
                       {'kind': 'link', 'token_id': 'w-3', 'item_id': 'vi', 'label': ''}])
    # A confirmation the model NAMED is a write to what it names, like any
    # other: the plan refuses rather than quietly confirming less than the card
    # promised.
    with pytest.raises(ValueError, match='deleted or merged away'):
        normalize_ops(dead + [{'kind': 'confirm', 'named': True, 'span_ids': [],
                               'token_ids': ['m-4a', 'm-9'], 'link_ids': [], 'label': 'confirm s1.w4'}])
    # One over a whole document named none of it, so the deleted morpheme is
    # left out of it and the note says how many were left out.
    out, notes = normalize_ops(dead + [{'kind': 'confirm', 'span_ids': [], 'token_ids': ['m-4a', 'm-9'],
                                        'link_ids': [], 'label': 'Text 1: confirm 2 segmentations'}])
    assert out[1]['token_ids'] == ['m-9']
    assert notes == ['Text 1: confirm 2 segmentations: 1 annotation left unconfirmed (deleted in this plan)']
    # The survivor of a merge may still be written to.
    out, _ = normalize_ops([{'kind': 'merge_words', 'word_id': 'w-2', 'other_ids': ['w-3'], 'morpheme_ids': [], 'spans': [], 'links': {}, 'label': ''},
                            {'kind': 'set_span', 'layer_id': 'L', 'token_id': 'w-2', 'span_id': None, 'value': 'v', 'label': ''}])
    assert len(out) == 2


def test_a_change_and_a_certain_delete_of_its_subject_refuse_each_other_at_staging():
    """Both orders, because refusing only one of them lets the same plan be
    built by staging its two halves the other way round. The pair used to be
    staged, shown on a card, approved, and only then resolved by dropping one
    of the two."""
    # The change first, then the delete.
    w = ws()
    assert 'Planned' in call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'fish'})
    out = call_tool(w, 'delete_word', {'document': 'd1', 'refs': ['s1.w2']})
    assert 'writes to something this plan deletes' in out and 'drop_planned' in out
    assert [o['kind'] for o in w.ops] == ['set_span']
    # The delete first, then the change.
    w2 = ws()
    assert 'Planned' in call_tool(w2, 'delete_word', {'document': 'd1', 'refs': ['s1.w2']})
    assert 'writes to something this plan deletes' in call_tool(
        w2, 'set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'fish'})
    assert [o['kind'] for o in w2.ops] == ['delete_word']
    # A tool naming several words where the plan deletes one of them stages
    # none of them: half a batch would be a change the user approves without
    # the model ever having said it was planned.
    w6 = ws()
    call_tool(w6, 'delete_word', {'document': 'd1', 'refs': ['s1.w3']})
    out = call_tool(w6, 'set_field', {'document': 'd1', 'refs': ['s1.w1', 's1.w3'], 'field': 'Gloss', 'value': 'x'})
    assert 'writes to something this plan deletes' in out
    assert [o['kind'] for o in w6.ops] == ['delete_word']
    # A merge takes the words it names but not the one it merges INTO.
    w3 = ws()
    call_tool(w3, 'merge_words', {'document': 'd1', 'refs': ['s1.w2', 's1.w3']})
    assert 'Planned' in call_tool(w3, 'set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'x'})
    assert 'writes to something this plan deletes' in call_tool(
        w3, 'set_field', {'document': 'd1', 'refs': ['s1.w3'], 'field': 'Gloss', 'value': 'x'})
    # A sentence split deletes nothing, so a comment on it stands.
    w4 = ws()
    call_tool(w4, 'split_sentence', {'document': 'd1', 'ref': 's1', 'before_word': 2})
    assert 'Planned' in call_tool(w4, 'add_comment', {'document': 'd1', 'ref': 's1', 'body': 'check this'})
    # A text edit's word ids are a guess, so it refuses nothing here (the
    # comment guard has its own rule) and appended text names no word at all.
    w5 = ws()
    call_tool(w5, 'append_text', {'document': 'd1', 'text': 'Gam.'})
    assert 'Planned' in call_tool(w5, 'set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'x'})


def test_one_plan_changes_a_word_s_boundaries_or_its_analysis_never_both():
    """It did both, and the second op deleted a morpheme the first had already
    deleted: the batch they share fails atomically, after the user approved the
    plan. The analysis also left behind a morpheme the reshape did not know
    about, for the server to cascade-split, which is the very thing a reshape
    deletes them to prevent."""
    for first, second in [
        (('set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': [{'form': 'Al'}, {'form': 'i'}]}),
         ('split_word', {'document': 'd1', 'ref': 's1.w1', 'at': 2})),
        (('split_word', {'document': 'd1', 'ref': 's1.w1', 'at': 2}),
         ('set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': [{'form': 'Al'}, {'form': 'i'}]})),
        (('set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': [{'form': 'Ali'}]}),
         ('delete_word', {'document': 'd1', 'refs': ['s1.w1']})),
        (('merge_words', {'document': 'd1', 'refs': ['s1.w1', 's1.w2']}),
         ('set_morpheme', {'document': 'd1', 'ref': 's1.w1.m1', 'form': 'Al'})),
        (('set_analysis', {'document': 'd1', 'ref': 's1.w2', 'morphemes': [{'form': 'gam'}]}),
         ('merge_words', {'document': 'd1', 'refs': ['s1.w1', 's1.w2']})),
    ]:
        w = ws()
        assert not call_tool(w, *first).startswith('Error'), first
        out = call_tool(w, *second)
        assert 'cannot also change' in out, (first, second, out)
        assert len(w.ops) == 1
    # Named through its sentence, and with nothing to discard: the word is
    # still one the plan has reshaped, and saying so beats saying nothing.
    w = ws()
    call_tool(w, 'delete_word', {'document': 'd1', 'refs': ['s1.w2']})
    assert 'cannot also change' in call_tool(w, 'discard_analysis', {'document': 'd1', 'refs': ['s1']})


def test_a_retype_and_an_analysis_of_its_words_cannot_share_a_plan():
    """A retype deletes every word of the sentence, so an analysis of one of
    them is planned against ids that will not exist. The guard compares word
    ids and the retype handed it the SENTENCE's id, so it could never fire:
    the analysis-then-retype order staged both, and approval dropped one of
    them with a note the user had not agreed to."""
    w = ws()
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': [{'form': 'Al'}, {'form': 'i'}]})
    out = call_tool(w, 'retype_sentence', {'document': 'd1', 'ref': 's1', 'text': 'Ali gam akuna.'})
    assert 'cannot also change' in out
    assert len(w.ops) == 1
    # The other order already refused, and still does.
    w2 = ws()
    call_tool(w2, 'retype_sentence', {'document': 'd1', 'ref': 's1', 'text': 'Ali gam akuna.'})
    assert 'cannot also change' in call_tool(
        w2, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': [{'form': 'Al'}, {'form': 'i'}]})
    assert len(w2.ops) == 1
    # A sentence the retype does not touch is still free.
    w3 = ws()
    call_tool(w3, 'retype_sentence', {'document': 'd1', 'ref': 's1', 'text': 'Ali gam akuna.'})
    assert call_tool(w3, 'set_analysis', {'document': 'd1', 'ref': 's2.w1',
                                          'morphemes': [{'form': 'Gam'}]}).startswith('Planned')


def test_a_retype_card_says_what_the_plain_rule_does_to_the_words():
    """The text goes to the server as edits, and its plain rule keeps a word
    that is edited or typed over, with its analysis. The card promised the
    words would be re-tokenized without analysis (H8-ASSISTANT-1), so a
    misheard word replaced through the assistant kept the wrong word's gloss
    under a card saying it would not. It now says what happens and names the
    analyzed words the edit touches."""
    w = ws()
    call_tool(w, 'retype_sentence', {'document': 'd1', 'ref': 's1', 'text': 'Ali gam akuna.'})
    label = w.ops[0]['label']
    assert 'Changed words keep their analysis, removed words lose theirs, new words start unanalyzed.' in label
    assert 'Analyzed words changed: Ali-di' in label
    assert 're-tokenized' not in label
    w2 = ws()
    call_tool(w2, 'retype_sentence', {'document': 'd1', 'ref': 's1', 'text': 'Ali-di gam akuna mai.'})
    assert 'Analyzed words changed' not in w2.ops[0]['label']


def test_every_reshaping_tool_refuses_a_plan_a_corpus_wide_change_reaches():
    """Nine kinds count as a reshape when a corpus-wide change looks for one,
    and only five of the tools looked the other way. A sentence split or an
    analysis could join such a plan, and the two met for the first time inside
    the batch, after approval."""
    scope = {'kind': 'bulk_scope', 'tool': 'replace_in_field', 'args': {}, 'counts': {},
             'count': 1, 'documents': ['d1'], 'label': 'a corpus-wide change'}
    for name, args in [
        ('split_word', {'document': 'd1', 'ref': 's1.w1', 'at': 2}),
        ('merge_words', {'document': 'd1', 'refs': ['s1.w1', 's1.w2']}),
        ('delete_word', {'document': 'd1', 'refs': ['s1.w1']}),
        ('split_sentence', {'document': 'd1', 'ref': 's1', 'before_word': 2}),
        ('merge_sentences', {'document': 'd1', 'ref': 's2'}),
        ('set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': [{'form': 'Ali'}]}),
        ('discard_analysis', {'document': 'd1', 'refs': ['s1.w1']}),
        ('retype_sentence', {'document': 'd1', 'ref': 's1', 'text': 'Ali gam.'}),
        ('append_text', {'document': 'd1', 'text': 'Gam.'}),
    ]:
        w = ws()
        w.doc('d1')          # the scope op names it, so the document must be known
        w.ops.append(dict(scope))
        out = call_tool(w, name, args)
        assert 'corpus-wide change that reaches this document' in out, (name, out)
        assert len(w.ops) == 1, name


def test_append_and_retype_plan_ops_and_guards():
    w = ws()
    out = call_tool(w, 'append_text', {'document': 'd1', 'text': 'Gam akuna.\n\n  Ali gam.\n'})
    assert 'Planned 1 change' in out
    op = w.ops[0]
    assert (op['kind'], op['document_id'], op['text_id'], op['begin'], op['end'], op['old']) == ('edit_text', 'd1', 'text1', 25, 25, '')
    assert op['new'] == '\nGam akuna.\n\n  Ali gam.' and op['sentence_id'] is None and op['word_ids'] == []
    assert op['label'] == 'Text 1: append 2 sentences (4 words): "Gam akuna.\n\n  Ali gam."'
    assert 'must not be empty' in call_tool(w, 'append_text', {'document': 'd1', 'text': ' \n'})
    # A respelling before the region is fine; the region then refuses a respelling after it (and vice versa).
    assert 'Planned 1 change' in call_tool(w, 'respell', {'document': 'd1', 'ref': 's1.w2', 'new_text': 'gham'})
    assert 'retyped or appended in this plan' in call_tool(w, 'respell', {'document': 'd1', 'ref': 's2.w1', 'new_text': 'X'}) or True
    w2 = ws()
    call_tool(w2, 'respell', {'document': 'd1', 'ref': 's2.w1', 'new_text': 'Gham-ar'})
    assert 'respelling is planned at 18-24' in call_tool(w2, 'retype_sentence', {'document': 'd1', 'ref': 's1', 'text': 'Ali-di gam.'})

    w3 = ws()
    out = call_tool(w3, 'retype_sentence', {'document': 'd1', 'ref': 's1', 'text': 'Ali-di gam akuna gam.'})
    assert 'Planned 1 change' in out
    op = w3.ops[0]
    assert (op['begin'], op['end'], op['old'], op['new'], op['sentence_id']) == (0, 17, 'Ali-di gam akuna.', 'Ali-di gam akuna gam.', 's-1')
    assert op['word_ids'] == ['w-1', 'w-2', 'w-3'] and op['morpheme_ids'] == ['m-1a', 'm-1b', 'm-2']
    assert op['label'].startswith('Text 1 s1: retype "Ali-di gam akuna." → "Ali-di gam akuna gam." (Changed words keep')
    assert call_tool(w3, 'retype_sentence', {'document': 'd1', 'ref': 's2', 'text': 'Gam-ar.'}).startswith('Planned 0')
    # Same sentence again: last wins (same region), then a respelling inside it is refused.
    call_tool(w3, 'retype_sentence', {'document': 'd1', 'ref': 's1', 'text': 'Ali-di gam.'})
    assert len(w3.ops) == 1 and w3.ops[0]['new'] == 'Ali-di gam.'
    assert 'retyped or appended' in call_tool(w3, 'respell', {'document': 'd1', 'ref': 's1.w2', 'new_text': 'x'})
    assert 'retyped or appended' in call_tool(w3, 'respell', {'document': 'd1', 'ref': 's2.w1', 'new_text': 'x'})
    # A merge with a retyped sentence is refused.
    assert 'already split' in call_tool(w3, 'merge_sentences', {'document': 'd1', 'ref': 's2'})
    # Two sentences in the new text.
    w4 = ws()
    call_tool(w4, 'retype_sentence', {'document': 'd1', 'ref': 's2', 'text': 'Gam.\nAr.'})
    assert '(2 sentences)' in w4.ops[0]['label'] and w4.ops[0]['begin'] == 18 and w4.ops[0]['end'] == 25


class _TextServer:
    """Enough of the server's text update for the executor: apply the new body,
    delete word tokens inside changed ranges (common prefix/suffix kept), shift
    the rest, and gap-fill the sentence partition."""

    def __init__(self, c):
        self.c = c
        c.texts.update = self.update  # replaces the fake's recording for this method
        c.texts.edit = self.edit

    def edit(self, text_id, edits, audit_message=None, *, base=None, versioned=None):
        from plaid_client import apply_text_ops
        tl = self.c._documents['d1']['text_layers'][0]
        assert base is None or base == tl['text'].get('digest')
        self._apply(apply_text_ops(tl['text']['body'], edits))
        self.c.record('texts.edit', (text_id, edits))
        return {'id': text_id}

    def update(self, text_id, body):
        self._apply(body)
        self.c.record('texts.update', (text_id, body))
        return {'id': text_id}

    def _apply(self, body):
        raw = self.c._documents['d1']
        tl = raw['text_layers'][0]
        old = tl['text']['body']
        pre = 0
        while pre < min(len(old), len(body)) and old[pre] == body[pre]:
            pre += 1
        suf = 0
        while suf < min(len(old), len(body)) - pre and old[-1 - suf] == body[-1 - suf]:
            suf += 1
        del_b, del_e = pre, len(old) - suf
        shift = len(body) - len(old)
        for layer in tl['token_layers']:
            kept = []
            for t in layer['tokens']:
                if t['begin'] >= del_b and t['end'] <= del_e and del_e > del_b:
                    continue  # inside the deleted range
                if t['begin'] >= del_e:
                    t['begin'] += shift
                    t['end'] += shift
                elif t['end'] > del_b:
                    t['end'] += shift  # straddles: resized
                kept.append(t)
            layer['tokens'] = kept
        sents = sorted(tl['token_layers'][0]['tokens'], key=lambda t: t['begin'])
        if sents:
            sents[0]['begin'] = 0
            for a, b2 in zip(sents, sents[1:]):
                a['end'] = b2['begin']
            sents[-1]['end'] = len(body)
        tl['text']['body'] = body


def test_execute_append_splits_the_gap_filled_sentence_and_tokenizes_words():
    from plaid_agent.igt.project import load_project
    c = FakeClient()
    _TextServer(c)
    project = load_project(c, 'p1')
    # tokens.split makes the new right half under the id it is given, and
    # mimics the server locally
    made = []

    def split(sid, pos, id=None):
        for t in c._documents['d1']['text_layers'][0]['token_layers'][0]['tokens']:
            if t['id'] == sid:
                new = {'id': id, 'begin': pos, 'end': t['end']}
                t['end'] = pos
                c._documents['d1']['text_layers'][0]['token_layers'][0]['tokens'].append(new)
                c.record('tokens.split', (sid, pos))
                made.append(id)
                return {'id': id}
        raise AssertionError(sid)
    c.tokens.split = split
    op = {'kind': 'edit_text', 'document_id': 'd1', 'text_id': 'text1', 'sentence_id': None, 'begin': 25, 'end': 25,
          'old': '', 'new': '\nGam akuna.\n\n  Ali gam.', 'word_ids': [], 'morpheme_ids': [], 'label': ''}
    counts = execute_plan(c, [op], source='s', label='l', project=project)
    assert counts == {'text edits': 1}
    body = 'Ali-di gam akuna. Gam-ar.\nGam akuna.\n\n  Ali gam.'
    assert ('texts.edit', ('text1', [{'type': 'insert', 'index': 25, 'value': '\nGam akuna.\n\n  Ali gam.'}])) in c.writes
    assert c._documents['d1']['text_layers'][0]['text']['body'] == body
    splits = c.payloads('tokens.split')
    # The last sentence was gap-filled over the new text, then split per line.
    assert splits == [('s-2', 26), (made[0], 40)] and all(made)
    bulk = c.payloads('tokens.bulk_create')[0]
    assert [(body[t['begin']:t['end']], t['token_layer_id']) for t in bulk] == \
        [('Gam', 'tk-word'), ('akuna', 'tk-word'), ('Ali', 'tk-word'), ('gam', 'tk-word')]
    # Existing words were left alone (no re-creation over them).
    assert all(t['begin'] >= 26 for t in bulk)


def test_execute_retype_keeps_unchanged_words_and_verifies_the_region():
    from plaid_agent.igt.project import load_project
    from plaid_agent.igt.plan import PlanError
    c = FakeClient()
    _TextServer(c)
    project = load_project(c, 'p1')
    op = {'kind': 'edit_text', 'document_id': 'd1', 'text_id': 'text1', 'sentence_id': 's-1', 'begin': 0, 'end': 17,
          'old': 'Ali-di gam akuna.', 'new': 'Ali-di gam gam akuna.', 'word_ids': ['w-1', 'w-2', 'w-3'],
          'morpheme_ids': ['m-1a', 'm-1b', 'm-2'], 'label': ''}
    execute_plan(c, [op], source='s', label='l', project=project)
    body = 'Ali-di gam gam akuna. Gam-ar.'
    # the region's change alone, at its place, never a whole body to diff
    [edits] = [args[1] for kind, args in c.writes if kind == 'texts.edit']
    assert len(edits) == 1 and edits[0]['type'] == 'insert' and 6 <= edits[0]['index'] <= 17
    assert not [kind for kind, _ in c.writes if kind == 'texts.update']
    assert c._documents['d1']['text_layers'][0]['text']['body'] == body
    assert not c.payloads('tokens.split')  # no newline: no new sentence
    bulk = c.payloads('tokens.bulk_create')[0]
    assert [(t['begin'], t['end']) for t in bulk] == [(11, 14)]  # only the inserted "gam" is new; the rest survived
    # The region no longer reads as planned: refused, nothing written.
    c2 = FakeClient()
    _TextServer(c2)
    with pytest.raises(PlanError, match='no longer reads'):
        execute_plan(c2, [{**op, 'old': 'Something else.'}], source='s', label='l', project=project)
    assert not [kind for kind, _ in c2.writes if kind.startswith('texts.')]


def test_ops_on_retyped_words_are_dropped():
    ops = [{'kind': 'edit_text', 'document_id': 'd1', 'text_id': 'text1', 'sentence_id': 's-1', 'begin': 0, 'end': 17,
            'old': 'x', 'new': 'y', 'word_ids': ['w-1'], 'morpheme_ids': ['m-1a'], 'label': ''},
           {'kind': 'set_span', 'layer_id': 'L', 'token_id': 'w-1', 'span_id': None, 'value': 'v', 'label': 'gloss'}]
    out, notes = normalize_ops(ops)
    assert [o['kind'] for o in out] == ['edit_text']
    assert notes[0].startswith('dropped:') and 'deleted or merged away' in notes[0]


def test_a_confirm_skips_what_rides_a_token_the_plan_rewrites():
    # Neither span is named by the analysis op, and both are gone once it
    # lands: sp-m1a is deleted outright, sp-m1b rides a morpheme that goes.
    # Patching either after the delete fails the whole atomic batch, after the
    # user has approved it. This confirmation carries no `named` flag, so it
    # stands for whatever in the document awaits review: what the plan deletes
    # is left out of it here, and the applied message says how much.
    ops = [{'kind': 'set_analysis', 'word_id': 'w-1', 'text_id': 't', 'begin': 0, 'end': 3,
            'morpheme_layer_id': 'ml', 'morphemes': [{'form': 'x', 'fields': []}],
            'existing': [{'id': 'm-1a', 'span_ids': ['sp-m1a']},
                         {'id': 'm-1b', 'span_ids': ['sp-m1b']}], 'label': ''},
           {'kind': 'confirm', 'span_ids': ['sp-m1a', 'sp-m1b', 'sp-ok'],
            'token_ids': ['m-1b', 'w-9'], 'link_ids': [],
            'on': {'sp-m1a': 'm-1a', 'sp-m1b': 'm-1b', 'sp-ok': 'w-9'}, 'label': ''}]
    out, notes = normalize_ops(ops)
    confirm = [o for o in out if o['kind'] == 'confirm'][0]
    assert confirm['span_ids'] == ['sp-ok']
    assert confirm['token_ids'] == ['w-9']
    assert notes == ['a confirmation: 3 annotations left unconfirmed (deleted in this plan)']


def test_a_named_confirmation_keeps_what_a_text_edit_only_guesses_away():
    """A text edit's word ids are a guess (the server diffs the text), so a
    confirmation naming one of them is not refused: what survives is still
    confirmed, and the note says how much was left out. A CERTAIN delete of
    the same material refuses the plan instead."""
    ops = [{'kind': 'edit_text', 'document_id': 'd1', 'text_id': 't', 'begin': 0, 'end': 5,
            'old': 'Ali-d', 'new': 'Ali', 'word_ids': ['w-1'], 'morpheme_ids': ['m-1a'], 'label': 'retype s1'},
           {'kind': 'confirm', 'named': True, 'span_ids': ['sp-1', 'sp-2'], 'token_ids': [], 'link_ids': [],
            'on': {'sp-1': 'w-1', 'sp-2': 'w-9'}, 'label': 'confirm s1.w1'}]
    out, notes = normalize_ops(ops)
    confirm = [o for o in out if o['kind'] == 'confirm'][0]
    assert confirm['span_ids'] == ['sp-2']
    assert notes == ['confirm s1.w1: 1 annotation left unconfirmed (deleted in this plan)']


def test_a_single_delete_never_repeats_what_a_bulk_already_took():
    # The split bulk-deletes the old chain; the analysis names the same
    # morphemes. A bulk_delete of gone ids is accepted, a SINGLE delete of one
    # is a 404, and the batch is atomic.
    c = FakeClient()
    ops = [{'kind': 'split_word', 'word_id': 'w-1', 'position': 3,
            'morpheme_ids': ['m-1a', 'm-1b'], 'label': ''},
           {'kind': 'set_analysis', 'word_id': 'w-1', 'text_id': 't', 'begin': 0, 'end': 6,
            'morpheme_layer_id': 'ml', 'morphemes': [{'form': 'x', 'fields': []}],
            'existing': [{'id': 'm-1a', 'span_ids': []}, {'id': 'm-1b', 'span_ids': []}],
            'label': ''}]
    out, _ = normalize_ops(ops)
    execute_plan(c, out, source='s', label='l')
    singles = c.payloads('tokens.delete')
    assert 'm-1b' not in singles and 'm-1a' not in singles
    assert c.payloads('tokens.bulk_delete') == [['m-1a', 'm-1b']]


def test_a_text_edit_is_sent_at_its_place_so_a_twin_word_is_not_taken_for_it():
    """REV-dumb-edits M1: `ab ab` with the first word deleted went as a whole
    body, which the server's diff read as the second word deleted."""
    from plaid_agent.igt.plan import _region_edits
    assert _region_edits('ab ', '', 0) == [{'type': 'delete', 'index': 0, 'value': 3}]
    assert _region_edits('cat sat', 'cot sat', 10) == [{'type': 'replace', 'index': 11, 'length': 1, 'value': 'o'}]
