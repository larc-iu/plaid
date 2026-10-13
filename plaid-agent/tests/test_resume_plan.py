"""resume_plan copies the plan an earlier message left waiting on its card
into this turn's plan, from its live state stored beside the conversation,
after a model resent 11 KB of code to rebuild 336 of 420 changes and another
conversation lost 114 retaggings to a follow-up of 19 (2026-10-12 survey)."""
import copy

from fixtures import FakeClient, fake_ws
from plaid_client.transforms import transform_request, transform_response

from plaid_agent.core import service as service_mod
from plaid_agent.core.agent import TurnResult
from plaid_agent.core.conversation import ConversationStore, build_meta, plan_prefix, user_item
from plaid_agent.core.plan import HELD_FROM, carried_pins
from plaid_agent.igt.toolkit import TOOLS, call_tool
from test_service_flow import Helper, _request, _seed, _service


def _staged():
    """A turn's plan with a value, a new entry linked to a word and an entry
    field, so the state beside the ops (new entries, entry patches) is in it."""
    w = fake_ws(FakeClient())
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'fish'})
    out = call_tool(w, 'create_entry', {'form': 'akun', 'fields': {'gloss': 'see'}})
    key = out.split('entry_id: ')[1].split()[0]
    call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w3'], 'entry_id': key})
    call_tool(w, 'set_entry_field', {'entry_id': 'vi-ali', 'field': 'pos', 'value': 'PN'})
    assert w.new_entries and len(w.ops) == 4
    return w


def _stored(state):
    """``state`` as the store gives it back: recased on the way out and back
    like any body, except under ``metadata``."""
    return transform_response(transform_request({'metadata': copy.deepcopy(state)}))['metadata']


def _next_turn(w1, payload, client=None):
    w2 = fake_ws(client or FakeClient())
    w2.waiting = {'count': 4, 'summary': payload['summary'], 'id': payload['id'], 'documents': payload['documents']}
    state = _stored(w1.plan_state())
    w2.load_plan_state = lambda plan_id: state if plan_id == payload['id'] else None
    return w2


def test_a_resumed_plan_is_the_plan_it_was():
    w1 = _staged()
    first = w1.plan_payload()
    w2 = _next_turn(w1, first)
    out = call_tool(w2, 'resume_plan', {})
    assert out.startswith('Took over 4 changes from the plan of 4 changes')
    assert w2.new_entries == w1.new_entries and w2.item_patches == w1.item_patches
    again = w2.plan_payload()
    again['documents'] = w2.with_carried_pins(again['documents'])
    assert again['ops'] == first['ops'] and again['changes'] == first['changes']
    assert again['documents'] == first['documents']
    status = call_tool(w2, 'plan_status', {})
    assert status.splitlines()[-1].startswith('This plan holds the changes of the plan of 4 changes')


