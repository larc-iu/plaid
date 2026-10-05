"""A query waits longer than core's own query limit (30 s), so a query too
broad reaches the caller as core's 408. Before, the client's 30 s timeout and
core's 30 s limit raced and the client gave up first, which read like a lost
connection. The JS twin is plaid-client-js/test/queryTimeout.test.js."""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.client import PlaidClient
from plaid_client.http import (
    DEFAULT_QUERY_TIMEOUT_S, DEFAULT_TIMEOUT_S, PlaidAPIError, query_timeout,
)


class _Resp:
    ok = True
    status_code = 200
    reason = 'OK'
    headers = {'content-type': 'application/json'}

    def json(self):
        return {'results': [], 'columns': [], 'count': 0}


def _sent_timeouts(client, call):
    seen = []

    class _Session:
        def request(self, **kw):
            seen.append(kw.get('timeout'))
            return _Resp()

    client.session = _Session()
    call(client)
    return seen


def test_the_query_timeout_is_longer_than_cores_limit():
    assert DEFAULT_QUERY_TIMEOUT_S > 30
    assert DEFAULT_QUERY_TIMEOUT_S > DEFAULT_TIMEOUT_S


def test_a_query_is_sent_with_the_query_timeout_other_reads_with_the_clients():
    client = PlaidClient('http://x', 't')
    assert _sent_timeouts(client, lambda c: c.query({'where': []})) == [DEFAULT_QUERY_TIMEOUT_S]
    assert _sent_timeouts(client, lambda c: c.projects.get('p')) == [DEFAULT_TIMEOUT_S]


def test_a_longer_client_timeout_stands():
    client = PlaidClient('http://x', 't', timeout=90.0)
    assert _sent_timeouts(client, lambda c: c.query({'where': []})) == [90.0]
    short = PlaidClient('http://x', 't', timeout=5.0)
    assert _sent_timeouts(short, lambda c: c.query({'where': []})) == [DEFAULT_QUERY_TIMEOUT_S]


@pytest.mark.parametrize('timeout', [0, None])
def test_a_disabled_timeout_stays_disabled(timeout):
    client = PlaidClient('http://x', 't', timeout=timeout)
    assert query_timeout(client) == timeout
    assert _sent_timeouts(client, lambda c: c.query({'where': []})) == [None]


def test_a_timeout_that_is_not_a_number_goes_through():
    # REV-R4-UD R3: a (connect, read) tuple, as requests takes it.
    client = PlaidClient('http://x', 't', timeout=(5, 60))
    assert query_timeout(client) == (5, 60)
    assert _sent_timeouts(client, lambda c: c.query({'where': []})) == [(5, 60)]


def test_a_query_refused_503_is_not_retried():
    # REV-R4-UD R1: core's full queue of large queries. Asking again at once
    # only joins the same queue.
    client = PlaidClient('http://x', 't')
    calls = []

    class _Busy(_Resp):
        ok = False
        status_code = 503
        reason = 'Service Unavailable'
        text = '{"error": "busy"}'

        def json(self):
            return {'error': 'The server is busy with other large queries.'}

    class _Session:
        def request(self, **kw):
            calls.append(kw['url'])
            return _Busy()

    client.session = _Session()
    with pytest.raises(PlaidAPIError) as e:
        client.query({'where': []})
    assert e.value.status == 503
    assert len(calls) == 1
