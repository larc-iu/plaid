"""A service request whose answer went missing (a proxy's 502 or 504, a
dropped connection) may well have been taken and run. It is not reported
failed: it is still running, and a request whose id is known is rejoined.
Mirrors the JS ``serviceLostAnswer.test.js``."""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import services as svc_mod  # noqa: E402


class Client:
    base_url = 'http://plaid.test'
    token = 't'


class Status:
    def __init__(self, status):
        self.status_code = status
        self.ok = False
        self.text = 'Bad Gateway'

    def close(self):
        pass


class Stream:
    status_code = 200
    ok = True
    raw = None

    def __init__(self, events):
        self.events = events

    def iter_lines(self, decode_unicode=True):
        for event, data in self.events:
            yield f'event: {event}'
            yield f'data: {data}'
            yield ''

    def close(self):
        pass


@pytest.fixture
def server(monkeypatch):
    """``answers['submit']`` and ``answers['attach']`` are lists of answers, one
    per call: a status, an exception to raise, or a list of SSE events."""
    answers = {'submit': [], 'attach': []}
    calls = []

    def answer(kind):
        calls.append(kind)
        a = answers[kind].pop(0)
        if isinstance(a, Exception):
            raise a
        if isinstance(a, int):
            return Status(a)
        return Stream(a)

    monkeypatch.setattr(svc_mod.requests, 'post', lambda url, **kw: answer('submit'))
    monkeypatch.setattr(svc_mod.requests, 'get', lambda url, **kw: answer('attach'))
    monkeypatch.setattr(svc_mod, 'REJOIN_DELAYS_S', (0, 0, 0))
    return answers, calls


@pytest.mark.parametrize('status', [502, 504])
def test_a_lost_answer_with_no_request_id_is_still_running(server, status):
    answers, calls = server
    answers['submit'] = [status]
    with pytest.raises(RuntimeError) as e:
        svc_mod.request_service(Client(), 'p1', 's1', {}, timeout=5)
    assert e.value.pending is True and e.value.status == status
    assert calls == ['submit']


def test_a_502_on_a_request_whose_id_is_known_rejoins_it(server):
    answers, calls = server
    answers['submit'] = [502]
    answers['attach'] = [[('progress', '{"progress":{"percent":90}}'),
                          ('result', '{"data":{"tokens":355}}')]]
    progress = []
    out = svc_mod.request_service(Client(), 'p1', 's1', {}, timeout=5,
                                  on_progress=progress.append, request_id='r1')
    assert out == {'tokens': 355}
    assert progress == [{'percent': 90}]
    assert calls == ['submit', 'attach']


def test_a_dropped_connection_rejoins_and_tries_again_when_the_rejoin_is_lost(server):
    answers, calls = server
    answers['submit'] = [ConnectionError('reset')]
    answers['attach'] = [504, [('result', '{"data":{"ok":true}}')]]
    out = svc_mod.request_service(Client(), 'p1', 's1', {}, timeout=5, request_id='r1')
    assert out == {'ok': True}
    assert calls == ['submit', 'attach', 'attach']


def test_a_request_the_server_never_had_gives_the_first_error(server):
    answers, _ = server
    answers['submit'] = [502]
    answers['attach'] = [404]
    with pytest.raises(RuntimeError) as e:
        svc_mod.request_service(Client(), 'p1', 's1', {}, timeout=5, request_id='r1')
    assert e.value.pending is True and e.value.status == 502


def test_a_server_error_is_the_end_of_it(server):
    answers, calls = server
    answers['submit'] = [500]
    with pytest.raises(RuntimeError) as e:
        svc_mod.request_service(Client(), 'p1', 's1', {}, timeout=5, request_id='r1')
    assert not getattr(e.value, 'pending', False)
    assert calls == ['submit']
