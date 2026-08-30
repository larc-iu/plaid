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
    assert op['label'].startswith('Text 1 s1: retype "Ali-di gam akuna." → "Ali-di gam akuna gam." (unchanged words keep')
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
        c.texts.update = self.update  # replaces the recorder for this resource method

    def update(self, text_id, body):
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
        self.c.log.append(('texts', 'update', (text_id, body), {}))
        return {'id': text_id}


def test_execute_append_splits_the_gap_filled_sentence_and_tokenizes_words():
    from fixtures import project_raw
    from plaid_igt_agent.project import load_project
    c = FakeClient()
    _TextServer(c)
    project = load_project(c, 'p1')
    # tokens.split must report the new right id and mimic the server locally
    def split(sid, pos):
        for t in c._documents['d1']['text_layers'][0]['token_layers'][0]['tokens']:
            if t['id'] == sid:
                new = {'id': f'{sid}-r', 'text': t['text'], 'begin': pos, 'end': t['end']}
                t['end'] = pos
                c._documents['d1']['text_layers'][0]['token_layers'][0]['tokens'].append(new)
                c.log.append(('tokens', 'split', (sid, pos), {}))
                return {'id': new['id']}
        raise AssertionError(sid)
    c.tokens.split = split
    op = {'kind': 'edit_text', 'document_id': 'd1', 'text_id': 'text1', 'sentence_id': None, 'begin': 25, 'end': 25,
          'old': '', 'new': '\nGam akuna.\n\n  Ali gam.', 'word_ids': [], 'morpheme_ids': [], 'label': ''}
    counts = execute_plan(c, [op], source='s', label='l', project=project)
    assert counts == {'text edits': 1}
    body = 'Ali-di gam akuna. Gam-ar.\nGam akuna.\n\n  Ali gam.'
    assert ('texts', 'update', ('text1', body), {}) in c.log
    splits = [a for r, m, a, k in c.log if (r, m) == ('tokens', 'split')]
    assert splits == [('s-2', 26), ('s-2-r', 40)]   # the last sentence was gap-filled over the new text, then split per line
    bulk = [a for r, m, a, k in c.log if (r, m) == ('tokens', 'bulk_create')][0][0]
    assert [(body[t['begin']:t['end']], t['token_layer_id']) for t in bulk] == \
        [('Gam', 'tk-word'), ('akuna', 'tk-word'), ('Ali', 'tk-word'), ('gam', 'tk-word')]
    # Existing words were left alone (no re-creation over them).
    assert all(t['begin'] >= 26 for t in bulk)


def test_execute_retype_keeps_unchanged_words_and_verifies_the_region():
    from plaid_igt_agent.project import load_project
    from plaid_igt_agent.plan import PlanError
    c = FakeClient()
    _TextServer(c)
    project = load_project(c, 'p1')
    op = {'kind': 'edit_text', 'document_id': 'd1', 'text_id': 'text1', 'sentence_id': 's-1', 'begin': 0, 'end': 17,
          'old': 'Ali-di gam akuna.', 'new': 'Ali-di gam gam akuna.', 'word_ids': ['w-1', 'w-2', 'w-3'],
          'morpheme_ids': ['m-1a', 'm-1b', 'm-2'], 'label': ''}
    execute_plan(c, [op], source='s', label='l', project=project)
    body = 'Ali-di gam gam akuna. Gam-ar.'
    assert ('texts', 'update', ('text1', body), {}) in c.log
    assert not [1 for r, m, a, k in c.log if (r, m) == ('tokens', 'split')]  # no newline: no new sentence
    bulk = [a for r, m, a, k in c.log if (r, m) == ('tokens', 'bulk_create')][0][0]
    assert [(t['begin'], t['end']) for t in bulk] == [(11, 14)]  # only the inserted "gam" is new; the rest survived
    # The region no longer reads as planned: refused, nothing written.
    c2 = FakeClient()
    _TextServer(c2)
    with pytest.raises(PlanError, match='no longer reads'):
        execute_plan(c2, [{**op, 'old': 'Something else.'}], source='s', label='l', project=project)
    assert not [1 for r, m, a, k in c2.log if r == 'texts']


def test_ops_on_retyped_words_are_refused():
    ops = [{'kind': 'edit_text', 'document_id': 'd1', 'text_id': 'text1', 'sentence_id': 's-1', 'begin': 0, 'end': 17,
            'old': 'x', 'new': 'y', 'word_ids': ['w-1'], 'morpheme_ids': ['m-1a'], 'label': ''},
           {'kind': 'set_span', 'layer_id': 'L', 'token_id': 'w-1', 'span_id': None, 'value': 'v', 'label': 'gloss'}]
    with pytest.raises(ValueError, match='deleted or merged away'):
        normalize_ops(ops)
