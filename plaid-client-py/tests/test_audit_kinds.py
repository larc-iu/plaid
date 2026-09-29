"""Every audit read takes ``kinds``, the operation kinds to keep, and sends it
as ``?kinds=`` in the same comma-separated form ``op_types`` goes in, as the
JS client's ``kinds`` does."""

import json
import os
import sys
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import PlaidClient


class _Resp:
    ok = True
    status_code = 200
    reason = 'OK'

    def __init__(self, body):
        self._body = body
        self.headers = {'content-type': 'application/json'}
        self.text = json.dumps(body)
        self.content = self.text.encode()

    def json(self):
        return self._body


def _stub(client):
    sent = []

    class _Session:
        def request(self, **kw):
            url = urlparse(kw['url'])
            sent.append((url.path, {k: v[0] for k, v in parse_qs(url.query).items()}))
            return _Resp({'entries': [], 'next-cursor': None})

        def close(self):
            pass

    client.session = _Session()
    return sent


KINDS = ['review', 'guess-adoption']


def test_every_audit_read_sends_kinds_from_a_list_or_a_string():
    c = PlaidClient('http://x', 'tok')
    sent = _stub(c)
    c.documents.audit('d1', kinds=KINDS)
    c.documents.audit_page('d1', kinds=KINDS)
    c.projects.audit('p1', kinds=KINDS)
    c.projects.audit_page('p1', kinds=KINDS)
    c.users.audit('u1', kinds=KINDS)
    c.users.audit_page('u1', kinds=KINDS)
    c.vocab_layers.audit('v1', kinds=KINDS)
    c.vocab_layers.audit_page('v1', kinds=KINDS)
    c.audit.list(kinds=KINDS)
    c.audit.list_page(kinds='review,guess-adoption')
    for _ in c.audit.iter_pages(kinds=KINDS):
        pass
    assert len(sent) == 11
    for path, q in sent:
        assert q.get('kinds') == 'review,guess-adoption', path


def test_no_kinds_or_an_empty_list_sends_none():
    c = PlaidClient('http://x', 'tok')
    sent = _stub(c)
    c.documents.audit('d1')
    c.projects.audit_page('p1', kinds=[])
    for path, q in sent:
        assert 'kinds' not in q, path
