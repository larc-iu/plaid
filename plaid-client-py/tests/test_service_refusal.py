"""A service request the server refuses carries the server's reason, as every
other route's error does: in the message and as ``response_data``. The twin
of the JS ``serviceRefusal.test.js``, stating the same three facts: the
status, the response data, and that the message ends with the error."""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import services as svc_mod  # noqa: E402
from plaid_client.http import PlaidAPIError  # noqa: E402

ERROR = ('IGT Assistant is run by Ana, who is not a maintainer of Kalamang. '
         'Remove Kalamang from this conversation to go on.')


class Client:
    base_url = 'http://plaid.test'
    token = 't'


class Refused:
    status_code = 403
    reason = 'Forbidden'
    ok = False

    def __init__(self, body):
        self.body = body

    def json(self):
        if self.body is None:
            raise ValueError('not json')
        return self.body

    def close(self):
        pass


@pytest.fixture
def answering(monkeypatch):
    def answer(response):
        monkeypatch.setattr(svc_mod.requests, 'post', lambda *a, **k: response)
        monkeypatch.setattr(svc_mod.requests, 'get', lambda *a, **k: response)
    return answer


def test_a_refused_request_says_why(answering):
    answering(Refused({'error': ERROR}))
    with pytest.raises(PlaidAPIError) as e:
        svc_mod.request_service(Client(), 'p1', 's1', {}, timeout=60)
    assert e.value.status == 403
    assert e.value.response_data == {'error': ERROR}
    assert str(e.value).endswith(ERROR)


def test_a_refused_attach_says_why(answering):
    answering(Refused({'error': ERROR}))
    with pytest.raises(PlaidAPIError) as e:
        svc_mod.attach_service_request(Client(), 'p1', 'r1', timeout=60)
    assert e.value.status == 403
    assert e.value.response_data == {'error': ERROR}
    assert str(e.value).endswith(ERROR)


def test_a_refusal_with_no_readable_body_still_raises_with_its_status(answering):
    answering(Refused(None))
    with pytest.raises(PlaidAPIError) as e:
        svc_mod.request_service(Client(), 'p1', 's1', {}, timeout=60)
    assert e.value.status == 403
    assert e.value.response_data is None
