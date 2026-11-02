"""Word reshapes that meet another change of the same plan: a sentence split
between words a merge joins (R1-2), word deletes that between them take a
multi-word expression down to one member (R1-4), and an unlink of a word a
merge folds away or keeps (R1-6), and a value or a link planned on the word
or sentence a merge keeps (R1 S3). Each card line says what approval writes."""
import pytest

from fixtures import TRANS, VOCAB
from igt_rules_live import base_project, seeded, workspace
from live import live_client  # noqa: F401
from rule_plan_model import approve
from test_rule_restate_live import _doc

from plaid_agent.igt.toolkit import call_tool


def _words(c, s):
    doc = workspace(c, s).doc('Doc A')
    return [[(w.surface, w.link and w.link.form, [(l.form, len(l.tokens)) for l in w.mwes]) for w in sent.words]
            for sent in doc.sentences]


def _four(links=()):
    d = _doc('d0', 'Doc A', [('aa', 'A', [('aa', '')]), ('bb', 'B', [('bb', '')]), ('cc', 'C', [('cc', '')]),
                             ('dd', 'D', [('dd', '')])])
    d['text_layers'][0]['token_layers'][1]['vocabs'] = [{'id': VOCAB, 'name': 'Lexicon', 'vocab_links': [
        {'id': f'd0-l{i}', 'vocab_item': {'id': item}, 'tokens': [f'd0-w{t}' for t in tokens]}
        for i, (item, tokens) in enumerate(links)]}]
    return [d]


@pytest.mark.parametrize('merge_first', [True, False])
def test_a_sentence_split_between_words_a_merge_joins_is_refused(live_client, merge_first):
    c = live_client
    s, ws = seeded(c, base_project(), _four(), name=f'shape pairs: cut in merge {merge_first}')
    try:
        steps = [('merge_words', {'document': 'Doc A', 'refs': ['s1.w2', 's1.w3']}),
                 ('split_sentence', {'document': 'Doc A', 'ref': 's1', 'before_word': 3})]
        first, second = steps if merge_first else steps[::-1]
        call_tool(ws, *first)
        out = call_tool(ws, *second)
        assert 'a merged word cannot be cut by a sentence boundary' in out, out
        assert len(ws.ops) == 1, ws.ops
        # A split anywhere else in the sentence stands beside the merge.
        call_tool(ws, 'split_sentence' if merge_first else 'merge_words',
                  {'document': 'Doc A', 'ref': 's1', 'before_word': 4} if merge_first
                  else {'document': 'Doc A', 'refs': ['s1.w1', 's1.w2']})
        assert len(ws.ops) == 2, ws.ops
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
    finally:
        s.delete()


def test_two_word_deletes_that_leave_an_expression_one_member_say_it_goes(live_client):
    c = live_client
    s, ws = seeded(c, base_project(), _four([('vi-gam', (1, 2, 3))]), name='shape pairs: mwe two deletes')
    try:
        call_tool(ws, 'delete_word', {'document': 'Doc A', 'refs': ['s1.w2']})
        call_tool(ws, 'delete_word', {'document': 'Doc A', 'refs': ['s1.w3']})
        p, h, _ = approve(c, s.project_id, ws)
        rows = [r.get('label') or '' for r in p['changes']]
        assert 'is left with its other words' in rows[0], rows
        assert 'the multi-word expression "gam" goes with it' in rows[1], rows
        assert not h.errors, h.errors
        assert not any(m for sent in _words(c, s) for _w, _l, m in sent), _words(c, s)
    finally:
        s.delete()


def test_a_merge_after_a_delete_that_leaves_an_expression_one_word_drops_it(live_client):
    c = live_client
    s, ws = seeded(c, base_project(), _four([('vi-gam', (0, 1, 2))]), name='shape pairs: mwe delete merge')
    try:
        call_tool(ws, 'delete_word', {'document': 'Doc A', 'refs': ['s1.w1']})
        call_tool(ws, 'merge_words', {'document': 'Doc A', 'refs': ['s1.w2', 's1.w3']})
        p, h, _ = approve(c, s.project_id, ws)
        rows = [r.get('label') or '' for r in p['changes']]
        assert 'the multi-word expression "gam" is dropped' in rows[1], rows
        assert not h.errors, h.errors
        assert not any(m for sent in _words(c, s) for _w, _l, m in sent), _words(c, s)
    finally:
        s.delete()


