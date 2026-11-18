"""Service processes on the session's core whose request channels drop
(reconnect_service.py). Core holds a dropped service's requests 20 s for the
SAME process to come back: then they go on. A restarted process, or a second
one of the same id and account, inherits nothing: the held requests end at
once, and the pool's load with them (REV-SD-1)."""

import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

import live
from plaid_client import services as svc

HERE = Path(__file__).resolve().parent
POOL = 'reconnect-test'


_MADE: list = []


def _project(client, name):
    made = client.projects.create(f'{name}-{time.time_ns()}')
    pid = made['id'] if isinstance(made, dict) else made
    _MADE.append(pid)
    return pid


@pytest.fixture(scope='module', autouse=True)
def _delete_projects():
    """The projects the tests made go with the module, so a core the run
    reuses (PLAID_TEST_URL) keeps none of them."""
    yield
    while _MADE:
        try:
            live.core_client().projects.delete(_MADE.pop())
        except Exception:  # noqa: BLE001
            pass


class Service:
    """One reconnect_service.py process."""

    def __init__(self, client, service_id, projects, log, **env):
        extra = {'PLAID_TEST_TOKEN': client.token,
                 'PYTHONPATH': os.pathsep.join(sys.path),
                 **{k: str(v) for k, v in env.items()}}
        self.proc = subprocess.Popen([sys.executable, str(HERE / 'reconnect_service.py'), live.core_url(),
                                      service_id, str(log), *projects], env={**os.environ, **extra})
        self.log = log

    def events(self):
        if not self.log.exists():
            return []
        return [e for e in (json.loads(line) for line in self.log.read_text().splitlines())
                if e['pid'] == self.proc.pid]

    def stop(self):
        if self.proc.poll() is None:
            self.proc.kill()
        self.proc.wait()


def _until(what, check, seconds=30.0):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        found = check()
        if found:
            return found
        time.sleep(0.1)
    raise AssertionError(f'timed out waiting for {what}')


def _online(client, pid, service_id):
    return any(s.get('service_id') == service_id and s.get('online')
               for s in client.messages.discover_services(pid) or [])


def _ask(client, pid, service_id, out, key):
    def run():
        try:
            out[key] = ('result', svc.request_service(client, pid, service_id, {'x': 1}, timeout=120))
        except Exception as e:  # noqa: BLE001
            out[key] = ('error', str(e))
        out[key + ':at'] = time.monotonic()
    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t


@pytest.fixture
def client():
    return live.core_client()


def test_a_restarted_process_inherits_nothing_and_the_request_ends_at_once(client, tmp_path):
    pid = _project(client, 'reconnect-restart')
    sid = f'reconnect:restart:{time.time_ns()}'
    log = tmp_path / 'service.log'
    a = Service(client, sid, [pid], log, RECONNECT_TEST_WORK_S=60)
    b = None
    try:
        _until('A online', lambda: _online(client, pid, sid))
        out = {}
        _ask(client, pid, sid, out, 'r')
        _until('A at work', lambda: any(e['event'] == 'got' for e in a.events()))
        time.sleep(0.8)
        assert client.jobs.model_busy(POOL)['in_flight'] >= 1
        a.proc.send_signal(signal.SIGKILL)
        a.proc.wait()
        b = Service(client, sid, [pid], log, RECONNECT_TEST_WORK_S=60)
        _until('B online', lambda: _online(client, pid, sid))
        online_at = time.monotonic()
        _until('the request to end', lambda: 'r' in out, seconds=10)
        assert out['r'] == ('error', 'Service disconnected')
        assert out['r:at'] - online_at < 5, 'not at the end of the 20 s grace'
        assert client.jobs.model_busy(POOL)['in_flight'] == 0
        assert not any(e['event'] == 'got' for e in b.events()), 'B never had it'
    finally:
        a.stop()
        if b:
            b.stop()


def test_a_second_process_in_the_gap_ends_the_first_ones_requests(client, tmp_path):
    pid = _project(client, 'reconnect-second')
    sid = f'reconnect:second:{time.time_ns()}'
    log = tmp_path / 'service.log'
    a = Service(client, sid, [pid], log, RECONNECT_TEST_WORK_S=30, RECONNECT_TEST_AWAY_S=8)
    b = None
    try:
        _until('A online', lambda: _online(client, pid, sid))
        out = {}
        _ask(client, pid, sid, out, 'r')
        _until('A at work', lambda: any(e['event'] == 'got' for e in a.events()))
        time.sleep(0.8)
        a.proc.send_signal(signal.SIGUSR1)  # A's stream drops, A stays away 8 s
        _until('A offline', lambda: not _online(client, pid, sid))
        b = Service(client, sid, [pid], log)
        _until('B online', lambda: _online(client, pid, sid))
        _until('the request to end', lambda: 'r' in out, seconds=5)
        assert out['r'] == ('error', 'Service disconnected')
        _until('A to learn its request is gone', lambda: any(e['event'] == 'gone' for e in a.events()),
               seconds=10)
    finally:
        a.stop()
        if b:
            b.stop()


def test_the_same_process_dropping_on_several_projects_finishes_them_all(client, tmp_path):
    pids = [_project(client, f'reconnect-many-{i}') for i in range(3)]
    sid = f'reconnect:many:{time.time_ns()}'
    log = tmp_path / 'service.log'
    a = Service(client, sid, pids, log, RECONNECT_TEST_WORK_S=8, RECONNECT_TEST_AWAY_S=2)
    try:
        for p in pids:
            _until('A online', lambda p=p: _online(client, p, sid))
        out = {}
        for i, p in enumerate(pids):
            _ask(client, p, sid, out, f'r{i}')
        _until('A at work on all', lambda: sum(e['event'] == 'got' for e in a.events()) == 3)
        time.sleep(0.8)
        a.proc.send_signal(signal.SIGUSR1)  # every stream drops, back in about 2 s
        _until('every request to end', lambda: all(f'r{i}' in out for i in range(3)), seconds=30)
        assert [out[f'r{i}'][0] for i in range(3)] == ['result'] * 3, out
        assert [out[f'r{i}'][1]['pid'] for i in range(3)] == [a.proc.pid] * 3
        statuses = [e['status'] for e in a.events() if e['event'] == 'status']
        assert statuses.count('reconnected') == 3
    finally:
        a.stop()
