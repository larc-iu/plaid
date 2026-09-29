"""A write whose answer never came back may have been saved (conc-2026-09-29 V8).

H8-2: a plan batch the core committed, whose answer was lost, counted as not
applied. The user was told "PlaidAPIError: Network error: ... Nothing was
written", and approving again wrote the plan a second time over the first
attempt's leftovers.

H8-6: a lost answer to the service's save of the turn left the sidebar entry
unwritten, so the turn read as unfinished, and Retry asked the model the same
question twice. The save said "could not be reached.." with two periods.
"""

import pytest

from plaid_client import PlaidAPIError

import test_stale_by_sentence as sbs
from fixtures import FakeClient
from test_service_flow import Helper, _request, _seed, _service

from plaid_agent.core import plan as core_plan
from plaid_agent.core import service as service_mod
from plaid_agent.core.agent import TurnResult
from plaid_agent.core.conversation import ConversationStore

APPS = sbs.APPS


def _lost(method='POST', path='/api/v1/batch'):
    return PlaidAPIError(f'Network error: Remote end closed connection at http://h:8085{path}',
                         status=0, url=f'http://h:8085{path}', method=method)


@pytest.fixture(params=sorted(APPS))
def spec(request):
    return APPS[request.param]()


def _stored(spec, client):
    conv, _ = ConversationStore(client, 'u@x', spec['pid'], spec['app']).load('c1')
    return conv['display'][1]


def test_a_batch_whose_answer_was_lost_counts_as_maybe_written(spec, monkeypatch):
    client = spec['client']()
    plan, _ = sbs._plan(spec, client)
    real = core_plan.Batcher.flush

    def committed_but_unanswered(self):
        real(self)
        raise _lost()

    monkeypatch.setattr(core_plan.Batcher, 'flush', committed_but_unanswered)
    svc = spec['service']()
    spec = {**spec, 'service': lambda: svc}   # one running service, as in production
    helper = sbs._approve(spec, client, plan)
    assert helper.errors == ['Failed to apply the plan: the server did not answer. '
                             'Part of the plan may have been written.'], helper.errors
    assert 'PlaidAPIError' not in helper.errors[0]
    item = _stored(spec, client)
    assert item.get('partly_applied') is True

    # Approving again does not write the plan a second time.
    monkeypatch.setattr(core_plan.Batcher, 'flush', real)
    before = len(client.writes)
    sbs._approve(spec, client, plan)
    assert len(client.writes) == before


def test_a_refused_connection_still_says_nothing_was_written():
    import requests
    import urllib3
    refused = PlaidAPIError('Network error: refused at http://h:8085/api/v1/batch', status=0,
                            url='http://h:8085/api/v1/batch', method='POST',
                            original_error=requests.exceptions.ConnectionError(
                                urllib3.exceptions.MaxRetryError(
                                    None, '/', urllib3.exceptions.NewConnectionError(None, 'no'))))
    assert not core_plan.outcome_unknown(refused)
    assert core_plan.outcome_unknown(_lost())
    assert not core_plan.outcome_unknown(_lost('GET', '/api/v1/documents/d1'))


def test_a_client_error_reaches_the_user_without_its_class_or_address():
    def run(tracker):
        raise PlaidAPIError('HTTP 400 Span value is required at http://h:8085/api/v1/spans',
                            status=400, url='http://h:8085/api/v1/spans', method='POST')

    with pytest.raises(core_plan.PlanError) as caught:
        core_plan.applying([{'kind': 'x'}], run)
    assert str(caught.value) == 'HTTP 400 Span value is required'
    assert caught.value.unknown is False


def test_a_conversation_save_whose_answer_was_lost_is_sent_again():
    client = FakeClient()
    store = ConversationStore(client, 'u@x', 'p1', 'igt')
    real = client.user_data.put
    failures = [_lost('PUT', '/api/v1/users/u@x/data/k')]

    def put(user_id, key, value):
        real(user_id, key, value)
        if failures:
            raise failures.pop()

    client.user_data.put = put
    store.save('c1', {'messages': [], 'display': []}, {'id': 'c1', 'pending': None})
    conv, meta = store.load('c1')
    assert meta == {'id': 'c1', 'pending': None}


def test_a_refused_conversation_save_is_not_sent_again():
    client = FakeClient()
    store = ConversationStore(client, 'u@x', 'p1', 'igt')
    calls = []

    def put(user_id, key, value):
        calls.append(key)
        raise PlaidAPIError('HTTP 413 Too large', status=413, method='PUT')

    client.user_data.put = put
    with pytest.raises(PlaidAPIError):
        store.save('c1', {'messages': [], 'display': []}, {'id': 'c1'})
    assert len(calls) == 1


def test_a_save_that_failed_says_so_with_one_period(monkeypatch):
    client = FakeClient()
    _seed(client)

    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        return TurnResult('Two words.', [{'role': 'assistant', 'content': 'Two words.'}], [])

    monkeypatch.setattr(service_mod, 'run_turn', fake_run_turn)
    monkeypatch.setattr(ConversationStore, 'save', lambda self, *a: (_ for _ in ()).throw(
        PlaidAPIError('HTTP 413 The value is too large.', status=413, method='PUT')))
    helper = Helper()
    _service().process_request(_request(client), helper)
    [said] = helper.errors
    assert '..' not in said
    assert said == ('The answer is ready but the conversation could not be saved: HTTP 413 The '
                    'value is too large. It is below, and this turn is not in the record.')

    monkeypatch.setattr(ConversationStore, 'save', lambda self, *a: (_ for _ in ()).throw(
        _lost('PUT', '/api/v1/users/u@x/data/k')))
    helper = Helper()
    _service().process_request(_request(client), helper)
    assert helper.errors == ['The answer is ready, but saving the conversation got no answer. '
                             'It is below, and this turn may not be in the record.']


def test_a_plan_over_one_document_writes_at_the_version_it_had_once_held(spec):
    """conc-2026-09-29 D9: a batch of the plan's that lands after the apply
    gave up on it is refused over an edit made since, as a service's is."""
    client = spec['client']()
    plan, _ = sbs._plan(spec, client)
    version = client._documents[spec['did']]['version']
    helper = sbs._approve(spec, client, plan)
    assert helper.done and helper.done[-1]['kind'] == 'applied', helper.errors
    writes = [kind for kind, _ in client.writes]
    assert writes and client.stamps == [(kind, spec['did'], version) for kind in writes]
    assert client.strict_mode_document_id is None
