"""A service request's idle timeout of None, 0 or a negative number is no
limit, as for every other timeout. Before, 0 gave up at once and None raised
TypeError after the request was accepted, with no ``pending`` mark. Mirrors
the JS ``serviceRequestTimeout.test.js``."""

import os
import sys
import time

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import services as svc_mod  # noqa: E402


class Client:
    base_url = 'http://plaid.test'
    token = 't'


class SlowStream:
    """A progress event, then 1.5 s of silence, then the result."""
    status_code = 200
    ok = True
    raw = None

    def iter_lines(self, decode_unicode=True):
        yield 'event: progress'
        yield 'data: {"progress": {"percent": 10}}'
        yield ''
        time.sleep(1.5)
        yield 'event: result'
        yield 'data: {"data": {"ok": true}}'
        yield ''

    def close(self):
        pass


@pytest.mark.parametrize('timeout', [None, 0, -1])
def test_no_idle_limit_waits_for_the_result(monkeypatch, timeout):
    monkeypatch.setattr(svc_mod.requests, 'post', lambda url, **kw: SlowStream())
    assert svc_mod.request_service(Client(), 'p1', 's1', {}, timeout=timeout) == {'ok': True}


def test_a_positive_idle_limit_still_gives_up_and_says_the_request_is_there(monkeypatch):
    monkeypatch.setattr(svc_mod.requests, 'post', lambda url, **kw: SlowStream())
    with pytest.raises(TimeoutError) as e:
        svc_mod.request_service(Client(), 'p1', 's1', {}, timeout=0.3)
    assert e.value.pending is True
