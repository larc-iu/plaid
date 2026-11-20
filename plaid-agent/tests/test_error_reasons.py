"""Why a turn ended without an answer, as its error item says it (``reason``),
and how many such items a conversation shows, as its sidebar entry says it
(``errors``, ``last_error``). The reason is set by the code that ends the turn
each way, never read from the line, so the admin Assistant tab can count the
turns cut off at the output limit without reading every record by hand."""

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
from plaid_agent.core.conversation import (ERROR_REASONS, ConversationStore, build_meta, error_item, kept_meta,
                                           rewind_for_retry, user_item)
from plaid_agent.research.records import turn_end


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
def test_a_failed_turn_records_its_reason_and_the_entry_counts_it(monkeypatch, raised, reason):
    conv, meta = _ended(monkeypatch, raised)
    item = conv['display'][-1]
    assert item['kind'] == 'error' and item['reason'] == reason
    assert meta['errors'] == 1
    assert meta['last_error'] == {'reason': reason, 'at': item['created_at']}


def test_a_stop_is_stopped_and_a_lost_request_is_connection_lost(monkeypatch):
    helper = Helper()
    helper.cancelled = True
    conv, meta = _ended(monkeypatch, TurnCancelled(), helper)
    assert conv['display'][-1]['reason'] == 'stopped' and meta['last_error']['reason'] == 'stopped'

    gone = GoneHelper()
    gone.gone = True
    conv, meta = _ended(monkeypatch, TurnCancelled(), gone)
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
    conv, meta = store.load('c1')
    assert conv['display'][-1]['reason'] == 'other' and meta['errors'] == 1


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
    conv, meta = store.load('c1')
    assert conv['display'][-1]['reason'] == 'too-large' and meta['last_error']['reason'] == 'too-large'


def test_a_turn_that_never_wrote_its_end_is_connection_lost_at_retry():
    conv = {'messages': [{'role': 'user', 'content': 'q'}], 'display': [user_item('q')]}
    rewound, _question = rewind_for_retry(conv)
    assert rewound['display'][-1]['lost'] is True and rewound['display'][-1]['reason'] == 'connection-lost'


def test_the_entry_counts_every_error_item_and_names_the_newest():
    first = {**error_item('Stopped.', 'stopped'), 'created_at': '2026-11-20T10:00:00Z'}
    second = {**error_item(cut_line(9), 'output-limit'), 'created_at': '2026-11-20T11:00:00Z'}
    conv = {'messages': [], 'display': [user_item('a'), first, user_item('b'), second]}
    meta = build_meta(None, 'c1', conv, 's', 'm')
    assert meta['errors'] == 2
    assert meta['last_error'] == {'reason': 'output-limit', 'at': '2026-11-20T11:00:00Z'}
    clean = build_meta(None, 'c1', {'messages': [], 'display': [user_item('a')]}, 's', 'm')
    assert clean['errors'] == 0 and clean['last_error'] is None
    # A hold or a rename leaves the counts, and a changed transcript recounts.
    assert kept_meta(meta, holder={'tab': 't'})['errors'] == 2
    assert kept_meta(meta, {'messages': [], 'display': [user_item('a')]})['errors'] == 0


def test_the_research_records_read_the_reason_where_it_is_present():
    assert turn_end({'kind': 'error', 'text': 'Anything at all.', 'reason': 'output-limit'}) == 'cut_at_length'
    # A record written before reasons is still read by its line.
    assert turn_end({'kind': 'error', 'text': cut_line(9)}) == 'cut_at_length'
