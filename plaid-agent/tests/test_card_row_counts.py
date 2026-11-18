"""Each card row says how many changes it stands for (``count``), so the
card counts changes the way the line above it does (REV-RL1-1, the owner's
ruling 2026-11-18: the line and the card never disagree). A folded row
counts its members, a rule its values, a kept value none, anything else
one, and the rows add up to the plan's ``proposed_count``. A settled plan
cut to its first rows keeps the changes of the rows it drops
(``omitted.changes``)."""

from fixtures import FakeClient, fake_ws

from plaid_agent.core import plan as core_plan
from plaid_agent.core.conversation import SETTLED_ROWS_MAX, compact_plan, proposed_changes
from plaid_agent.igt.toolkit import call_tool

import test_igt_rules as rules_fx
from test_keep_out_of_scope import _ud
from plaid_agent.ud.toolkit import call_tool as ud_call


def _proposed(payload):
    return proposed_changes(payload['ops'], ('token_id',), ('value',))[1]


def test_a_folded_row_counts_its_members(monkeypatch):
    monkeypatch.setattr(core_plan, 'COMPACT_ABOVE', 1)
    w = fake_ws(FakeClient())
    call_tool(w, 'set_field', {'document': 'Text 1', 'refs': ['s1.w2', 's1.w3'], 'field': 'Gloss', 'value': 'x'})
    call_tool(w, 'set_field', {'document': 'Text 1', 'refs': ['s2'], 'field': 'Translation', 'value': 'Fish.'})
    payload = w.plan_payload()
    assert payload['ops'][0].get('compact')
    assert [c['count'] for c in payload['changes']] == [2, 1]
    assert sum(c['count'] for c in payload['changes']) == _proposed(payload) == 3


def test_a_rule_row_counts_its_values_and_a_plain_row_one():
    store = {'sp-g1': 'VASP', 'sp-x2': 'VASP.3SG', 'sp-x3': 'X', 'sp-y1': 'VASP', 'sp-y2': 'VASP'}
    _client, w = rules_fx._ws(store)
    rules_fx._replace(w, 'VASP', 'ASP')
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s2'], 'field': 'Translation', 'value': 'Fish.'})
    payload = w.plan_payload()
    rule, plain = payload['changes']
    assert rule['count'] == rule['rule']['total'] == 4 and plain['count'] == 1
    assert sum(c['count'] for c in payload['changes']) == _proposed(payload) == 5


def test_a_kept_value_counts_none():
    ws = _ud()
    ud_call(ws, 'discard_predictions', {'document': 'Viaje', 'field': 'upos'})
    ud_call(ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w4'], 'field': 'upos', 'value': 'NOUN'})
    payload = ws.plan_payload()
    assert payload['changes'][-1]['count'] == 0
    assert sum(c['count'] for c in payload['changes']) == _proposed(payload)


def _settled(rows):
    return {'kind': 'assistant', 'status': 'applied',
            'plan': {'id': 'p', 'summary': 's', 'ops': [{'kind': 'x'}] * len(rows), 'changes': rows}}


def test_a_cut_plan_keeps_the_changes_of_the_rows_it_drops():
    rows = [{'label': f'r{i}', 'count': 3 if i % 2 else 1} for i in range(SETTLED_ROWS_MAX + 10)]
    plan = compact_plan(_settled(rows))['plan']
    dropped = rows[SETTLED_ROWS_MAX:]
    assert plan['omitted']['changes'] == sum(r['count'] for r in dropped) == 20
    assert sum(r['count'] for r in plan['changes']) + plan['omitted']['changes'] == sum(r['count'] for r in rows)


def test_a_cut_plan_whose_rows_carry_no_count_says_none():
    rows = [{'label': f'r{i}'} for i in range(SETTLED_ROWS_MAX + 10)]
    plan = compact_plan(_settled(rows))['plan']
    assert plan['omitted']['count'] == 10 and 'changes' not in plan['omitted']
