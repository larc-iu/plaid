"""REV6-AGENT's findings, each as its smallest live case: a planned analysis is
worked out from the plan's requests in the order they were made, so a drop
leaves the analysis the remaining requests make from scratch (Luke
2026-10-16), and a stored plan of another form is not resumed at all."""
import json

from live import live_client, seed  # noqa: F401
from fixtures import lexicon_raw, VOCAB
from rule_plan_model import approve, project, values_of
from test_rule_restate_live import _doc

from plaid_agent.igt.project import load_project
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.workspace import Workspace

SA = {'document': 'Doc A', 'ref': 's1.w2', 'morphemes': [{'form': 'ka'}, {'form': 'n'}]}


def _seeded(c, words, name):
    s = seed(c, project(), {'d0': _doc('d0', 'Doc A', words)}, {VOCAB: lexicon_raw()}, name=name)
    return s, Workspace(c, load_project(c, s.project_id))


def _stored_ka(c, name):
    return _seeded(c, [('ka', '', [('ka', '')]), ('kan', '', [('kan', '')])], name)


def _no_stored_ka(c, name):
    return _seeded(c, [('to', '', [('to', '')]), ('kan', '', [('kan', '')])], name)


def _r(form, value, only_empty=False, **kw):
    return {'form': form, 'field': 'Morph Gloss', 'value': value, 'only_empty': only_empty, **kw}


def _ana(ws):
    [op] = [o for o in ws.ops if o.get('kind') == 'set_analysis']
    return [next((f['value'] for f in m.get('fields') or []), '') for m in op['morphemes']]


def _written(c, s, ref):
    return values_of(Workspace(c, load_project(c, s.project_id))).get(('Doc A', ref, 'Morph Gloss'))


def test_two_form_rules_dropped_in_one_call_leave_the_analysis_as_asked(live_client):
    # R6A-1: X, then Y over it, both dropped at once.
    c = live_client
    s, ws = _stored_ka(c, 'r6a-1')
    try:
        call_tool(ws, 'set_analysis', SA)
        call_tool(ws, 'set_field_for_form', _r('ka', 'X'))
        call_tool(ws, 'set_field_for_form', _r('ka', 'Y'))
        out = call_tool(ws, 'drop_planned', {'indexes': [2, 3]})
        # X's value is Y's to write, so the two rows count one change.
        assert out.startswith('Dropped 1 planned change. 1 value in planned analyses changed with it.'), out
        assert _ana(ws) == ['', '']
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        assert _written(c, s, 's1.w2.m1') == ''
    finally:
        s.delete()


def test_a_value_named_after_two_rules_stays_when_the_first_is_dropped(live_client):
    # R6A-2: X, then Y over it, then X named on that morpheme; drop the X rule.
    c = live_client
    s, ws = _stored_ka(c, 'r6a-2')
    try:
        call_tool(ws, 'set_analysis', SA)
        call_tool(ws, 'set_field_for_form', _r('n', 'X'))
        call_tool(ws, 'set_field_for_form', _r('n', 'Y'))
        call_tool(ws, 'set_field', {'document': 'Doc A', 'refs': ['s1.w2.m2'], 'field': 'Morph Gloss',
                                    'value': 'X'})
        call_tool(ws, 'drop_planned', {'indexes': [2]})
        assert _ana(ws) == ['', 'X']
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        assert _written(c, s, 's1.w2.m2') == 'X'
    finally:
        s.delete()


def test_a_rule_a_later_one_overwrote_stays_in_the_plan_and_writes_once_that_one_goes(live_client):
    # R6A-3: asked from scratch, "X on ka" is staged (it sets the analysis),
    # so a drop of something else leaves it, and dropping "Y on ka" leaves X.
    c = live_client
    s, ws = _no_stored_ka(c, 'r6a-3')
    try:
        call_tool(ws, 'set_analysis', SA)
        call_tool(ws, 'set_field_for_form', _r('ka', 'X'))
        call_tool(ws, 'set_field_for_form', _r('ka', 'Y'))
        call_tool(ws, 'set_field', {'document': 'Doc A', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'G'})
        out = call_tool(ws, 'drop_planned', {'indexes': [4]})
        assert 'went with it' not in out, out
        assert len(ws.ops) == 3 and _ana(ws) == ['Y', '']
        out = call_tool(ws, 'drop_planned', {'indexes': [3]})
        assert out.startswith('Dropped 1 entry. 1 value in planned analyses changed with it.'), out
        assert _ana(ws) == ['X', '']
    finally:
        s.delete()


