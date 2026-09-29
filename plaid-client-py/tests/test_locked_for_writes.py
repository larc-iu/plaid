"""``locked_for_writes``: a service's writes carry the version the document had
once the lock was held (strict mode).

The bug this guards (conc-2026-09-29, V2 S1): a service batch the client gave
up on (a timeout, a lost answer) could still land after the run had released
the lock and someone had edited the text, and it stored word tokens that cut
the new words in half. Stamped with the version read under the lock, such a
batch is refused with a 409.
"""

import json
import os
import sys
from urllib.parse import parse_qs, urlparse

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.client import PlaidClient  # noqa: E402
from plaid_client.service import locked_for_writes  # noqa: E402
from plaid_client.testing import FakeClient  # noqa: E402


class _Resp:
    ok = True
    status_code = 200
    reason = 'OK'

    def __init__(self, body, headers=None):
        self._body = body
        self.headers = {'content-type': 'application/json', **(headers or {})}
        self.text = json.dumps(body)
        self.content = self.text.encode()

    def json(self):
        return self._body


def _server(version):
    """A stub session that holds the lock and answers a document read with
    ``version``, a write by moving the version on. Returns the requests sent."""
    sent = []
    state = {'version': version}

    class _Session:
        def request(self, **kw):
            method, url = kw.get('method'), kw.get('url', '')
            sent.append({'method': method, 'url': url})
            path = urlparse(url).path
            if path.endswith('/lock'):
                return _Resp({'lock-id': 'L1'} if method == 'POST' else {})
            if method == 'GET':
                return _Resp({'document/id': 'd1', 'document/version': state['version']})
            state['version'] += 1
            return _Resp({}, {'X-Document-Versions': json.dumps({'d1': state['version']})})

        def post(self, url, **kw):
            return self.request(method='POST', url=url, **kw)

        def close(self):
            pass

    return _Session(), sent


def _version_of(url):
    values = parse_qs(urlparse(url).query).get('document-version')
    return values[0] if values else None


def test_every_write_in_the_block_carries_the_version_read_under_the_lock():
    client = PlaidClient('http://x', 'tok')
    client.session, sent = _server(7)
    client.document_versions['d1'] = 3   # an older read must not be what is claimed
    with locked_for_writes(client, 'd1'):
        client.spans.update('s1', 'NOUN')
        client.spans.update('s2', 'VERB')
    writes = [r for r in sent if r['method'] != 'GET' and not urlparse(r['url']).path.endswith('/lock')]
    assert [_version_of(r['url']) for r in writes] == ['7', '8']
    # The read came after the lock was taken, not before.
    kinds = [(r['method'], urlparse(r['url']).path.endswith('/lock')) for r in sent]
    assert kinds.index(('POST', True)) < kinds.index(('GET', False))
    # And strict mode ends with the block.
    assert client.strict_mode_document_id is None


def test_a_document_that_moved_since_the_run_read_it_is_refused_before_any_write():
    client = PlaidClient('http://x', 'tok')
    client.session, sent = _server(9)
    with pytest.raises(ValueError, match='changed while this run was working'):
        with locked_for_writes(client, 'd1', 8):
            client.spans.update('s1', 'NOUN')
    assert [r['method'] for r in sent if not urlparse(r['url']).path.endswith('/lock')] == ['GET']
    assert client.strict_mode_document_id is None


def test_strict_mode_the_caller_had_is_put_back():
    client = PlaidClient('http://x', 'tok')
    client.session, _ = _server(7)
    client.enter_strict_mode('other')
    with locked_for_writes(client, 'd1'):
        assert client.strict_mode_document_id == 'd1'
    assert client.strict_mode_document_id == 'other'


def test_the_fake_client_records_the_stamp_each_write_carried():
    client = FakeClient([{'id': 'd1', 'version': 4}])
    with locked_for_writes(client, 'd1', 4):
        with client.batched() as b:
            b.tokens.bulk_delete(['t1'])
        client.spans.update('s1', 'NOUN')
    assert client.stamps == [('tokens.bulk_delete', 'd1', 4), ('spans.update', 'd1', 4)]
    assert client.strict_mode_document_id is None


def test_every_service_that_locks_a_document_writes_in_strict_mode():
    """Every path in: a service or workflow that takes the lock itself would
    write unstamped, and a late batch of its own could land over an edit."""
    import pathlib
    repo = pathlib.Path(__file__).resolve().parents[2]
    sources = [*repo.glob('plaid-*/services/*.py'),
               *(repo / 'plaid-client-py/src/plaid_client/workflows').rglob('*.py')]
    sources = [p for p in sources if 'plaid-core' not in p.parts]
    assert len(sources) > 10
    bare = [str(p.relative_to(repo)) for p in sources if 'documents.locked(' in p.read_text()]
    assert bare == [], 'take the lock through plaid_client.service.locked_for_writes'
