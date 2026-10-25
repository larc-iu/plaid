"""The server's clock, as its responses' Date header gives it (serverNow in
the JS client). A time the server stamped, such as an audit entry's ``ts``, is
judged against this, never the machine's own clock, which can be minutes off."""

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.client import PlaidClient


class _Resp:
    ok = True
    status_code = 200
    reason = 'OK'

    def __init__(self, date):
        self.headers = {'content-type': 'application/json'}
        if date:
            self.headers['Date'] = date
        self.content = b'{}'

    def json(self):
        return {}


def _answer(client, date):
    client.session.request = lambda **kw: _Resp(date)


def test_server_now_reads_the_servers_clock_from_the_last_response():
    client = PlaidClient('http://x', 'tok')
    server = datetime.now(timezone.utc) - timedelta(minutes=10)
    _answer(client, format_datetime(server, usegmt=True))
    client.documents.check_lock('d1')
    assert abs((client.server_now() - server).total_seconds()) < 2


def test_with_no_date_header_seen_server_now_is_this_machines_clock():
    client = PlaidClient('http://x', 'tok')
    assert abs((client.server_now() - datetime.now(timezone.utc)).total_seconds()) < 1
    _answer(client, None)
    client.documents.check_lock('d1')
    assert abs((client.server_now() - datetime.now(timezone.utc)).total_seconds()) < 1


def test_a_batchs_answer_notes_the_servers_clock_too():
    client = PlaidClient('http://x', 'tok')
    server = datetime.now(timezone.utc) - timedelta(minutes=10)

    class _BatchResp(_Resp):
        def __init__(self, ops):
            super().__init__(format_datetime(server, usegmt=True))
            self._ops = ops

        def json(self):
            return [{'status': 200, 'headers': {}, 'body': {}} for _ in self._ops]

    class _Session:
        def post(self, url, headers=None, data=None, timeout=None):
            return _BatchResp(json.loads(data))

        def close(self):
            pass

    client.session = _Session()
    with client.batched() as b:
        b.spans.update('s1', 'NOUN')
    assert abs((client.server_now() - server).total_seconds()) < 2
