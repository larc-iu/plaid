"""Word reshapes that meet another change of the same plan: a sentence split
between words a merge joins (R1-2), word deletes that between them take a
multi-word expression down to one member (R1-4), and an unlink of a word a
merge folds away or keeps (R1-6). Each card line says what approval writes."""
import pytest

from fixtures import VOCAB
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
