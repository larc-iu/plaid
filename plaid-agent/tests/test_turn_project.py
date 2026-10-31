"""A turn works in the project its request was posted to. Core puts that
project first in ``delegated_projects`` (REV-SW-1 Q1). The service framework
writes the channel's project over any the body names, tested in plaid-client-py
test_service.py."""

from fixtures import FakeClient
from test_service_flow import Helper, _service
from test_single_writer import _answering, _req, _store


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
