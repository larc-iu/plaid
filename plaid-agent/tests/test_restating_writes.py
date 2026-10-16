"""A write that restates a value already there is never planned (Eline,
2026-10-07): her case-insensitive "3sg → 3SG" rewrote some 4,500 values that
were already "3SG", and each write restamped the value's provenance as the
plan's, a person's own work included. Every write path that can name a value
already in place leaves it out: the corpus-wide rules of both apps, igt's
set_field, and ud's set_field and set_head, which still planned it."""

import pytest

from plaid_agent.ud.project import load_project
from plaid_agent.ud.tools import Workspace
from plaid_agent.ud.toolkit import call_tool as ud_call
from test_tools import call_tool as igt_call, ws as igt_ws
from ud_fixtures import PID, ud_client


@pytest.fixture
def ud():
    client = ud_client()
    w = Workspace(client, load_project(client, PID))
    return w, w.documents()[0]['id']


def test_ud_set_field_leaves_out_a_word_that_holds_the_value(ud):
    w, doc = ud
    assert ud_call(w, 'set_field', {'document': doc, 'refs': ['s1.w1'], 'field': 'upos', 'value': 'VERB'}) == \
        'Nothing to change: upos is already "VERB" on every word named.'
    out = ud_call(w, 'set_field', {'document': doc, 'refs': ['s1.w1', 's1.w4'], 'field': 'upos', 'value': 'VERB'})
    assert out.startswith('Planned upos = "VERB" on 1 word(s): s1.w4'), out
    assert [o['token_id'] for o in w.ops] == ['uw-3']


def test_ud_set_field_back_to_the_stored_value_drops_the_planned_change(ud):
    w, doc = ud
    ud_call(w, 'set_field', {'document': doc, 'refs': ['s1.w1'], 'field': 'upos', 'value': 'NOUN'})
    assert [o['value'] for o in w.ops] == ['NOUN']
    ud_call(w, 'set_field', {'document': doc, 'refs': ['s1.w1'], 'field': 'upos', 'value': 'VERB'})
    assert w.ops == []


def test_ud_set_head_to_the_relation_a_word_has_plans_nothing(ud):
    w, doc = ud
    assert ud_call(w, 'set_head', {'document': doc, 'ref': 's1.w4', 'head': 's1.w1', 'deprel': 'obl'}) == \
        'Nothing to change: s1.w4 ("mar") is already obl of word 1 ("Vamos").'
    assert w.ops == []
    # A planned relabel is taken back by naming the stored relation, and
    # nothing restates it (REV-AGENT2-2).
    ud_call(w, 'set_head', {'document': doc, 'ref': 's1.w4', 'head': 's1.w1', 'deprel': 'nmod'})
    out = ud_call(w, 'set_head', {'document': doc, 'ref': 's1.w4', 'head': 's1.w1', 'deprel': 'obl'})
    assert out == 'Took back the planned change to the head of s1.w4 ("mar"): it stays obl of word 1 ("Vamos").'
    assert w.ops == []


def test_ud_and_igt_rules_ignoring_case_leave_out_values_already_right():
    from plaid_agent.ud.bulk import changes, spec_of
    _spec, rep = spec_of({'pattern': 'verb', 'replacement': 'VERB', 'case_sensitive': False})
    rows = [[{'id': 'a', 'value': 'VERB'}, {'id': 't1'}], [{'id': 'b', 'value': 'Verb'}, {'id': 't2'}]]
    assert [(c['id'], c['old'], c['new']) for c in changes(rows, 'upos', rep)] == [('b', 'Verb', 'VERB')]
    iw = igt_ws()
    out = igt_call(iw, 'replace_in_field', {'field': 'Gloss', 'pattern': 'ali', 'replacement': 'Ali',
                                            'case_sensitive': False})
    assert out.startswith('Nothing to change'), out
    igt_call(iw, 'set_field', {'document': 'd1', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'Ali'})
    assert iw.ops == []
