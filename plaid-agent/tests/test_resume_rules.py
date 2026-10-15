"""A rule staged after resume_plan reads the values the resumed rules leave,
as it would in the turn that staged them (H16-IGT-TOOLS-1): what each rule
found and the values stored before it travel with the plan's stored state."""

from fixtures import fake_ws
from test_igt_rules import _approved, _replace, _ws
from test_resume_plan import _stored

from plaid_agent.igt.bulk import planned_changes
from plaid_agent.igt.toolkit import call_tool


def _resumed(client, w1):
    payload = w1.plan_payload()
    w2 = fake_ws(client)
    w2.waiting = {'count': len(w1.ops), 'summary': payload['summary'], 'id': payload['id'],
                  'documents': payload['documents']}
    state = _stored(w1.plan_state())
    w2.load_plan_state = lambda plan_id: state if plan_id == payload['id'] else None
    assert call_tool(w2, 'resume_plan', {}).startswith('Took over')
    return w2


def _one_turn(store, *rules):
    client, w = _ws(dict(store))
    outs = [_replace(w, *r, whole=True) for r in rules]
    return w, outs


def test_a_rule_chained_after_resume_is_the_one_turn_rule_and_approves():
    store = {'sp-g1': 'X', 'sp-x2': 'Y', 'sp-x3': 'Q'}
    one, one_outs = _one_turn(store, ('X', 'Y'), ('Y', 'Z'))
    client, w1 = _ws(dict(store))
    _replace(w1, 'X', 'Y', whole=True)
    w2 = _resumed(client, w1)
    out = _replace(w2, 'Y', 'Z', whole=True)
    assert out == one_outs[1], (out, one_outs[1])
    assert w2.plan_payload()['changes'] == one.plan_payload()['changes']
    assert {o['span_id']: o['value'] for o in planned_changes(w2) if o['value'] == 'Z'} == {
        'sp-g1': 'Z', 'sp-x2': 'Z'}
    _plan, helper = _approved(client, w2)
    assert not helper.errors, helper.errors
    assert dict(client.updates('spans')) == {'sp-g1': 'Z', 'sp-x2': 'Z'}


def test_a_rule_that_matches_only_what_a_resumed_rule_makes_is_planned():
    # DEF -> ART, then in the next turn ART -> DET: ART is stored nowhere.
    store = {'sp-g1': 'DEF', 'sp-x2': 'DEF', 'sp-x3': 'Q'}
    client, w1 = _ws(dict(store))
    _replace(w1, 'DEF', 'ART', whole=True)
    w2 = _resumed(client, w1)
    out = _replace(w2, 'ART', 'DET', whole=True)
    assert 'Nothing to change' not in out, out
    # The card line reads from the value stored, before any rule.
    lines = [s['change'] for row in w2.plan_payload()['changes'] if row.get('rule')
             for s in row['rule']['sample']]
    assert any('"DEF" → "DET"' in line for line in lines), lines
    _plan, helper = _approved(client, w2)
    assert not helper.errors, helper.errors
    assert dict(client.updates('spans')) == {'sp-g1': 'DET', 'sp-x2': 'DET'}
