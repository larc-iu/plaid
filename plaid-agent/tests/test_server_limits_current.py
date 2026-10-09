"""Every figure the service fills to (the record's budget, a stored file's
parts) is the cap the server has NOW. Core can restart with another
``[user_data] max_value_mb`` under a running assistant: the client reads
``GET /info`` again when its connection comes back, and after a 413, and the
record and the files are cut to what it reads, with no restart of the
assistant. Against a small fake core over HTTP whose cap changes across a
simulated restart."""

import json
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from plaid_client.client import PlaidClient
from plaid_agent.core.conversation import (
    RECORD_HEADROOM, RECORD_HEADROOM_LARGE, ConversationStore, assistant_item, build_meta, conv_key, prune, record_budget, user_item,
)
from plaid_agent.core.files import VALUE_HEADROOM, Attachments, FileKeeper, value_budget

MB = 1024 * 1024


class FakeCore:
    """``/api/v1/info`` answering ``cap``, a ``/listen`` stream that ends on
    :meth:`restart`, and one user's private data, refused with 413 over
    ``cap`` and with 409 on a stale ``version``, as core does."""

    def __init__(self, cap):
        self.cap = cap
        self.info_reads = 0
        self.refused = 0
        self.data = {}
        self.restarted = threading.Event()
        core = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.0'

            def log_message(self, *args):
                pass

            def _json(self, status, body):
                out = json.dumps(body).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(out)))
                self.end_headers()
                self.wfile.write(out)

            def _key(self):
                path = urllib.parse.urlparse(self.path)
                return (urllib.parse.unquote(path.path.rsplit('/data/', 1)[1]),
                        urllib.parse.parse_qs(path.query))

            def do_GET(self):
                if self.path == '/api/v1/info':
                    core.info_reads += 1
                    return self._json(200, {'limits': {'user-data-value-bytes': core.cap}})
                if self.path.endswith('/listen'):
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
                    return
                key, _ = self._key()
                if key not in core.data:
                    return self._json(404, {'error': 'not found'})
                version, value = core.data[key]
                self._json(200, {'key': key, 'version': version, 'value': value})

            def do_PUT(self):
                key, query = self._key()
                raw = self.rfile.read(int(self.headers.get('Content-Length') or 0))
                if len(raw) > core.cap:
                    core.refused += 1
                    return self._json(413, {'error': f'Value exceeds {core.cap} bytes'})
                version = core.data.get(key, (0, None))[0]
                if 'version' in query and int(query['version'][0]) != version:
                    return self._json(409, {'error': 'version-mismatch', 'version': version})
                core.data[key] = (version + 1, json.loads(raw))
                self._json(200, {'key': key, 'version': version + 1})

            def do_DELETE(self):
                key, _ = self._key()
                core.data.pop(key, None)
                self._json(200, {})

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def restart(self, cap):
        """Every open stream ends, and core comes back with ``cap``."""
        self.cap = cap
        self.restarted.set()
        time.sleep(0.2)
        self.restarted.clear()

    def stored_bytes(self, key):
        return len(json.dumps(self.data[key][1]).encode())

    def close(self):
        self.restarted.set()
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def core():
    c = FakeCore(1 * MB)
    yield c
    c.close()


def _until(check, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(0.02)
    return False


def _open(client):
    stream = client.messages.listen('p1', lambda *_: None)
    assert stream.wait_until_settled(timeout=5) == 1
    return stream


def _heavy(items):
    """A record whose weight is in old replies' step traces, which prune
    takes from the oldest reply on, 100KB at a time."""
    display = []
    for i in range(items):
        display += [user_item(f'q{i}'),
                    assistant_item('a', None, [], [{'tool': 'x', 'output': 'y' * 100_000}], '', 'm')]
    return {'messages': [{'role': 'user', 'content': 'q'}], 'display': display + [user_item('last')]}


def _traces(core, key):
    return sum(1 for d in core.data[key][1]['display'] if d.get('steps'))


def _store(core):
    client = PlaidClient(core.url, 'tok')
    store = ConversationStore(client, 'u1', 'p1', 'igt')
    store.save('c1', {'messages': [], 'display': [user_item('q')]},
               build_meta(None, 'c1', {'messages': [], 'display': []}, 's', 'm'))
    return client, store


def _write(store, client):
    meta_of = lambda conv, prev: build_meta(prev, 'c1', conv, 's', 'm')  # noqa: E731
    assert store.write('c1', lambda _c: prune(_heavy(15), record_budget(client)), meta_of)


def test_after_core_restarts_with_a_larger_cap_the_record_fills_to_it(core):
    client, store = _store(core)
    stream = _open(client)
    assert record_budget(client) == int(1 * MB * RECORD_HEADROOM)
    assert value_budget(client) == 1 * MB - VALUE_HEADROOM
    _write(store, client)
    key = conv_key('igt', 'p1', 'c1')
    assert _traces(core, key) < 10, 'held to 1 MB'

    core.restart(2 * MB)
    assert _until(lambda: stream.ready_state == 2)
    _open(client)
    assert _until(lambda: record_budget(client) == int(2 * MB * RECORD_HEADROOM_LARGE))
    assert value_budget(client) == 2 * MB - VALUE_HEADROOM
    _write(store, client)
    assert _traces(core, key) == 15, 'the 1.5 MB record is kept whole under 2 MB'
    reads = core.info_reads
    for _ in range(5):
        record_budget(client), value_budget(client)
    assert core.info_reads == reads, 'a budget reads no /info of its own'


def test_a_413_under_a_lowered_cap_refits_the_record_to_it(core):
    core.cap = 3 * MB
    client, store = _store(core)
    assert record_budget(client) == int(3 * MB * RECORD_HEADROOM_LARGE)
    # Core restarted with 1 MB, and no stream of this client saw it.
    core.cap = 1 * MB
    _write(store, client)
    key = conv_key('igt', 'p1', 'c1')
    assert core.refused == 1, 'refused once, then made again on the cap there is'
    assert core.stored_bytes(key) <= 1 * MB and _traces(core, key) < 10


def test_a_413_under_a_lowered_cap_cuts_a_file_again(core):
    core.cap = 3 * MB
    client, store = _store(core)
    keeper = FileKeeper(store, 'c1')
    text = 'z' * (2 * MB)
    assert value_budget(client) == 3 * MB - VALUE_HEADROOM
    core.cap = 1 * MB
    a = keeper.keep(Attachments([]), 'big.txt', text)
    assert core.refused == 1
    assert a.chunks == 3, 'cut to the 1 MB cap'
    parts = sorted(k for k in core.data if ':part:' in k)
    assert len(parts) == 3 and all(core.stored_bytes(k) <= 1 * MB for k in parts)