@pytest.mark.parametrize('unlink_first', [True, False])
def test_an_unlinked_word_merged_away_leaves_no_link(live_client, unlink_first):
    c = live_client
    s, ws = seeded(c, base_project(), _four([('vi-ali', (2,))]), name=f'shape pairs: unlink merged {unlink_first}')
    try:
        steps = [('unlink_entry', {'document': 'Doc A', 'refs': ['s1.w3']}),
                 ('merge_words', {'document': 'Doc A', 'refs': ['s1.w2', 's1.w3']})]
        for tool, args in (steps if unlink_first else steps[::-1]):
            call_tool(ws, tool, args)
        p, h, _ = approve(c, s.project_id, ws)
        rows = [r.get('label') or '' for r in p['changes']]
        assert 'unlink "Ali"' in rows[0] and 'merge' in rows[1] and 'keeps the link' not in rows[1], rows
        assert not h.errors, h.errors
        assert _words(c, s)[0][1][:2] == ('bb cc', None), _words(c, s)
    finally:
        s.delete()


@pytest.mark.parametrize('unlink_first', [True, False])
def test_a_merge_line_says_which_link_is_kept_once_the_plan_unlinks_one(live_client, unlink_first):
    c = live_client
    s, ws = seeded(c, base_project(), _four([('vi-ali', (1,)), ('vi-gam', (2,))]),
                   name=f'shape pairs: unlink survivor {unlink_first}')
    try:
        steps = [('unlink_entry', {'document': 'Doc A', 'refs': ['s1.w2']}),
                 ('merge_words', {'document': 'Doc A', 'refs': ['s1.w2', 's1.w3']})]
        for tool, args in (steps if unlink_first else steps[::-1]):
            call_tool(ws, tool, args)
        p, h, _ = approve(c, s.project_id, ws)
        rows = [r.get('label') or '' for r in p['changes']]
        assert 'unlink "Ali"' in rows[0] and 'keeps the link' not in rows[1], rows
        assert not h.errors, h.errors
        assert _words(c, s)[0][1][:2] == ('bb cc', 'gam'), _words(c, s)
    finally:
        s.delete()


def _glosses(c, s):
    doc = workspace(c, s).doc('Doc A')
    return [(w.surface, w.fields['Gloss'].value if 'Gloss' in w.fields else None) for w in doc.sentences[0].words]


@pytest.mark.parametrize('stored', ['', 'B'])
@pytest.mark.parametrize('value_first', [True, False])
def test_a_value_planned_on_a_merge_survivor_is_joined_as_the_card_says(live_client, stored, value_first):
    # A value the plan writes on the word a merge keeps is written before the
    # merge, so the merge joins it with the other word's value, and the merge
    # line says so, in either order. It was refused at approval with "A token
    # has 2 values in Gloss" (R1 S3), or joined while the line named the value
    # it replaced ("BC | C", REV-FX-R1 S4).
    c = live_client
    words = [('aa', 'A', [('aa', '')]), ('bb', stored, [('bb', '')]), ('cc', 'C', [('cc', '')]),
             ('dd', 'D', [('dd', '')])]
    s, ws = seeded(c, base_project(), [_doc('d0', 'Doc A', words)],
                   name=f'shape pairs: value on survivor {stored} {value_first}')
    try:
        steps = [('set_field', {'document': 'Doc A', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'X'}),
                 ('merge_words', {'document': 'Doc A', 'refs': ['s1.w2', 's1.w3']})]
        for tool, args in (steps if value_first else steps[::-1]):
            assert 'Planned' in call_tool(ws, tool, args)
        p, h, _ = approve(c, s.project_id, ws)
        rows = [r.get('label') or '' for r in p['changes']]
        assert 'Gloss' in rows[0] and 'values combined: Gloss "X | C"' in rows[1], rows
        assert not h.errors, h.errors
        assert _glosses(c, s)[1] == ('bb cc', 'X | C'), _glosses(c, s)
    finally:
        s.delete()


