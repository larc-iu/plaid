"""A query waits longer than core's own query limit (30 s), so a query too
broad reaches the caller as core's 408. Before, the client's 30 s timeout and
core's 30 s limit raced and the client gave up first, which read like a lost
connection. The JS twin is plaid-client-js/test/queryTimeout.test.js."""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.client import PlaidClient
from plaid_client.http import DEFAULT_QUERY_TIMEOUT_S, DEFAULT_TIMEOUT_S, query_timeout


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
