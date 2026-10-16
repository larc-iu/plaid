"""igt rules resolve in plan order, each over only the rules before it, a kept
value read as stored, whatever changed the plan (REV3-AGENT-1 to 3). The
generated sweep is ``test_rule_chain_oracle.py``."""

from test_igt_rules import _approved, _replace, _ws
from test_tools import call_tool

from plaid_agent.core.plan import plan_changes


def _set(w, ref, value, **kw):
    args = {'document': 'd1', 'refs': [ref], **({'values': {'Gloss': value}} if kw.get('values') else
                                                {'field': 'Gloss', 'value': value})}
    return call_tool(w, 'set_field', args)


def _approve(client, w):
    _plan, helper = _approved(client, w)
    assert not helper.errors, helper.errors
    return dict(client.updates('spans'))


def test_a_keep_made_after_two_chained_rules_counts_and_approves_what_the_chain_writes():
    client, w = _ws({'sp-g1': 'Ali', 'sp-x2': 'Ali'})
    _replace(w, 'Ali', 'Bob', whole=True)
    _replace(w, 'Bob', 'Cy', whole=True)
    out = _set(w, 's1.w1', 'Ali')
    assert out.endswith('The plan now holds 1 change.'), out
    payload = w.plan_payload()
    assert plan_changes(payload['ops']) == 1
    assert [(r['rule'] or {}).get('total') for r in payload['changes'] if r.get('rule')] == [0, 1]
    assert call_tool(w, 'plan_status', {}).startswith('1 planned change and 1 kept value')
    assert _approve(client, w) == {'sp-x2': 'Cy'}


def test_a_keep_dropped_from_a_chain_is_read_again_by_the_later_rule():
    client, w = _ws({'sp-g1': 'Ali', 'sp-x2': 'Ali'})
    _replace(w, 'Ali', 'Bob', whole=True)
    _set(w, 's1.w1', 'Ali')
    _replace(w, 'Bob', 'Cy', whole=True)
    call_tool(w, 'drop_planned', {'indexes': [2]})
    assert _approve(client, w) == {'sp-g1': 'Cy', 'sp-x2': 'Cy'}


def test_a_keep_replaced_by_a_named_value_is_no_longer_read_as_stored():
    for values in (False, True):
        # The keep made before the later rule, and after it.
        for keep_first in (True, False):
            client, w = _ws({'sp-g1': 'Ali', 'sp-x2': 'Ali'})
            _replace(w, 'Ali', 'Bob', whole=True)
            if keep_first:
                _set(w, 's1.w1', 'Ali')
            _replace(w, 'Bob', 'Cy', whole=True)
            if not keep_first:
                _set(w, 's1.w1', 'Ali', values=values)
            _set(w, 's1.w1', 'Carl', values=values)
            assert plan_changes(w.plan_payload()['ops']) == 2
            assert _approve(client, w) == {'sp-g1': 'Carl', 'sp-x2': 'Cy'}


def test_dropping_an_unrelated_rule_leaves_a_chain_as_it_was():
    client, w = _ws({'sp-g1': 'Ali', 'sp-x2': 'Ali', 'sp-x3': 'Kali'})
    _replace(w, 'Ali', 'Bob', whole=True)
    _replace(w, 'Bob', 'Cy', whole=True)
    _replace(w, 'Kali', 'Kim', whole=True)
    out = call_tool(w, 'drop_planned', {'indexes': [3]})
    assert 'Nothing is planned' not in out and len(w.ops) == 2
    assert _approve(client, w) == {'sp-g1': 'Cy', 'sp-x2': 'Cy'}


def test_a_later_rule_left_finding_nothing_by_a_drop_goes_and_is_said():
    client, w = _ws({'sp-g1': 'Ali', 'sp-x2': 'Ali'})
    _replace(w, 'Ali', 'Bob', whole=True)
    _replace(w, 'Bob', 'Cy', whole=True)
    out = call_tool(w, 'drop_planned', {'indexes': [1]})
    assert '1 later corpus-wide change that now finds nothing to change went with it.' in out, out
    assert w.ops == []