def test_the_turn_adds_to_it_and_drops_from_it():
    w1 = _staged()
    w2 = _next_turn(w1, w1.plan_payload())
    call_tool(w2, 'resume_plan', {})
    out = call_tool(w2, 'set_field', {'document': 'd1', 'refs': ['s1.w3'], 'field': 'Gloss', 'value': 'net'})
    assert 'earlier message' not in out and 'the plan now holds 5 changes' in out
    # The same target as a resumed change supersedes it, as within one turn.
    out = call_tool(w2, 'set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'trout'})
    assert '1 earlier planned change on the same target superseded' in out
    assert call_tool(w2, 'drop_planned', {'field': 'Gloss'}).startswith('Dropped 2 planned changes.')
    assert [o['kind'] for o in w2.ops] == ['create_entry', 'link', 'set_entry_field']


def test_resume_is_refused_when_nothing_waits_or_the_turn_has_staged():
    w = fake_ws(FakeClient())
    assert call_tool(w, 'resume_plan', {}) == 'Error: No plan from an earlier message is waiting on its card.'
    w1 = _staged()
    w2 = _next_turn(w1, w1.plan_payload())
    call_tool(w2, 'set_field', {'document': 'd1', 'refs': ['s1.w3'], 'field': 'Gloss', 'value': 'net'})
    out = call_tool(w2, 'resume_plan', {})
    assert out == ('Error: This turn has already planned 1 change, and resume_plan only starts a plan. '
                   'discard_plan, call resume_plan, then stage them again.')
    call_tool(w2, 'discard_plan', {})
    assert call_tool(w2, 'resume_plan', {}).startswith('Took over 4 changes')
    assert 'already resumed' in call_tool(w2, 'resume_plan', {})
    # Thrown away, it may be taken over again, and what is staged after the
    # discard is said to replace the card once more.
    call_tool(w2, 'discard_plan', {})
    out = call_tool(w2, 'set_field', {'document': 'd1', 'refs': ['s1.w3'], 'field': 'Gloss', 'value': 'net'})
    assert 'To keep those changes, discard_plan, call resume_plan, then stage this again.' in out


def test_a_plan_with_no_stored_state_is_not_resumable():
    w1 = _staged()
    payload = w1.plan_payload()
    w2 = _next_turn(w1, payload)
    w2.load_plan_state = lambda plan_id: None
    assert call_tool(w2, 'resume_plan', {}) == ('Error: Resume is not available for that plan. '
                                                'Stage its changes again.')
    w2.waiting['documents'] = [{**payload['documents'][0], HELD_FROM: 3}]
    assert 'approval of that plan was under way' in call_tool(w2, 'resume_plan', {})
    assert w2.ops == []


def test_the_older_pin_is_kept_so_an_edit_since_is_refused():
    w1 = _staged()
    first = w1.plan_payload()
    client = FakeClient()
    client._documents['d1']['version'] = first['documents'][0]['version'] + 3
    w2 = _next_turn(w1, first, client)
    call_tool(w2, 'resume_plan', {})
    call_tool(w2, 'set_field', {'document': 'd1', 'refs': ['s1.w3'], 'field': 'Gloss', 'value': 'net'})
    payload = w2.plan_payload()
    [fresh] = payload['documents']
    [pin] = w2.with_carried_pins(payload['documents'])
    assert fresh['version'] == first['documents'][0]['version'] + 3
    assert pin['version'] == first['documents'][0]['version']


def test_pins_merge_older_first():
    old = [{'id': 'a', 'version': 1, 'sentences': [{'id': 's1', 'print': 'old'}]},
           {'id': 'b', 'version': 1}, {'id': 'c', 'version': 1, 'rule': True}, {'id': 'gone', 'version': 1}]
    fresh = [{'id': 'a', 'name': 'A', 'version': 4, 'sentences': [{'id': 's1', 'print': 'new'},
                                                                   {'id': 's2', 'print': 'x'}]},
             {'id': 'b', 'version': 4, 'sentences': [{'id': 's9', 'print': 'y'}]},
             {'id': 'c', 'version': 4}]
    out = carried_pins(fresh, old, {'a', 'b', 'c'})
    assert out[0] == {'id': 'a', 'name': 'A', 'version': 1,
                      'sentences': [{'id': 's1', 'print': 'old'}, {'id': 's2', 'print': 'x'}]}
    assert out[1] == {'id': 'b', 'version': 1}
    assert out[2] == {'id': 'c', 'version': 4}
    assert [d['id'] for d in carried_pins([], old, None)] == ['a', 'b', 'c', 'gone']


def test_the_schema_is_offered_after_drop_planned():
    names = [t['function']['name'] for t in TOOLS]
    assert names[names.index('drop_planned') + 1] == 'resume_plan'


def _turn(client, store, text, request_id, run):
    conv, meta = store.load('c1')
    conv['messages'].append({'role': 'user', 'content': text})
    conv['display'].append(user_item(text))
    store.save('c1', conv, build_meta(meta, 'c1', conv, 'igt:assist:fake', 'fake/model',
                                       pending={'kind': 'turn', 'request_id': request_id}))
    helper = Helper(request_id=request_id)
    service_mod.run_turn = run
    _service().process_request(_request(client), helper)
    assert not helper.errors, helper.errors
    return store.load('c1')[0]['display'][-1]


def test_the_service_stores_the_live_plan_and_a_later_turn_resumes_it(monkeypatch):
    monkeypatch.setattr(service_mod, 'run_turn', service_mod.run_turn)
    client = FakeClient()
    store = _seed(client)
    conv, meta = store.load('c1')
    conv['display'].append({'kind': 'assistant', 'text': 'ok'})
    conv['messages'].append({'role': 'assistant', 'content': 'ok'})
    store.save('c1', conv, meta)

    def first(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        call_tool(ws, 'set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'fish'})
        return TurnResult('Planned.', [{'role': 'assistant', 'content': 'Planned.'}], [])

    def second(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        seen['resume'] = call_tool(ws, 'resume_plan', {})
        call_tool(ws, 'set_field', {'document': 'd1', 'refs': ['s1.w3'], 'field': 'Gloss', 'value': 'net'})
        return TurnResult('Planned more.', [{'role': 'assistant', 'content': 'Planned more.'}], [])

    seen = {}
    one = _turn(client, store, 'gloss gam', 'r2', first)['plan']
    prefix = plan_prefix('igt', 'p1', 'c1')
    assert store.plan_state('c1', one['id'])['snapshot']['ops'][0]['value'] == 'fish'
    two = _turn(client, store, 'and akuna', 'r3', second)['plan']
    assert seen['resume'].startswith('Took over 1 change from the plan of 1 change')
    assert [o['value'] for o in two['ops']] == ['fish', 'net']
    assert two['documents'][0]['version'] == one['documents'][0]['version']
    # Only the plan staged last keeps a state.
    kept = [e['key'] for e in client.user_data.list('u@x', prefix=prefix, page_size=1000)]
    assert kept == [prefix + two['id']]
    store.delete('c1')
    assert client.user_data.list('u@x', prefix=prefix, page_size=1000) == []


def _resumes_as_it_was(make, call, stage):
    """A plan staged by ``stage`` on one workspace, resumed on another, makes
    the same payload."""
    w1 = make()
    stage(w1)
    first = w1.plan_payload()
    w2 = make()
    w2.waiting = {'count': len(w1.ops), 'summary': first['summary'], 'id': first['id'],
                  'documents': first['documents']}
    state = _stored(w1.plan_state())
    w2.load_plan_state = lambda plan_id: state
    assert call(w2, 'resume_plan', {}).startswith('Took over')
    again = w2.plan_payload()
    again['documents'] = w2.with_carried_pins(again['documents'])
    assert {k: v for k, v in again.items() if k != 'id'} == {k: v for k, v in first.items() if k != 'id'}


def test_a_ud_plan_resumes_as_it_was():
    from ud_fixtures import PID, ud_client
    from plaid_agent.ud.project import load_project
    from plaid_agent.ud.toolkit import call_tool as ud_call
    from plaid_agent.ud.tools import Workspace

    def make():
        client = ud_client()
        return Workspace(client, load_project(client, PID))
    _resumes_as_it_was(make, ud_call, lambda w: ud_call(w, 'set_field', {
        'document': 'Viaje', 'refs': ['s1.w1'], 'field': 'lemma', 'value': 'andar'}))


def test_a_umr_plan_resumes_as_it_was():
    from umr_fixtures import umr_client, umr_ws
    from plaid_agent.umr.toolkit import call_tool as umr_call
    _resumes_as_it_was(lambda: umr_ws(umr_client()), umr_call, lambda w: umr_call(w, 'set_attributes', {
        'document': 'Story', 'sentence': 1, 'var': 's1b', 'line': ':aspect state :polarity -'}))
