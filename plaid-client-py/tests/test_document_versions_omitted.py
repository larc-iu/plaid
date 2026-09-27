"""Past fifty documents the server leaves X-Document-Versions out of a write's
response and sends X-Document-Versions-Omitted (the number left out). The
header grew about 43 bytes a document with no limit, and http.client refuses a
header line past 64 KB after the write has committed. A client that sees the
marker forgets every version it held, since any may be one of those left out,
and learns its strict-mode document's again before it writes there."""

import json
import os
import sys
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.client import PlaidClient
from plaid_client.http import extract_document_versions


class _Resp:
    ok = True
    status_code = 200
    reason = 'OK'

    def __init__(self, body, headers):
        self._body = body
        self.headers = {'content-type': 'application/json', **headers}
        self.text = json.dumps(body)
        self.content = self.text.encode()

    def json(self):
        return self._body


def _stub_server(client, doc_version=42, fail_read=False):
    """A bulk update answers with the marker, a document read with the
    document's version, anything else with a plain 200."""
    calls = []

    class _Session:
        def request(self, **kw):
            url = urlparse(kw['url'])
            method = kw['method']
            version = parse_qs(url.query).get('document-version', [None])[0]
            calls.append((method, url.path, version))
            if method == 'GET' and fail_read:
                raise ConnectionError('fetch failed')
            if url.path.endswith('/bulk'):
                return _Resp({'count': 60}, {'X-Document-Versions-Omitted': '60'})
            if method == 'GET' and url.path.startswith('/api/v1/documents/'):
                return _Resp({'document/id': url.path.rsplit('/', 1)[1],
                              'document/version': doc_version}, {})
            return _Resp({}, {})

    client.session = _Session()
    return calls


def test_the_marker_forgets_every_version_the_client_held():
    client = PlaidClient('http://plaid.test', 'tok')
    client.document_versions.update({'d1': 3, 'd2': 9})
    extract_document_versions(client, {'X-Document-Versions-Omitted': '120'})
    assert client.document_versions == {}
    assert client.document_versions_omitted is True


def test_a_response_without_the_marker_keeps_the_versions_and_merges_the_list():
    client = PlaidClient('http://plaid.test', 'tok')
    client.document_versions.update({'d1': 3})
    extract_document_versions(client, {'X-Document-Versions': json.dumps({'d2': 5})})
    assert client.document_versions == {'d1': 3, 'd2': 5}
    assert not getattr(client, 'document_versions_omitted', False)


def test_a_strict_client_reads_its_documents_version_right_after_the_marker_and_stamps_it():
    client = PlaidClient('http://plaid.test', 'tok')
    client.enter_strict_mode('d1')
    client.document_versions['d1'] = 7
    calls = _stub_server(client, doc_version=42)
    client.spans.bulk_update([{'id': 's1', 'value': 'X'}])
    assert client.document_versions['d1'] == 42
    client.spans.update('s1', 'Y')
    assert calls == [
        ('PATCH', '/api/v1/spans/bulk', '7'),
        ('GET', '/api/v1/documents/d1', None),
        ('PATCH', '/api/v1/spans/s1', '42'),
    ]


def test_when_that_read_fails_the_write_still_succeeds_and_the_next_strict_write_asks_again():
    client = PlaidClient('http://plaid.test', 'tok')
    client.enter_strict_mode('d1')
    client.document_versions['d1'] = 7
    _stub_server(client, fail_read=True)
    assert client.spans.bulk_update([{'id': 's1', 'value': 'X'}]) == {'count': 60}
    assert 'd1' not in client.document_versions
    calls = _stub_server(client, doc_version=43)
    client.spans.update('s1', 'Y')
    assert calls == [
        ('GET', '/api/v1/documents/d1', None),
        ('PATCH', '/api/v1/spans/s1', '43'),
    ]


def test_a_client_not_in_strict_mode_reads_nothing_extra():
    client = PlaidClient('http://plaid.test', 'tok')
    client.document_versions['d1'] = 7
    calls = _stub_server(client)
    client.spans.bulk_update([{'id': 's1', 'value': 'X'}])
    client.spans.update('s1', 'Y')
    assert [c[0] for c in calls] == ['PATCH', 'PATCH']
    assert client.document_versions == {}


def test_a_write_made_while_that_read_is_in_flight_waits_for_it_and_goes_out_stamped():
    import threading
    client = PlaidClient('http://plaid.test', 'tok')
    client.enter_strict_mode('d1')
    client.document_versions['d1'] = 7
    calls = _stub_server(client, doc_version=42)
    stub = client.session
    read_started = threading.Event()
    release_read = threading.Event()

    class _Held:
        def request(self, **kw):
            if kw['method'] == 'GET':
                read_started.set()
                release_read.wait(5)
            return stub.request(**kw)

    client.session = _Held()
    first = threading.Thread(target=lambda: client.spans.bulk_update([{'id': 's1', 'value': 'X'}]))
    first.start()
    assert read_started.wait(5)
    second = threading.Thread(target=lambda: client.spans.update('s1', 'Y'))
    second.start()
    second.join(0.2)
    release_read.set()
    first.join(5)
    second.join(5)
    assert calls == [
        ('PATCH', '/api/v1/spans/bulk', '7'),
        ('GET', '/api/v1/documents/d1', None),
        ('PATCH', '/api/v1/spans/s1', '42'),
    ]
