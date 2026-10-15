"""A plan the app writes before it sends the approval (tagset changes, which
the assistant's delegated token may not write). The page asks a preflight
first, which runs every check the approval runs and writes nothing but a mark
on the plan that its page writes next; only on ``ready`` does it write, and
then it sends the approval with ``wrote_first``. Such an approval is applied once the changes read as planned,
whatever landed after the preflight (a discard, a newer plan, another turn),
and records the approver as the approval's own path does. Settings that read
as planned by any other route take the approval's own path, and a discard of
them is allowed, unless a ready preflight marked the plan: a discard of a
marked plan whose settings read as planned records it applied (H16 review,
REV-AGENT-1 to -3, -5, R2-1). Against a live core,
with the app's write in Python (``write_settings``)."""

import pytest
from fixtures import project_raw, document_raw, lexicon_raw, VOCAB
from live import _Session, live_client, seed  # noqa: F401 - fixture
from test_service_flow import Helper, _service
from test_tagset_tools import _user

from plaid_agent.core.conversation import (ConversationStore, assistant_item, build_meta, replace_undecided,
                                           user_item)
from plaid_agent.igt.project import load_project
from plaid_agent.igt.tagsets import write_settings
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.workspace import Workspace


@pytest.fixture
def proj(live_client):
    s = seed(live_client, project_raw(), {'d1': document_raw()}, {VOCAB: lexicon_raw()},
             name='igt-agent page-written approval test')
    yield s
    s.delete()


def _planned(s, add='NOM'):
    ws = Workspace(s.client, load_project(s.client, s.project_id))
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'add': [add]}})
    return ws, ws.plan_payload()


def _seed(s, plan, status=None, pending=None, conv_id='c1', user=None, client=None):
    store = ConversationStore(client or s.client, user or _Session.user, s.project_id, 'igt')
    item = assistant_item('Planned.', plan, [], [], '', 'fake/model', service='igt:assist:fake')
    item['status'] = status
    conv = {'messages': [{'role': 'user', 'content': 'add NOM'}, {'role': 'assistant', 'content': 'Planned.'}],
            'display': [user_item('add NOM'), item]}
    store.save(conv_id, conv, build_meta(None, conv_id, conv, 'igt:assist:fake', 'fake/model', pending=pending))
    return store


def _ask(s, plan, op='approve', request_id='r9', svc=None, conv_id='c1', tab='t1', user=None, client=None, **data):
    user = user or _Session.user
    helper = Helper(request_id=request_id, requester_id=user)
    (svc or _service()).process_request({
        'requester_client': client or s.client, 'requester_id': user, 'project_id': s.project_id,
        'delegated_projects': [s.project_id], 'conversation_id': conv_id, 'tab': tab, 'op': op,
        'plan_id': plan['id'], **data}, helper)
    return helper


def _item(store, conv_id='c1'):
    conv, meta = store.load(conv_id)
    return conv['display'][1], meta


def _ready(h):
    return not h.errors and h.done and h.done[0].get('kind') == 'ready'


def _applied(h):
    return not h.errors and h.done and h.done[0].get('kind') == 'applied'


# --- the preflight -------------------------------------------------------------------

def test_the_preflight_is_ready_for_an_undecided_plan_and_only_marks_it(proj):
    _ws, plan = _planned(proj)
    store = _seed(proj, plan)
    assert _ready(_ask(proj, plan, preflight=True))
    item, meta = _item(store)
    assert item['status'] is None and item['plan']['page_writing'] == {'as_human': False, 'reviewed': False}, \
        'marked: the page writes next'
    assert meta.get('pending') is None
    assert 'NOM' not in str(proj.client.projects.get(proj.project_id)['config'])


@pytest.mark.parametrize('how, said', [
    ('discard', 'The plan was discarded'),
    ('replace', 'A newer plan replaced this one. Approve the newer plan.'),
])
def test_the_preflight_refuses_a_plan_decided_otherwise(proj, how, said):
    _ws, plan = _planned(proj)
    store = _seed(proj, plan)
    if how == 'discard':
        assert _ask(proj, plan, op='discard').done[0]['kind'] == 'done'
    else:
        store.write('c1', lambda st: {'messages': st['messages'], 'display': replace_undecided(st['display'])},
                    lambda c, prev: prev, None)
    h = _ask(proj, plan, request_id='r10', preflight=True)
    assert h.errors == [said] and not h.done, (h.errors, h.done)


def test_the_preflight_refuses_a_gone_conversation_a_held_one_and_a_busy_one(proj):
    _ws, plan = _planned(proj)
    store = _seed(proj, plan, pending={'kind': 'turn', 'request_id': 'rT', 'service_id': 'igt:assist:fake'})
    svc = _service()
    svc._busy[(_Session.user, proj.project_id, 'c1')] = {'request_id': 'rT', 'kind': 'turn'}
    h = _ask(proj, plan, svc=svc, preflight=True)
    assert h.done[0]['kind'] == 'refused' and h.done[0]['why'] == 'busy', h.done
    from plaid_agent.core.conversation import now_iso
    store.write_meta('c1', lambda m: {**m, 'pending': None, 'holder': {'tab': 't2', 'at': now_iso()}})
    h = _ask(proj, plan, request_id='r11', preflight=True)
    assert h.done[0]['kind'] == 'refused' and h.done[0]['why'] == 'held', h.done
    store.delete('c1')
    h = _ask(proj, plan, request_id='r10', preflight=True)
    assert h.done[0]['kind'] == 'refused' and h.done[0]['why'] == 'gone', h.done


