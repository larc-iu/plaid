"""A plan from an earlier message still waiting on its card is named to the
model, since this turn's plan replaces it: a model told "nothing is planned"
said the card was cleared, and one that added 19 changes told the user the
card held the 114 before them too (2026-10-12 survey)."""
from fixtures import FakeClient, fake_ws

from plaid_agent.core import service as service_mod
from plaid_agent.core.agent import TurnResult
from plaid_agent.core.conversation import build_meta, user_item
from plaid_agent.core.plan import waiting_plan
from plaid_agent.igt.toolkit import call_tool
from test_service_flow import Helper, _request, _seed_plan, _service

WAITING = {'count': 114, 'summary': '114 part-of-speech values'}


def _ws(waiting=WAITING):
    w = fake_ws(FakeClient())
    w.waiting = waiting
    return w


def test_the_waiting_plan_is_the_last_undecided_one():
    display = [user_item('a'),
               {'kind': 'assistant', 'plan': {'summary': 'old', 'proposed_count': 3}, 'status': 'replaced'},
               {'kind': 'assistant', 'plan': {'summary': '114 values', 'proposed_count': 114}, 'status': None},
               user_item('b')]
    assert waiting_plan(display) == {'count': 114, 'summary': '114 values'}
    display[2]['interrupted'] = True
    assert waiting_plan(display) is None
    assert waiting_plan([user_item('a')]) is None


def test_plan_status_with_nothing_staged_names_the_waiting_plan():
    out = call_tool(_ws(), 'plan_status', {})
    assert out.startswith('Nothing is planned in this turn. The plan of 114 changes (114 part-of-speech values) '
                          'from your earlier message is still waiting on its card')
    assert 'Staging anything now replaces it' in out
    assert call_tool(_ws(None), 'plan_status', {}) == 'Nothing is planned yet.'


def test_discarding_does_not_claim_the_waiting_card():
    out = call_tool(_ws(), 'discard_plan', {})
    assert out.startswith('Nothing was planned in this turn.')
    assert 'still waiting on its card: only the user can discard it there' in out


def test_the_first_staging_says_once_that_it_replaces_the_waiting_plan():
    w = _ws()
    first = call_tool(w, 'set_entry_field', {'entry_id': 'vi-ali', 'field': 'pos', 'value': 'PN'})
    assert ('This replaces the plan of 114 changes (114 part-of-speech values) from your earlier message, '
            'which the user can no longer approve. Stage those again if they should stay.') in first
    second = call_tool(w, 'set_entry_field', {'entry_id': 'vi-ali', 'field': 'gloss', 'value': 'Ali'})
    assert 'earlier message' not in second
    status = call_tool(w, 'plan_status', {})
    assert status.splitlines()[-1].startswith('This plan replaces the plan of 114 changes')


def test_no_waiting_plan_no_note():
    w = _ws(None)
    out = call_tool(w, 'set_entry_field', {'entry_id': 'vi-ali', 'field': 'pos', 'value': 'PN'})
    assert 'earlier message' not in out and 'earlier message' not in call_tool(w, 'plan_status', {})


def test_the_service_tells_the_turn_of_the_waiting_plan(monkeypatch):
    client = FakeClient()
    store = _seed_plan(client)
    conv, meta = store.load('c1')
    conv['messages'].append({'role': 'user', 'content': 'and the other one too'})
    conv['display'].append(user_item('and the other one too'))
    store.save('c1', conv, build_meta(meta, 'c1', conv, 'igt:assist:fake', 'fake/model',
                                       pending={'kind': 'turn', 'request_id': 'r1'}))
    seen = {}

    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        seen['waiting'] = ws.waiting
        return TurnResult('Done.', [{'role': 'assistant', 'content': 'Done.'}], [])

    monkeypatch.setattr(service_mod, 'run_turn', fake_run_turn)
    helper = Helper()
    _service().process_request(_request(client), helper)
    assert not helper.errors, helper.errors
    assert seen['waiting'] == {'count': 1, 'summary': '1 field value'}
