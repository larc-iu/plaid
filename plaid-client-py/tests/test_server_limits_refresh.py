"""The limits a client read from ``GET /info`` are read again when they may
have changed, and only then: after the client's connection to the server
dropped and came back (a core restart always drops it, and a restart is the
only way the limits change), and after a user-data write refused as too large.
Read against a small fake core over HTTP, whose cap changes across a
simulated restart. The JS client's twin is test/serverLimitsRefresh.test.js."""

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from plaid_client.client import PlaidClient
from plaid_client.http import PlaidAPIError
from plaid_client.service import BaseService


class FakeCore:
    """``/api/v1/info`` answering ``cap``, a project ``/listen`` stream that
    stays open until :meth:`restart` ends it, and a user-data PUT refused
    with 413 over ``cap``."""

    def __init__(self, cap):
        self.cap = cap
        self.info_reads = 0
        self.restarted = threading.Event()
        core = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.0'

            def log_message(self, *args):
                pass

            def _json(self, status, body):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                if self.path == '/api/v1/info':
                    core.info_reads += 1
                    self._json(200, {'version': 't', 'limits': {'user-data-value-bytes': core.cap}})
                elif self.path.endswith('/listen'):
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/event-stream')
                    self.end_headers()
                    try:
                        self.wfile.write(b'event: connected\ndata: {"client-id": "c"}\n\n')
                        self.wfile.flush()
                        while not core.restarted.wait(0.05):
                            self.wfile.write(b': keepalive\n\n')
                            self.wfile.flush()
                    except OSError:
                        pass
                else:
                    self._json(404, {'error': 'not found'})

            def do_PUT(self):
                n = int(self.headers.get('Content-Length') or 0)
                self.rfile.read(n)
                if n > core.cap:
                    self._json(413, {'error': f'Value exceeds {core.cap} bytes'})
                else:
                    self._json(200, {'key': 'k', 'version': 1})

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def restart(self, cap):
        """Every open stream ends, and the core comes back with ``cap``."""
        self.cap = cap
        self.restarted.set()
        time.sleep(0.2)
        self.restarted.clear()

    def close(self):
        self.restarted.set()
        self.server.shutdown()
        self.server.server_close()


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
