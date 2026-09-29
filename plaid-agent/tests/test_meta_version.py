"""The conversation's sidebar entry names the assistant's version beside its model.

Each turn in the record names the model and the version that answered it, but
the entry a list of conversations reads named only the model, so a reader of
the list could not tell two versions of the same assistant apart. It now
carries the version of the assistant that last wrote it, and the browser, which
also rewrites the entry, keeps it (the service advertises it in its extras).
"""

from types import SimpleNamespace

from test_agent import service_args
from test_service_flow import Helper, _request, _seed, _seed_plan, _service

from plaid_agent.core import agent
from plaid_agent.core import service as service_mod
from plaid_agent.core.agent import TurnResult
from plaid_agent.core.conversation import build_meta, user_item


def test_the_entry_names_the_version_and_a_later_write_keeps_it():
    conv = {'messages': [], 'display': [user_item('Gloss it')]}
    meta = build_meta(None, 'c1', conv, 'igt:assist:m', 'm', version='0.0.0+0123abcd')
    assert meta['model'] == 'm' and meta['version'] == '0.0.0+0123abcd'
    assert build_meta(meta, 'c1', conv, None, None)['version'] == '0.0.0+0123abcd'
    assert build_meta(meta, 'c1', conv, None, None, version='0.0.0+89abcdef')['version'] == '0.0.0+89abcdef'
    assert build_meta(None, 'c1', conv, None, None)['version'] is None


def test_a_turn_writes_the_version_into_the_entry(monkeypatch):
    from fixtures import FakeClient
    client = FakeClient()
    store = _seed(client)
    monkeypatch.setattr(service_mod, 'run_turn', lambda *a, **k: TurnResult(
        'Two words.', [{'role': 'assistant', 'content': 'Two words.'}], []))
    svc = _service()
    svc.process_request(_request(client), Helper())
    _, meta = store.load('c1')
    assert meta['model'] == 'fake/model' and meta['version'] == svc.version


def test_applying_a_plan_writes_the_version_into_the_entry():
    from fixtures import FakeClient
    client = FakeClient()
    store = _seed_plan(client)
    svc = _service()
    helper = Helper(request_id='r9')
    svc.process_request(_request(client, approve={'plan_id': 'plan1', 'as_human': True}), helper)
    assert not helper.errors, helper.errors
    _, meta = store.load('c1')
    assert meta['version'] == svc.version


def test_the_service_advertises_its_version(monkeypatch):
    from plaid_agent.igt.service import AssistantService
    monkeypatch.setattr(agent.litellm, 'completion', lambda **kw: SimpleNamespace(choices=[SimpleNamespace()]))
    svc = AssistantService()
    svc.setup(service_args())
    assert svc.extras['version'] == svc.version
