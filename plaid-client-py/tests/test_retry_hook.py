"""``client.on_retry``: whoever writes through the client hears that a request
is being sent again, the twin of plaid-client-js's ``client.onRetry``
(H10-CONC-5)."""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import PlaidClient  # noqa: E402


class _Resp:
    def __init__(self, status, body):
        self.status_code = status
        self.ok = 200 <= status < 300
        self.headers = {}
        self.text = json.dumps(body)
        self.content = self.text.encode()
        self.reason = 'OK' if self.ok else 'Error'

    def json(self):
        return json.loads(self.text)


def test_on_retry_hears_a_busy_read_and_a_lost_write_until_unsubscribed(monkeypatch):
    monkeypatch.setattr('time.sleep', lambda s: None)
    replies = [_Resp(503, {'error': 'Database busy'}), _Resp(200, {'id': 'p1'}),
               _Resp(502, {'error': 'Bad gateway'}), _Resp(200, {})]

    class _Session:
        def request(self, **kw):
            return replies.pop(0)

        def close(self):
            pass

    client = PlaidClient('http://localhost:0', 't', retry_delays=[0])
    client.session = _Session()
    heard = []
    stop = client.on_retry(lambda info: heard.append((info['attempt'], info['error'].status)))
    client.projects.get('p1')
    client.spans.delete('s1')
    assert heard == [(1, 503), (1, 502)]
    stop()
    replies.extend([_Resp(503, {}), _Resp(200, {'id': 'p1'})])
    client.projects.get('p1')
    assert len(heard) == 2
