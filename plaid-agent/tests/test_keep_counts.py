"""Every count counts what approval would write, never a keep (Luke's
ruling for FX-C, 2026-10-16, after REV2-AGENT): the card's rows and group
headers, plan_status, drop_planned, the applied message, the History label,
the research record and the trace. A ud discard or replacement drops the
values the plan keeps or changes by name from its count, as igt's rules do.
Dropping a corpus-wide change drops the keeps made against it, and a plan
holding only keeps reads as no changes."""

from plaid_agent.core.conversation import proposed_changes
from plaid_agent.core.plan import plan_changes
from plaid_agent.core.trace import summarize_steps
from plaid_agent.ud.project import load_project
from plaid_agent.ud.toolkit import call_tool as ud_call
from plaid_agent.ud.tools import Workspace
from ud_fixtures import PID, ud_client
from test_ud_tools import _engine_rows
import test_igt_rules as R
from test_tools import call_tool as call_igt


def _ud():
    client = ud_client()
    return Workspace(client, load_project(client, PID))


def _keep_ud(ws):
    ud_call(ws, 'discard_predictions', {'document': 'Viaje', 'field': 'upos'})
    return ud_call(ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w4'], 'field': 'upos', 'value': 'NOUN'})


def _keep_igt():
    client, w = R._ws({'sp-g1': 'Ali', 'sp-x2': 'Ali'})
    R._replace(w, 'Ali', 'Bob', whole=True)
    call_igt(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'Ali'})
    return client, w


# --- REV2-AGENT-1: an empty value can be kept -----------------------------------------

def test_igt_an_empty_value_is_kept_out_of_a_rule_that_fills_empty_values():
    from test_tools import ws as igt_ws
    w = igt_ws()
    call_igt(w, 'set_field_for_form', {'form': 'gam', 'field': 'Gloss', 'value': 'fish'})
    out = call_igt(w, 'set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': ''})
    assert out.startswith('Kept Gloss empty on s1.w2'), out
    assert [o['kind'] for o in w.ops] == ['bulk_scope', 'keep']
    assert plan_changes(w.plan_payload()['ops']) == 0
    _plan, helper = R._approved(w.client, w)
    assert not helper.errors, helper.errors
    assert w.client.payloads('spans.create') == []


# --- REV2-AGENT-2: ud rows, the summary and the applied message ----------------------

def test_ud_a_discard_counts_without_the_value_it_keeps_and_applies_as_no_changes():
    from test_replaced_work_corpus import _store
    from test_stale_by_sentence import APPS, _approve
    ws = _ud()
    _keep_ud(ws)
    payload = ws.plan_payload()
    assert payload['summary'] == 'no changes'
    assert plan_changes(payload['ops']) == 0
    assert payload['changes'][0]['label'].startswith('discard nothing in "Viaje"')
    assert payload['changes'][1] == {**payload['changes'][1], 'label': 'upos stays "NOUN"', 'kept': True}
    plan = _store(ws, ws.client, PID, 'ud')
    helper = _approve(APPS['ud'](), ws.client, plan)
    assert not helper.errors, helper.errors
    assert helper.done[-1]['message'] == 'Applied no changes.', helper.done
    assert ws.client.writes == []


def test_ud_a_replacement_row_counts_without_its_kept_value():
    ws = _ud()
    _engine_rows(ws, [('sp-l3', 'mar', 'ud1', 'uw-3'), ('sp-l1', 'ir', 'ud1', 'uw-1')])
    ud_call(ws, 'replace_in_field', {'field': 'lemma', 'pattern': 'r', 'replacement': 'R'})
    assert ws.ops[0]['count'] == 2
    ud_call(ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w1'], 'field': 'lemma', 'value': 'ir'})
    payload = ws.plan_payload()
    row = payload['changes'][0]
    assert row['rule']['total'] == 1
    assert [d[2] for d in row['rule']['documents']] == [1]
    assert [(t['from'], t['to'], t['count']) for t in row['rule']['transitions']] == [('mar', 'maR', 1)]
    assert 'on 1 value(s)' in row['label'], row['label']
    assert payload['summary'] == '1 field value'
    assert plan_changes(payload['ops']) == 1
    # The stored op keeps what the preview found, without the card.
    assert payload['ops'][0]['found']['count'] == 2 and 'card' not in payload['ops'][0]['found']
    # Dropping the keep counts the value back in.
    assert ud_call(ws, 'drop_planned', {'indexes': [2]}).startswith('Stopped keeping 1 value')
    assert ws.plan_payload()['changes'][0]['rule']['total'] == 2


def test_ud_a_change_by_name_is_counted_once_not_also_in_the_discard():
    ws = _ud()
    ud_call(ws, 'discard_predictions', {'document': 'Viaje', 'field': 'upos'})
    ud_call(ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w4'], 'field': 'upos', 'value': 'PROPN'})
    payload = ws.plan_payload()
    assert plan_changes(payload['ops']) == 1
    assert payload['summary'] == '1 field value'


# --- REV2-AGENT-3: the research record ------------------------------------------------

def test_the_research_record_counts_no_keep_in_either_app():
    from plaid_agent.igt.service import AssistantService as Igt
    from plaid_agent.ud.service import AssistantService as Ud
    ws = _ud()
    _keep_ud(ws)
    ops = ws.plan_payload()['ops']
    rows, total = proposed_changes(ops, *Ud.proposed_keys)
    assert total == plan_changes(ops) == 0 and rows == []
    _client, w = _keep_igt()
    ops = w.plan_payload()['ops']
    rows, total = proposed_changes(ops, *Igt.proposed_keys)
    assert total == plan_changes(ops) == 1 and not any(r[0] == 'keep' for r in rows)


# --- REV2-AGENT-4: plan_status, drop_planned, a stale keep ---------------------------

def test_plan_status_and_drop_planned_tell_a_keep_from_a_change():
    _client, w = _keep_igt()
    status = call_igt(w, 'plan_status', {})
    assert status.startswith('1 planned change and 1 kept value (nothing is written'), status
    out = call_igt(w, 'drop_planned', {'indexes': [2]})
    assert out.startswith('Stopped keeping 1 value: the corpus-wide change in the plan now includes it.'), out
    assert [o['kind'] for o in w.ops] == ['bulk_scope']
    assert w.plan_payload()['ops'][0]['count'] == 2


def test_dropping_the_change_drops_the_keeps_made_against_it_in_both_apps():
    _client, w = _keep_igt()
    out = call_igt(w, 'drop_planned', {'indexes': [1]})
    assert out.startswith('Dropped 1 planned change. 1 value kept out of it went with it'), out
    assert w.ops == []
    ws = _ud()
    _keep_ud(ws)
    out = ud_call(ws, 'drop_planned', {'indexes': [1]})
    assert out.startswith('Dropped 1 entry that changed nothing. 1 value kept out of it went with it'), out
    assert ws.ops == []
    # Set again, nothing is taken back: there was only a keep.
    assert ud_call(ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w4'], 'field': 'upos',
                                     'value': 'NOUN'}).startswith('Nothing to change')


def test_a_plan_of_only_kept_values_reads_as_no_changes():
    ws = _ud()
    _keep_ud(ws)
    status = ud_call(ws, 'plan_status', {})
    assert status.startswith('No planned changes: the plan only keeps 1 value as it is'), status


# --- REV2-AGENT-5: the trace and what the model is told ------------------------------

def test_igt_the_model_is_told_the_plan_as_the_card_counts_it():
    client, w = R._ws({'sp-g1': 'Ali', 'sp-x2': 'Ali'})
    R._replace(w, 'Ali', 'Bob', whole=True)
    out = call_igt(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'Ali'})
    assert 'The plan now holds 1 change.' in out, out


