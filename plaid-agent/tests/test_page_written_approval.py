"""A plan the app writes before it sends the approval (tagset changes, which
the assistant's delegated token may not write) is applied once its changes
read as planned, whatever the approval would otherwise refuse: the app has
written by then, so a refusal would leave the changes in force under a plan
that reads not approved (H16 review, the refused-after-write order). Against
a live core, with the app's write in Python (``write_settings``)."""

import pytest
from fixtures import project_raw, document_raw, lexicon_raw, VOCAB
from live import _Session, live_client, seed  # noqa: F401 - fixture
from test_service_flow import Helper, _service

from plaid_agent.core.conversation import ConversationStore, assistant_item, build_meta, user_item
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


def _planned(s):
    ws = Workspace(s.client, load_project(s.client, s.project_id))
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'add': ['NOM']}})
    return ws, ws.plan_payload()


def _seed(s, plan, status=None, pending=None):
    user = _Session.user
    store = ConversationStore(s.client, user, s.project_id, 'igt')
    item = assistant_item('Planned.', plan, [], [], '', 'fake/model', service='igt:assist:fake')
    item['status'] = status
    conv = {'messages': [{'role': 'user', 'content': 'add NOM'}, {'role': 'assistant', 'content': 'Planned.'}],
            'display': [user_item('add NOM'), item]}
    store.save('c1', conv, build_meta(None, 'c1', conv, 'igt:assist:fake', 'fake/model', pending=pending))
    return store


def _approve(s, svc, plan, request_id='r9', op='approve', tab='t1'):
    helper = Helper(request_id=request_id, requester_id=_Session.user)
    svc.process_request({'requester_client': s.client, 'requester_id': _Session.user, 'project_id': s.project_id,
                         'delegated_projects': [s.project_id], 'conversation_id': 'c1', 'tab': tab, 'op': op,
                         'plan_id': plan['id']}, helper)
    return helper


def _item(store):
    conv, meta = store.load('c1')
    return conv['display'][1], meta


def test_written_by_the_app_while_a_turn_runs_it_is_applied_and_the_turn_keeps_its_marker(proj):
    ws, plan = _planned(proj)
    turn = {'kind': 'turn', 'request_id': 'rT', 'service_id': 'igt:assist:fake'}
    store = _seed(proj, plan, pending=turn)
    svc = _service()
    svc._busy[(_Session.user, proj.project_id, 'c1')] = {'request_id': 'rT', 'kind': 'turn'}
    write_settings(proj.client, ws.project, ws.ops)  # the app's write, then the approval
    helper = _approve(proj, svc, plan)
    assert not helper.errors and helper.done[0]['kind'] == 'applied', (helper.errors, helper.done)
    item, meta = _item(store)
    assert item['status'] == 'applied'
    assert meta['pending']['request_id'] == 'rT', 'the running turn keeps its marker'


def test_written_by_the_app_after_a_discard_in_another_tab_it_is_applied(proj):
    ws, plan = _planned(proj)
    store = _seed(proj, plan, status='discarded')
    write_settings(proj.client, ws.project, ws.ops)
    helper = _approve(proj, _service(), plan)
    assert helper.done and helper.done[0]['kind'] == 'applied', (helper.errors, helper.done)
    assert _item(store)[0]['status'] == 'applied'


def test_a_plan_the_app_wrote_is_not_discarded(proj):
    ws, plan = _planned(proj)
    store = _seed(proj, plan)
    write_settings(proj.client, ws.project, ws.ops)
    helper = _approve(proj, _service(), plan, op='discard')
    assert helper.done[0]['kind'] == 'refused' and helper.done[0]['why'] == 'written', helper.done
    assert _item(store)[0]['status'] is None
    assert _approve(proj, _service(), plan, request_id='r10').done[0]['kind'] == 'applied'
    assert _item(store)[0]['status'] == 'applied'


def test_not_written_by_the_app_the_approval_is_refused_as_before(proj):
    _ws, plan = _planned(proj)
    store = _seed(proj, plan)
    helper = _approve(proj, _service(), plan)
    assert any('Approve it from the app' in e for e in helper.errors), (helper.errors, helper.done)
    assert _item(store)[0]['status'] is None
