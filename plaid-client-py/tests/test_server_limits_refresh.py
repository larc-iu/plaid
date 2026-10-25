"""The limits a client read from ``GET /info`` are read again when they may
have changed, and only then: after the client's connection to the server
dropped and came back (a core restart always drops it, and a restart is the
only way the limits change), and after a user-data write refused as too large.
Read against a small fake core over HTTP (``plaid_client.testing.FakeCore``),
whose cap changes across a simulated restart. The JS client's twin is test/serverLimitsRefresh.test.js."""

import time

import pytest

from plaid_client.client import PlaidClient
from plaid_client.http import PlaidAPIError
from plaid_client.service import BaseService
from plaid_client.testing import FakeCore


@pytest.fixture
def core():
    c = FakeCore(1_048_576)
    yield c
    c.close()


def _until(check, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(0.02)
    return False


def _cap(client):
    return client.server.limits()['user_data_value_bytes']


def _open(client):
    stream = client.messages.listen('p1', lambda *_: None)
    assert stream.wait_until_settled(timeout=5) == 1
    return stream


def test_a_reconnect_after_a_restart_reads_the_limits_again_once(core):
    client = PlaidClient(core.url, 'tok')
    assert _cap(client) == 1_048_576
    streams = [_open(client), _open(client)]
    assert _cap(client) == 1_048_576 and core.info_reads == 1, 'read once, then kept'

    core.restart(2_097_152)
    assert _until(lambda: all(s.ready_state == 2 for s in streams))
    # Nothing is read while the server is away, and no reader pays a round trip.
    assert _cap(client) == 1_048_576 and core.info_reads == 1

    # Both streams come back, and the limits are read again once between them.
    streams = [_open(client), _open(client)]
    assert _until(lambda: _cap(client) == 2_097_152)
    assert core.info_reads == 2
    for s in streams:
        s.close()


def test_a_stream_this_side_closed_reads_nothing_again(core):
    client = PlaidClient(core.url, 'tok')
    _cap(client)
    _open(client).close()
    core.cap = 2_097_152
    _open(client).close()
    assert _cap(client) == 1_048_576 and core.info_reads == 1


def test_a_413_reads_the_cap_again_before_it_is_raised(core):
    client = PlaidClient(core.url, 'tok')
    core.cap = 3_000_000
    assert _cap(client) == 3_000_000
    # The server restarted with a lower cap, and this client never held a
    # stream that would have told it.
    core.cap = 1_000
    with pytest.raises(PlaidAPIError) as e:
        client.user_data.put('u1', 'k', 'x' * 2_000)
    assert e.value.status == 413
    assert _cap(client) == 1_000 and core.info_reads == 2


def test_a_requester_reads_the_limits_its_service_holds():
    """A delegating service's requester client reads no /info of its own: it
    shares the service client's, which the service's connection keeps
    current."""
    seen = []

    class Svc(BaseService):
        def process_request(self, request_data, response_helper):
            seen.append(request_data['requester_client'])
            response_helper.complete('ok')

    class Helper:
        def error(self, *a):
            raise AssertionError(a)

        def complete(self, *a):
            pass

    svc = Svc('t:svc', 'Svc', 'desc', delegation=True)
    svc.client = PlaidClient('http://plaid.test', 'service-token')
    svc.handle_service_request({'delegated_token': 'user-token'}, Helper()).join(timeout=5)
    assert seen[0].token == 'user-token'
    assert seen[0]._server_facts is svc.client._server_facts