def test_a_repeated_keep_is_traced_as_nothing_staged_again(monkeypatch):
    from test_nothing_planned import _reply, _run
    from plaid_agent.ud.service import AssistantService
    ws = _ud()
    keep = ('set_field', {'document': 'Viaje', 'refs': ['s1.w4'], 'field': 'upos', 'value': 'NOUN'})
    out, _ = _run(monkeypatch, ws, AssistantService().toolkit(), [
        _reply(('discard_predictions', {'document': 'Viaje', 'field': 'upos'})),
        _reply(keep), _reply(keep), _reply(text='Done.')])
    labels = [(s['label'], s.get('planned'), s.get('nothing')) for s in out.steps]
    assert labels[1] == ('Kept upos "NOUN" on s1.w4', -1, None), labels
    assert labels[2] == ('Nothing staged again: Kept upos "NOUN" on s1.w4', None, True), labels
    assert 'planned change' not in summarize_steps(out.steps)


# --- REV2-AGENT-6: a later rule over a kept value --------------------------------------

def test_igt_a_later_rule_says_it_matched_a_kept_value_and_approval_agrees():
    client, w = R._ws({'sp-g1': 'Ali', 'sp-x2': 'Ali'})
    R._replace(w, 'Ali', 'Bob', whole=True)
    call_igt(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'Ali'})
    out = R._replace(w, 'li', 'LI')
    assert out.startswith('Nothing to change: the plan keeps every one of the Gloss values that match (1)'), out
    client, w = R._ws({'sp-g1': 'Ali', 'sp-x2': 'Ali', 'sp-x3': 'Kali'})
    R._replace(w, 'Ali', 'Bob', whole=True)
    call_igt(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'Ali'})
    out = R._replace(w, 'li', 'LI')
    assert '1 more match where the plan keeps the value as it is, left out.' in out, out
    _plan, helper = R._approved(client, w)
    assert not helper.errors, helper.errors
    assert dict(client.updates('spans')) == {'sp-x2': 'Bob', 'sp-x3': 'KaLI'}


def test_igt_a_keep_made_after_two_rules_still_approves():
    """The later rule read the kept value as the earlier one would leave it.
    Kept, it reads it as stored, at staging and at approval alike, so what
    it matched still matches."""
    client, w = R._ws({'sp-g1': 'Ali', 'sp-x2': 'Ali', 'sp-x3': 'Kali'})
    R._replace(w, 'Ali', 'Bob', whole=True)
    R._replace(w, 'li', 'LI')
    call_igt(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'Ali'})
    _plan, helper = R._approved(client, w)
    assert not helper.errors, helper.errors
    assert dict(client.updates('spans')) == {'sp-x2': 'Bob', 'sp-x3': 'KaLI'}


def test_a_settled_plan_cut_short_counts_the_kept_rows_it_leaves_out():
    from plaid_agent.core.conversation import SETTLED_ROWS_MAX, compact_plan
    changes = [{'label': f'c{i}'} for i in range(SETTLED_ROWS_MAX)] + [{'label': 'x'},
                                                                       {'label': 'k', 'kept': True}]
    item = compact_plan({'status': 'applied', 'plan': {'ops': [{}] * len(changes), 'changes': changes}})
    assert item['plan']['omitted'] == {'count': 2, 'writes_text': 0, 'replaces_work': 0, 'kept': 1}