def test_the_preflight_refuses_an_approver_who_maintains_nothing(proj):
    _user(proj.client, 'tagset-preflight-writer@x.org')
    proj.client.projects.add_writer(proj.project_id, 'tagset-preflight-writer@x.org')
    writer = _user(proj.client, 'tagset-preflight-writer@x.org')
    _ws, plan = _planned(proj)
    _seed(proj, plan, user='tagset-preflight-writer@x.org', client=writer)
    h = _ask(proj, plan, user='tagset-preflight-writer@x.org', client=writer, preflight=True)
    assert h.errors == ['Only a maintainer of this project may approve its tagset changes. Nothing was written.'], \
        (h.errors, h.done)


# --- what lands between the preflight and the write loses to the write -----------------

@pytest.mark.parametrize('between', ['discard', 'replace', 'turn'])
def test_a_decision_after_the_preflight_loses_to_the_pages_write(proj, between):
    ws, plan = _planned(proj)
    store = _seed(proj, plan)
    svc = _service()
    assert _ready(_ask(proj, plan, svc=svc, preflight=True))
    if between == 'discard':
        assert _ask(proj, plan, op='discard', request_id='rD', tab='t2').done[0]['kind'] == 'done'
        assert 'ops' in _item(store)[0]['plan'], 'a plan the page writes keeps its ops when settled'
    elif between == 'replace':
        store.write('c1', lambda st: {'messages': st['messages'], 'display': replace_undecided(st['display'])},
                    lambda c, prev: prev, None)
    else:
        store.write_meta('c1', lambda m: {**m, 'pending': {'kind': 'turn', 'request_id': 'rT',
                                                            'service_id': 'igt:assist:fake'}})
        svc._busy[(_Session.user, proj.project_id, 'c1')] = {'request_id': 'rT', 'kind': 'turn'}
    write_settings(proj.client, ws.project, ws.ops)  # the page's write
    h = _ask(proj, plan, svc=svc, request_id='r10', wrote_first=True)
    assert _applied(h), (h.errors, h.done)
    item, meta = _item(store)
    assert item['status'] == 'applied'
    if between == 'turn':
        assert meta['pending']['request_id'] == 'rT', 'the running turn keeps its marker'


def test_a_reviewed_approvers_approval_is_recorded_as_a_contribution(proj):
    from plaid_client.provenance import REVIEW_KEY
    proj.client.projects.set_config(proj.project_id, 'plaid', REVIEW_KEY, {'users': [_Session.user], 'roles': []})
    ws, plan = _planned(proj)
    store = _seed(proj, plan)
    write_settings(proj.client, ws.project, ws.ops)
    assert _applied(_ask(proj, plan, wrote_first=True, as_human=True))
    item, _ = _item(store)
    assert item['status'] == 'applied' and item.get('contributed') is True and item.get('as_human') is False, item


# --- settings that read as planned by any other route -----------------------------------

def test_settings_written_by_hand_leave_the_plan_discardable(proj):
    ws, plan = _planned(proj)
    store = _seed(proj, plan)
    write_settings(proj.client, ws.project, ws.ops)  # by hand, no plan, no approval
    h = _ask(proj, plan, op='discard')
    assert h.done[0]['kind'] == 'done', h.done
    assert _item(store)[0]['status'] == 'discarded'


def test_without_wrote_first_a_discarded_plan_is_not_applied(proj):
    ws, plan = _planned(proj)
    store = _seed(proj, plan)
    assert _ask(proj, plan, op='discard').done[0]['kind'] == 'done'
    write_settings(proj.client, ws.project, ws.ops)
    h = _ask(proj, plan, request_id='r10')
    assert h.errors == ['The plan was discarded']
    assert _item(store)[0]['status'] == 'discarded'


def test_a_page_that_says_it_wrote_and_did_not_is_refused_as_before(proj):
    _ws, plan = _planned(proj)
    store = _seed(proj, plan)
    h = _ask(proj, plan, wrote_first=True)
    assert any('Approve it from the app' in e for e in h.errors), (h.errors, h.done)
    assert _item(store)[0]['status'] is None


def test_settings_written_to_another_value_are_not_applied(proj):
    _ws, plan = _planned(proj)
    store = _seed(proj, plan)
    other = Workspace(proj.client, load_project(proj.client, proj.project_id))
    call_tool(other, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'add': ['NOM', 'ACC']}})
    write_settings(proj.client, other.project, other.ops)
    h = _ask(proj, plan, wrote_first=True)
    assert not _applied(h) and _item(store)[0]['status'] != 'applied', (h.errors, h.done)