@pytest.mark.parametrize('link_first', [True, False])
def test_a_link_planned_on_a_merge_survivor_is_the_link_it_keeps(live_client, link_first):
    # The survivor's planned link is written before the merge, so the merge
    # keeps it and drops the other word's, as the line says. It was refused at
    # approval with "2 vocabulary links" (R1 S3).
    c = live_client
    s, ws = seeded(c, base_project(), _four([('vi-ali', (2,))]), name=f'shape pairs: link on survivor {link_first}')
    try:
        steps = [('link_entry', {'document': 'Doc A', 'refs': ['s1.w2'], 'entry_form': 'gam#1'}),
                 ('merge_words', {'document': 'Doc A', 'refs': ['s1.w2', 's1.w3']})]
        for tool, args in (steps if link_first else steps[::-1]):
            assert 'Planned' in call_tool(ws, tool, args)
        p, h, _ = approve(c, s.project_id, ws)
        rows = [r.get('label') or '' for r in p['changes']]
        assert 'keeps the link "gam", drops 1' in rows[1], rows
        assert not h.errors, h.errors
        assert _words(c, s)[0][1][:2] == ('bb cc', 'gam'), _words(c, s)
    finally:
        s.delete()


@pytest.mark.parametrize('value_first', [True, False])
def test_a_value_planned_on_a_sentence_a_merge_keeps_is_joined_as_the_card_says(live_client, value_first):
    # The same for a sentence merge: the translation planned on the sentence
    # kept is joined with the other one's, where it was refused at approval.
    c = live_client
    [d] = _four()
    d['text_layers'][0]['token_layers'][0] = {
        'id': d['text_layers'][0]['token_layers'][0]['id'],
        'tokens': [{'id': 'd0-s0', 'begin': 0, 'end': 5}, {'id': 'd0-s1', 'begin': 6, 'end': 11}],
        'span_layers': [{'id': TRANS, 'spans': [{'id': 'd0-t1', 'value': 'T2', 'tokens': ['d0-s1']}]}]}
    s, ws = seeded(c, base_project(), [d], name=f'shape pairs: value on sentence kept {value_first}')
    try:
        steps = [('set_field', {'document': 'Doc A', 'refs': ['s1'], 'field': 'Translation', 'value': 'T1'}),
                 ('merge_sentences', {'document': 'Doc A', 'ref': 's2'})]
        for tool, args in (steps if value_first else steps[::-1]):
            assert 'Planned' in call_tool(ws, tool, args)
        p, h, _ = approve(c, s.project_id, ws)
        rows = [r.get('label') or '' for r in p['changes']]
        assert 'Translation' in rows[0] and 'values combined: Translation "T1 | T2"' in rows[1], rows
        assert not h.errors, h.errors
        doc = workspace(c, s).doc('Doc A')
        assert [x.fields['Translation'].value for x in doc.sentences] == ['T1 | T2'], doc.sentences
    finally:
        s.delete()


@pytest.mark.parametrize('stored', ['B', ''])
@pytest.mark.parametrize('rule_first', [True, False])
def test_a_form_rule_on_the_word_a_merge_keeps_is_refused(live_client, rule_first, stored):
    # REV-BL-APPS-1 and -2: a corpus-wide value (set_field_for_form) on the
    # word a merge keeps was written in the merge's batch after it (422, "2
    # values in Gloss", nothing written) or joined a value the merge line did
    # not name. Refused in both orders, as on the word the merge takes away.
    c = live_client
    words = [('aa', 'A', [('aa', '')]), ('bb', stored, [('bb', '')]), ('cc', 'C', [('cc', '')]),
             ('dd', 'D', [('dd', '')])]
    s, ws = seeded(c, base_project(), [_doc('d0', 'Doc A', words)], name=f'shape pairs: rule on kept {rule_first}')
    try:
        steps = [('set_field_for_form', {'form': 'bb', 'field': 'Gloss', 'value': 'R', 'only_empty': False}),
                 ('merge_words', {'document': 'Doc A', 'refs': ['s1.w2', 's1.w3']})]
        first, second = steps if rule_first else steps[::-1]
        assert 'Planned' in call_tool(ws, *first)
        out = call_tool(ws, *second)
        assert 'writes to something this plan deletes' in out and len(ws.ops) == 1, out
    finally:
        s.delete()
