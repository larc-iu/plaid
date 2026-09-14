"""Strict mode stamps ``?document-version=`` on writes. Inside a batch it stamps
the FIRST QUEUED write only, which gives the whole batch one OCC check.

The bug this guards: the stamp block runs above the batch branch and used to
mark the batch stamped for any non-GET that reached it, including a call
carrying ``bypass_batch``. ``query`` is a POST, and app chrome runs one while
someone else's batch is open, so the batch's one stamp was spent on a route that
does not check it and the first real write went out unguarded.
"""

import os
import sys
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.client import PlaidClient


class _Resp:
    ok = True
    status_code = 200
    headers = {}
    text = '{}'
    content = b'{}'
    reason = 'OK'

    def json(self):
        return {'entries': [], 'next-cursor': None}


def _stub_session(client):
    sent = []

    class _Session:
        def request(self, **kw):
            sent.append({'method': kw.get('method'), 'url': kw.get('url', '')})
            return _Resp()

        def close(self):
            pass

    client.session = _Session()
    return sent


def _strict_client():
    client = PlaidClient('http://x', 'tok')
    client.enter_strict_mode('d1')
    client.document_versions = {'d1': 7}
    return client


def _version_of(url):
    values = parse_qs(urlparse(url).query).get('document-version')
    return values[0] if values else None


def test_a_bypassing_call_does_not_spend_the_batch_stamp():
    client = _strict_client()
    sent = _stub_session(client)
    client.begin_batch()
    try:
        client.query({'find': ['?t'], 'where': []})
        client.spans.update('s1', 'NOUN')
    finally:
        queued = list(client.batch_operations)
        client.abort_batch()

    assert len(sent) == 1, 'the query went over the wire on its own'
    assert [_version_of(op['path']) for op in queued] == ['7'], \
        'the first queued write must carry the document version'


def test_the_first_queued_write_takes_the_stamp_and_the_rest_go_without():
    client = _strict_client()
    _stub_session(client)
    client.begin_batch()
    try:
        client.spans.update('s1', 'NOUN')
        client.spans.update('s2', 'VERB')
        client.relations.delete('r1')
    finally:
        queued = list(client.batch_operations)
        client.abort_batch()

    assert [_version_of(op['path']) for op in queued] == ['7', None, None]


def test_a_write_outside_a_batch_always_carries_the_stamp():
    client = _strict_client()
    sent = _stub_session(client)

    client.spans.update('s1', 'NOUN')
    client.spans.update('s2', 'VERB')

    assert [_version_of(req['url']) for req in sent] == ['7', '7']
