"""A plan from an earlier message still waiting on its card is named to the
model, since this turn's plan replaces it: a model told "nothing is planned"
said the card was cleared, and one that added 19 changes told the user the
card held the 114 before them too (2026-10-12 survey). A plan is never
changed after its turn (Luke 2026-10-17): the model reads the waiting card's
rows and plans again, and nothing of the plan is stored beside the
conversation."""
from fixtures import FakeClient, fake_ws

from plaid_agent.core import turn as turn_mod
from plaid_agent.core.agent import TurnResult
from plaid_agent.core.conversation import build_meta, user_item
from plaid_agent.core.plan import waiting_plan
from plaid_agent.igt.service import AssistantService
from plaid_agent.igt.toolkit import TOOLS as IGT_TOOLS, call_tool
from plaid_agent.ud.toolkit import TOOLS as UD_TOOLS
from plaid_agent.umr.toolkit import TOOLS as UMR_TOOLS
from test_service_flow import Helper, _request, _seed_plan, _service

ROWS = ['Text 1 s1.w2 "gam": Gloss = "fish"',
        'Gloss "VASP" → "ASP" (replace_in_field {"field": "Gloss", "pattern": "VASP", "replacement": "ASP"})']
WAITING = {'count': 114, 'summary': '114 part-of-speech values', 'rows': ROWS}


def _ws(waiting=WAITING):
    w = fake_ws(FakeClient())
    w.waiting = waiting
    return w


def test_the_waiting_plan_is_the_last_undecided_one_with_its_rows():
    rule = {'tool': 'replace_in_field', 'args': {'field': 'Gloss', 'pattern': 'VASP', 'replacement': 'ASP'},
            'total': 40}
    display = [user_item('a'),
               {'kind': 'assistant', 'plan': {'summary': 'old', 'proposed_count': 3}, 'status': 'replaced'},
               {'kind': 'assistant', 'status': None,
                'plan': {'summary': '114 values', 'proposed_count': 114,
                         'changes': [{'label': 'Text 1 s1.w2 "gam": Gloss = "fish"'},
                                     {'label': 'Gloss "VASP" → "ASP"', 'rule': rule}]}},
               user_item('b')]
    assert waiting_plan(display) == {'count': 114, 'summary': '114 values', 'rows': ROWS}
    display[2]['interrupted'] = True
    assert waiting_plan(display) is None
    assert waiting_plan([user_item('a')]) is None


def test_plan_status_with_nothing_staged_lists_the_waiting_plan():
    out = call_tool(_ws(), 'plan_status', {})
    assert out == ('Nothing is planned in this turn. The plan of 114 changes (114 part-of-speech values) from your '
                   'earlier message is still waiting on its card for the user to approve or discard. Staging '
                   "anything now replaces it. Its changes, not part of this turn's plan:\n"
                   f'  1. {ROWS[0]}\n  2. {ROWS[1]}')
    assert call_tool(_ws(None), 'plan_status', {}) == 'Nothing is planned yet.'


def test_discarding_does_not_claim_the_waiting_card():
    out = call_tool(_ws(), 'discard_plan', {})
    assert out.startswith('Nothing was planned in this turn.')
    assert out.endswith('still waiting on its card: only the user can discard it there. Staging anything in this '
                        'turn replaces it.')


def test_the_first_staging_says_once_that_it_replaces_the_waiting_plan():
    w = _ws()
    first = call_tool(w, 'set_entry_field', {'entry_id': 'vi-ali', 'field': 'pos', 'value': 'PN'})
    assert ('This replaces the plan of 114 changes (114 part-of-speech values) from your earlier message, '
            'which the user can no longer approve. To keep those changes, discard_plan and ask the user to approve '
            'that plan first, or plan them again in this turn.') in first
    second = call_tool(w, 'set_entry_field', {'entry_id': 'vi-ali', 'field': 'gloss', 'value': 'Ali'})
    assert 'earlier message' not in second
    status = call_tool(w, 'plan_status', {})
    assert status.splitlines()[-1].startswith('This plan replaces the plan of 114 changes')
    # Discarded, the next staging says it again.
    call_tool(w, 'discard_plan', {})
    again = call_tool(w, 'set_entry_field', {'entry_id': 'vi-ali', 'field': 'pos', 'value': 'PN'})
    assert 'This replaces the plan of 114 changes' in again


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

    monkeypatch.setattr(turn_mod, 'run_turn', fake_run_turn)
    helper = Helper()
    _service().process_request(_request(client), helper)
    assert not helper.errors, helper.errors
    assert seen['waiting'] == {'count': 1, 'summary': '1 field value', 'rows': ['Text 1 s1.w2 "gam": Gloss = "fish"']}


def test_a_staging_turn_replaces_the_waiting_card_and_stores_nothing_beside_it(monkeypatch):
    client = FakeClient()
    store = _seed_plan(client)
    conv, meta = store.load('c1')
    conv['messages'].append({'role': 'user', 'content': 'gloss it "dog" instead'})
    conv['display'].append(user_item('gloss it "dog" instead'))
    store.save('c1', conv, build_meta(meta, 'c1', conv, 'igt:assist:fake', 'fake/model',
                                       pending={'kind': 'turn', 'request_id': 'r1'}))

    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        out = kit.call_tool(ws, 'set_field', {'document': 'Text 1', 'refs': ['s1.w2'], 'field': 'Gloss',
                                              'value': 'dog'})
        assert 'This replaces the plan of 1 change' in out, out
        return TurnResult('Planned.', [{'role': 'assistant', 'content': 'Planned.'}], [])

    monkeypatch.setattr(turn_mod, 'run_turn', fake_run_turn)
    helper = Helper()
    _service().process_request(_request(client), helper)
    assert not helper.errors, helper.errors
    display = store.load('c1')[0]['display']
    assert display[1]['status'] == 'replaced'
    assert display[-1]['status'] is None and display[-1]['plan']['changes'][0]['label'].endswith('Gloss = "dog"')
    keys = [k for _u, k in client.user_data.store]
    assert keys and not [k for k in keys if ':plan:' in k], keys


def test_no_app_offers_a_way_to_edit_a_staged_plan():
    for tools in (IGT_TOOLS, UD_TOOLS, UMR_TOOLS):
        names = {t['function']['name'] for t in tools}
        assert {'plan_status', 'discard_plan'} <= names
        assert not names & {'drop_planned', 'resume_plan'}, names
    w = _ws()
    assert call_tool(w, 'resume_plan', {}) == 'Error: there is no tool named resume_plan.'
    assert AssistantService.TOOLKIT.call_tool(w, 'drop_planned', {'indexes': [1]}).startswith('Error: there is no tool')