def test_a_rule_staged_before_an_analysis_is_set_again_never_reaches_the_new_one(live_client):
    # R6A-4 (b): the old analysis's value does not come back into the new one.
    c = live_client
    s, ws = _no_stored_ka(c, 'r6a-4b')
    try:
        call_tool(ws, 'set_analysis', {**SA, 'morphemes': [{'form': 'ka', 'fields': {'Morph Gloss': 'X'}},
                                                          {'form': 'n'}]})
        call_tool(ws, 'set_field_for_form', _r('ka', ''))
        out = call_tool(ws, 'set_analysis', SA)
        # The clear set nothing in the new analysis: asked from scratch it
        # would not be staged.
        assert out.endswith(' 1 corpus-wide change that now finds nothing to change was dropped from the plan.'), out
        assert len(ws.ops) == 1 and _ana(ws) == ['', '']
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        assert _written(c, s, 's1.w2.m1') == ''
    finally:
        s.delete()
    # (a): a value the new analysis names equal to the rule's is its own.
    s, ws = _stored_ka(c, 'r6a-4a')
    try:
        call_tool(ws, 'set_analysis', SA)
        call_tool(ws, 'set_field_for_form', _r('ka', 'X'))
        call_tool(ws, 'set_analysis', {**SA, 'morphemes': [{'form': 'ka', 'fields': {'Morph Gloss': 'X'}},
                                                          {'form': 'n', 'fields': {'Morph Gloss': 'PL'}}]})
        call_tool(ws, 'drop_planned', {'indexes': [2]})
        assert _ana(ws) == ['X', 'PL']
    finally:
        s.delete()


def test_dropping_a_clear_rule_puts_back_the_value_a_fill_rule_then_leaves_alone(live_client):
    # R6A-5
    c = live_client
    s, ws = _no_stored_ka(c, 'r6a-5')
    try:
        call_tool(ws, 'set_analysis', {**SA, 'morphemes': [{'form': 'ka', 'fields': {'Morph Gloss': 'X'}},
                                                          {'form': 'n'}]})
        call_tool(ws, 'set_field_for_form', _r('ka', ''))
        call_tool(ws, 'set_field_for_form', _r('ka', 'Y', only_empty=True))
        assert _ana(ws) == ['Y', '']
        out = call_tool(ws, 'drop_planned', {'indexes': [2]})
        assert out.startswith('Dropped 1 entry. 1 value in planned analyses changed with it.'), out
        assert _ana(ws) == ['X', '']
    finally:
        s.delete()


def test_a_value_named_equal_to_a_rules_value_stays_when_the_rule_is_dropped(live_client):
    # R6A-6, as the stored twin keeps it.
    c = live_client
    s, ws = _stored_ka(c, 'r6a-6')
    try:
        call_tool(ws, 'set_analysis', SA)
        call_tool(ws, 'set_field_for_form', _r('ka', 'X'))
        out = call_tool(ws, 'set_field', {'document': 'Doc A', 'refs': ['s1.w2.m1'], 'field': 'Morph Gloss',
                                          'value': 'X'})
        assert out.startswith('Planned 1 change'), out
        call_tool(ws, 'drop_planned', {'indexes': [2]})
        assert _ana(ws) == ['X', '']
        # Named again with what the analysis holds as asked, nothing changes.
        out = call_tool(ws, 'set_field', {'document': 'Doc A', 'refs': ['s1.w2.m1'], 'field': 'Morph Gloss',
                                          'value': 'X'})
        assert out.startswith('Nothing to change'), out
    finally:
        s.delete()


