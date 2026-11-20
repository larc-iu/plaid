"""Why a turn ended without an answer, as its error item says it (``reason``).
The reason is set by the code that ends the turn each way, never read from
the line."""

from types import SimpleNamespace

import pytest

from fixtures import FakeClient
from plaid_client import PlaidAPIError
from test_lost_request import GoneHelper
from test_service_flow import Helper, _request, _seed, _service
from test_turn_failures import Script, _call, _provider_errors, _resp, _turn

from plaid_agent.core import turn as turn_mod
from plaid_agent.core.agent import (EMPTY_REPLY, REPEATING_LINE, TurnCancelled, TurnFailed, TurnResult, cut_line,
                                    failure_reason)
from plaid_agent.core.conversation import ERROR_REASONS, ConversationStore, error_item, rewind_for_retry, user_item


def test_the_reasons_are_a_closed_set_and_an_item_carries_its_own():
    assert ERROR_REASONS == ('stopped', 'connection-lost', 'output-limit', 'no-answer', 'model', 'too-large',
                             'other')
    item = error_item('Stopped.', 'stopped')
    assert item['reason'] == 'stopped' and item['stopped'] is True
    assert 'stopped' not in error_item('x', 'model')
    with pytest.raises(ValueError):
        error_item('x', 'cut')


def test_a_call_that_reaches_the_cap_ends_the_turn_as_output_limit(monkeypatch):
    resp = _resp('Half a', calls=[_call(1, 'read', '{"x": ')], finish='length')
    resp.usage = SimpleNamespace(prompt_tokens=900, completion_tokens=32768)
    with pytest.raises(TurnFailed) as e:
        _turn(monkeypatch, Script(resp))
    assert e.value.reason == 'output-limit' and failure_reason(e.value) == 'output-limit'


def test_an_empty_reply_ends_the_turn_as_no_answer(monkeypatch):
    with pytest.raises(TurnFailed) as e:
        _turn(monkeypatch, Script(_resp(''), _resp('')))
    assert str(e.value) == EMPTY_REPLY and e.value.reason == 'no-answer'


def test_a_failure_is_the_models_when_the_provider_failed_and_other_otherwise():
    for name, error in _provider_errors().items():
        assert failure_reason(error) == 'model', name
    assert failure_reason(RuntimeError('a bug')) == 'other'
    assert failure_reason(TurnFailed(REPEATING_LINE, 'no-answer')) == 'no-answer'


def _ended(monkeypatch, raised, helper=None):
    client = FakeClient()
    store = _seed(client)

    def fake_run_turn(*a, **k):
        raise raised

    monkeypatch.setattr(turn_mod, 'run_turn', fake_run_turn)
    _service().process_request(_request(client), helper or Helper())
    return store.load('c1')


@pytest.mark.parametrize('raised, reason', [
    (TurnFailed(cut_line(32768), 'output-limit'), 'output-limit'),
    (TurnFailed(EMPTY_REPLY, 'no-answer'), 'no-answer'),
    (_provider_errors()['server'], 'model'),
    (RuntimeError('a bug'), 'other'),
])
def test_a_failed_turn_records_its_reason(monkeypatch, raised, reason):
    conv, _meta = _ended(monkeypatch, raised)
    item = conv['display'][-1]
    assert item['kind'] == 'error' and item['reason'] == reason


def test_a_stop_is_stopped_and_a_lost_request_is_connection_lost(monkeypatch):
    helper = Helper()
    helper.cancelled = True
    conv, _meta = _ended(monkeypatch, TurnCancelled(), helper)
    assert conv['display'][-1]['reason'] == 'stopped'

    gone = GoneHelper()
    gone.gone = True
    conv, _meta = _ended(monkeypatch, TurnCancelled(), gone)
    assert conv['display'][-1]['reason'] == 'connection-lost'
    assert 'stopped' not in conv['display'][-1]


def test_a_failure_before_the_turn_began_records_its_reason(monkeypatch):
    client = FakeClient()
    store = _seed(client)
    svc = _service()

    def no_project(*a, **k):
        raise ValueError('Project not found')

    monkeypatch.setattr(svc, 'load_project', no_project)
    svc.process_request(_request(client), Helper())
    conv, _meta = store.load('c1')
    assert conv['display'][-1]['reason'] == 'other'


def test_an_answer_too_large_to_save_is_recorded_as_too_large(monkeypatch):
    client = FakeClient()
    store = _seed(client)

    def fake_run_turn(*a, **k):
        return TurnResult('Two words.', [{'role': 'assistant', 'content': 'Two words.'}], [])

    monkeypatch.setattr(turn_mod, 'run_turn', fake_run_turn)
    real_write = ConversationStore.write
    refused = []

    def write(self, *a, **k):
        if not refused:
            refused.append(True)
            raise PlaidAPIError('HTTP 413 The value is too large.', status=413, method='PUT')
        return real_write(self, *a, **k)

    monkeypatch.setattr(ConversationStore, 'write', write)
    _service().process_request(_request(client), Helper())
    conv, _meta = store.load('c1')
    assert conv['display'][-1]['reason'] == 'too-large'


def test_a_turn_that_never_wrote_its_end_is_connection_lost_at_retry():
    conv = {'messages': [{'role': 'user', 'content': 'q'}], 'display': [user_item('q')]}
    rewound, _question = rewind_for_retry(conv)
    assert rewound['display'][-1]['lost'] is True and rewound['display'][-1]['reason'] == 'connection-lost'