# --- the approval lost after the page wrote (R2-1) ----------------------------------------

def test_a_discard_after_a_lost_approval_records_the_written_plan_applied(proj):
    ws, plan = _planned(proj)
    store = _seed(proj, plan)
    assert _ready(_ask(proj, plan, preflight=True))
    write_settings(proj.client, ws.project, ws.ops)  # the page wrote; its approval never came
    h = _ask(proj, plan, op='discard', request_id='r10')
    assert h.done[0]['kind'] == 'refused' and h.done[0]['why'] == 'decided', h.done
    assert h.done[0]['message'] == 'The settings were already written, so the plan is recorded as applied.'
    item, _ = _item(store)
    assert item['status'] == 'applied' and 'page_writing' not in item['plan'], item
    # Approving again is a duplicate, not a second write.
    assert _ask(proj, plan, request_id='r11').done[0]['duplicate'] is True


def test_a_marked_plan_the_page_never_wrote_is_discarded(proj):
    _ws, plan = _planned(proj)
    store = _seed(proj, plan)
    assert _ready(_ask(proj, plan, preflight=True))
    assert _ask(proj, plan, op='discard', request_id='r10').done[0]['kind'] == 'done'
    assert _item(store)[0]['status'] == 'discarded'


def test_a_marked_plan_whose_settings_moved_is_discarded(proj):
    _ws, plan = _planned(proj)
    store = _seed(proj, plan)
    assert _ready(_ask(proj, plan, preflight=True))
    other = Workspace(proj.client, load_project(proj.client, proj.project_id))
    call_tool(other, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'add': ['NOM', 'ACC']}})
    write_settings(proj.client, other.project, other.ops)
    assert _ask(proj, plan, op='discard', request_id='r10').done[0]['kind'] == 'done'
    assert _item(store)[0]['status'] == 'discarded'


def test_an_approval_clears_the_mark(proj):
    ws, plan = _planned(proj)
    store = _seed(proj, plan)
    assert _ready(_ask(proj, plan, preflight=True))
    write_settings(proj.client, ws.project, ws.ops)
    assert _applied(_ask(proj, plan, request_id='r10', wrote_first=True))
    assert 'page_writing' not in _item(store)[0]['plan']


# --- the mark after a failed write, and what it remembers (R3-1, R3-2) ----------------------

def test_a_failed_write_takes_the_mark_off_so_a_later_hand_write_leaves_it_discardable(proj):
    ws, plan = _planned(proj)
    store = _seed(proj, plan)
    assert _ready(_ask(proj, plan, preflight=True))
    # The page's write threw: it says so.
    assert _ask(proj, plan, op='unmark', request_id='r10').done[0]['kind'] == 'done'
    assert 'page_writing' not in _item(store)[0]['plan']
    write_settings(proj.client, ws.project, ws.ops)  # later, by hand
    assert _ask(proj, plan, op='discard', request_id='r11').done[0]['kind'] == 'done'
    assert _item(store)[0]['status'] == 'discarded'


def test_an_unmark_after_the_settings_read_as_planned_keeps_the_mark(proj):
    ws, plan = _planned(proj)
    store = _seed(proj, plan)
    assert _ready(_ask(proj, plan, preflight=True))
    write_settings(proj.client, ws.project, ws.ops)  # the write landed, its answer did not
    assert _ask(proj, plan, op='unmark', request_id='r10').done[0]['kind'] == 'done'
    assert _item(store)[0]['plan']['page_writing']
    h = _ask(proj, plan, op='discard', request_id='r11')
    assert h.done[0]['why'] == 'decided' and _item(store)[0]['status'] == 'applied'


def test_a_discard_records_the_lost_approvals_box(proj):
    ws, plan = _planned(proj)
    store = _seed(proj, plan)
    assert _ready(_ask(proj, plan, preflight=True, as_human=True))
    write_settings(proj.client, ws.project, ws.ops)
    _ask(proj, plan, op='discard', request_id='r10')
    item, _ = _item(store)
    assert item['status'] == 'applied' and item['as_human'] is True and not item.get('contributed'), item


def test_a_discard_records_a_reviewed_approver_as_the_preflight_read_them(proj):
    from plaid_client.provenance import REVIEW_KEY
    proj.client.projects.set_config(proj.project_id, 'plaid', REVIEW_KEY, {'users': [_Session.user], 'roles': []})
    ws, plan = _planned(proj)
    store = _seed(proj, plan)
    assert _ready(_ask(proj, plan, preflight=True, as_human=True))
    proj.client.projects.set_config(proj.project_id, 'plaid', REVIEW_KEY, {'users': [], 'roles': []})
    write_settings(proj.client, ws.project, ws.ops)
    _ask(proj, plan, op='discard', request_id='r10')
    item, _ = _item(store)
    assert item['status'] == 'applied' and item.get('contributed') is True and item['as_human'] is False, item
