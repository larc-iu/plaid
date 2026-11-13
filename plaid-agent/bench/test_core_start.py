"""lib/benchlib.py's Core.start against stand-ins for the core. No Java.

    $PLAID_AGENT_PYTHON -m pytest -q test_core_start.py

A port is only known free until the core binds it, and validate shards run at
once, so another shard's core can be answering on the port this one was
handed. Core.start must return only for the core it started, never for a
server another process runs there.
"""
import http.server
import socket
import sys
import threading
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / 'lib'))
import benchlib as bl  # noqa: E402

# Binds the port its config names after `delay` seconds (a JVM booting) and
# answers HTTP, or says what a JVM says when the port is taken.
STAND_IN = r'''
import re, sys, time, http.server
port = int(re.search(r"port = (\d+)", open(sys.argv[1]).read()).group(1))
time.sleep(float(sys.argv[2]))
try:
    server = http.server.HTTPServer(("127.0.0.1", port), http.server.BaseHTTPRequestHandler)
except OSError:
    print("java.net.BindException: Address already in use", flush=True)
    sys.exit(1)
server.serve_forever()
'''


class StandIn(bl.Core):
    delay = 1.0

    def command(self, cfg):
        return [sys.executable, '-c', STAND_IN, str(cfg), str(self.delay)]


@pytest.fixture
def other_core():
    """A server of another process's making that answers HTTP on its port."""
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), http.server.BaseHTTPRequestHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield server.server_address[1]
    server.shutdown()
    server.server_close()


def _ports(monkeypatch, first):
    ports = iter([first])
    real = bl.free_port
    monkeypatch.setattr(bl, 'free_port', lambda: next(ports, None) or real())


def test_a_port_another_core_answers_on_is_left_for_a_fresh_one(tmp_path, monkeypatch, other_core):
    _ports(monkeypatch, other_core)
    core = StandIn(None, tmp_path, tmp_path / 'core.log')
    try:
        core.start(timeout=30)
        assert core.port != other_core
        assert core.url.endswith(f':{core.port}')
        assert bl.listens(core.proc.pid, core.port)
    finally:
        core.stop()


def test_a_named_port_another_core_answers_on_fails_the_start(tmp_path, other_core):
    core = StandIn(None, tmp_path, tmp_path / 'core.log', port=other_core)
    try:
        with pytest.raises(RuntimeError, match=f'port {other_core}'):
            core.start(timeout=30)
    finally:
        core.stop()


def test_a_core_that_exits_fails_the_start_with_its_log(tmp_path):
    class Fails(bl.Core):
        def command(self, cfg):
            return [sys.executable, '-c', 'print("Startup failed: no database"); raise SystemExit(1)']

    core = Fails(None, tmp_path, tmp_path / 'core.log')
    with pytest.raises(RuntimeError, match='no database'):
        core.start(timeout=30)


def test_a_core_that_binds_is_started(tmp_path):
    core = StandIn(None, tmp_path, tmp_path / 'core.log')
    try:
        core.start(timeout=30)
        assert bl.listens(core.proc.pid, core.port)
        with socket.create_connection(('127.0.0.1', core.port), timeout=2):
            pass
    finally:
        core.stop()