def test_a_rule_asked_again_names_an_analysis_only_rule_it_empties(live_client):
    # R6A-7
    c = live_client
    s, ws = _no_stored_ka(c, 'r6a-7')
    try:
        call_tool(ws, 'set_analysis', SA)
        call_tool(ws, 'set_field_for_form', _r('ka', 'X'))
        call_tool(ws, 'set_field_for_form', _r('ka', 'Z'))
        out = call_tool(ws, 'set_field_for_form', _r('ka', 'X'))
        assert 'Morph Gloss = "Z" on "ka" now changes nothing (entry 2): drop it (drop_planned)' in out, out
        assert _ana(ws) == ['X', '']
    finally:
        s.delete()


def test_a_rule_asked_again_says_what_it_writes_in_an_analysis(live_client):
    c = live_client
    s, ws = _no_stored_ka(c, 'r6a-again')
    try:
        call_tool(ws, 'set_analysis', SA)
        call_tool(ws, 'set_field_for_form', _r('ka', 'X'))
        # Asked again at once: it is last already and writes the same.
        ops = json.dumps(ws.ops, sort_keys=True, default=str)
        out = call_tool(ws, 'set_field_for_form', _r('ka', 'X'))
        assert out.startswith('Planned 0 changes') and 'changed there' not in out, out
        assert json.dumps(ws.ops, sort_keys=True, default=str) == ops
        # After another change it applies last, and changes nothing there.
        call_tool(ws, 'set_field', {'document': 'Doc A', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'G'})
        out = call_tool(ws, 'set_field_for_form', _r('ka', 'X'))
        assert 'It was planned already as entry 2' in out and 'changed there' not in out, out
        assert _ana(ws) == ['X', '']
    finally:
        s.delete()


def test_a_plan_stored_in_another_form_is_not_resumed_at_all(live_client):
    # R6A-8: refused before anything is taken over, and asked again the same.
    c = live_client
    s, ws = _stored_ka(c, 'r6a-8')
    try:
        call_tool(ws, 'set_field_for_form', _r('ka', 'X'))
        payload = ws.plan_payload()
        for drop in ('rule_work', 'format'):
            w2 = Workspace(c, load_project(c, s.project_id))
            w2.waiting = {'count': len(ws.ops), 'summary': payload['summary'], 'id': payload['id'],
                          'documents': payload['documents']}
            state = json.loads(json.dumps(ws.plan_state()))
            state.pop(drop)
            w2.load_plan_state = lambda _pid, state=state: state
            for _ in range(2):
                out = call_tool(w2, 'resume_plan', {})
                assert out == 'Error: Resume is not available for that plan. Stage its changes again.', out
                assert w2.ops == [] and not w2.resumed
    finally:
        s.delete()


def test_a_replacement_reaches_a_value_in_a_planned_analysis_and_goes_with_its_drop(live_client):
    # OPEN.md: replace_in_field left a planned analysis's values as planned.
    c = live_client
    s, ws = _no_stored_ka(c, 'replace in analysis')
    try:
        call_tool(ws, 'set_analysis', {**SA, 'morphemes': [{'form': 'ka', 'fields': {'Morph Gloss': 'DO'}},
                                                          {'form': 'n', 'fields': {'Morph Gloss': 'PL'}}]})
        out = call_tool(ws, 'replace_in_field', {'field': 'Morph Gloss', 'pattern': 'DO', 'replacement': 'MAKE',
                                                 'whole': True})
        assert ' 1 value in analyses this plan already holds, changed there.' in out, out
        assert _ana(ws) == ['MAKE', 'PL']
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        assert _written(c, s, 's1.w2.m1') == 'MAKE'
    finally:
        s.delete()
    s, ws = _no_stored_ka(c, 'replace in analysis dropped')
    try:
        call_tool(ws, 'set_analysis', {**SA, 'morphemes': [{'form': 'ka', 'fields': {'Morph Gloss': 'DO'}},
                                                          {'form': 'n'}]})
        call_tool(ws, 'replace_in_field', {'field': 'Morph Gloss', 'pattern': 'DO', 'replacement': 'MAKE',
                                           'whole': True})
        call_tool(ws, 'drop_planned', {'indexes': [2]})
        assert _ana(ws) == ['DO', '']
    finally:
        s.delete()
