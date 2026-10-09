"""A turn works in the project its request was posted to. Core puts that
project first in ``delegated_projects``, and a request whose data names
another project is refused before anything is read or written (REV-SW-1 Q1)."""

from fixtures import FakeClient
from test_service_flow import Helper, _service
from test_single_writer import _answering, _req, _store

from plaid_agent.core.ops import ANOTHER_PROJECT


def test_a_request_naming_another_project_than_its_route_is_refused(monkeypatch):
    client = FakeClient()
    calls = []
    _answering(monkeypatch, calls=calls)
    helper = Helper(request_id='r1')
    req = {**_req(client, 'send', text='Which words are unglossed?', create=True),
           'project_id': 'p2', 'delegated_projects': ['p1', 'p2']}
    _service().process_request(req, helper)
    assert helper.errors == [ANOTHER_PROJECT]
    assert not calls, 'no model call'
    assert not client.user_data.store, 'nothing written'


def test_the_turn_takes_its_project_from_the_route(monkeypatch):
    client = FakeClient()
    _answering(monkeypatch)
    helper = Helper(request_id='r1')
    req = {**_req(client, 'send', text='Which words are unglossed?', create=True), 'delegated_projects': ['p1', 'p2']}
    del req['project_id']
    _service().process_request(req, helper)
    assert not helper.errors, helper.errors
    conv, _ = _store(client).load('c1')
    assert conv['display'][-1]['kind'] == 'assistant'


def test_a_request_with_no_scope_is_refused():
    client = FakeClient()
    helper = Helper(request_id='r1')
    req = {**_req(client, 'send', text='Hi', create=True)}
    del req['delegated_projects']
    _service().process_request(req, helper)
    assert helper.errors == ['Missing project_id or requester credentials']
    assert not client.user_data.store
