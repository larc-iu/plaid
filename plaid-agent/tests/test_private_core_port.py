"""The private core's port is only known free until the JVM binds it. A core
that finds it taken is launched again on a fresh one, so a busy CI runner
cannot fail the whole live suite (v0.2.0-alpha.31's release run, 2026-10-27).
A small Python server stands in for the core."""

import socket
import sys

import private_core

# Binds the port its config names and answers HTTP, or says what a JVM says.
STAND_IN = r'''
import re, sys, http.server
port = int(re.search(r"port = (\d+)", open(sys.argv[1]).read()).group(1))
try:
    server = http.server.HTTPServer(("127.0.0.1", port), http.server.BaseHTTPRequestHandler)
except OSError:
    print("java.net.BindException: Address already in use", flush=True)
    sys.exit(1)
server.serve_forever()
'''


def _held_ports(monkeypatch, taken):
    """The first port handed out is held open by `taken`, the rest are free."""
    ports = iter([taken.getsockname()[1]])
    real = private_core._free_port
    monkeypatch.setattr(private_core, '_free_port', lambda: next(ports, None) or real())
    monkeypatch.setattr(private_core, 'command', lambda config: [sys.executable, '-c', STAND_IN, str(config)])


def test_a_taken_port_is_launched_again_on_a_fresh_one(monkeypatch):
    with socket.socket() as taken:
        taken.bind(('127.0.0.1', 0))
        taken.listen()
        first = taken.getsockname()[1]
        _held_ports(monkeypatch, taken)
        core = private_core.PrivateCore()
        try:
            core.wait(timeout=30)
            assert core.port != first
            assert private_core.answers(core.url)
        finally:
            core.stop()


def test_a_core_that_fails_for_another_reason_still_raises(monkeypatch):
    monkeypatch.setattr(private_core, 'command',
                        lambda config: [sys.executable, '-c', 'print("Startup failed: no database"); raise SystemExit(1)'])
    core = private_core.PrivateCore()
    try:
        try:
            core.wait(timeout=30)
        except RuntimeError as e:
            assert 'no database' in str(e)
        else:
            raise AssertionError('a core that cannot start must raise')
    finally:
        core.stop()
