"""documents.media_link asks core for a link an audio or video element can
stream from without an Authorization header (mediaLink in the JS client). The
answer is recased, its URL resolved against the client's base URL, and the
call is a read that travels as a POST: no Idempotency-Key, and on a batch it
goes over the wire."""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.client import PlaidClient
from plaid_client.http import PlaidAPIError

LINK = {
    'url': '/api/v1/documents/d1/media?v=1-10&media-token=abc.def.ghi',
    'expires-at': '2026-10-09T18:00:00.000000000Z',
}


class _Resp:
    def __init__(self, status, body):
        self.status_code = status
        self.ok = status < 300
        self.reason = ''
        self.headers = {'content-type': 'application/json'}
        self.content = json.dumps(body).encode()
        self.text = json.dumps(body)
        self._body = body

    def json(self):
        return self._body


def _answer(client, status, body):
    seen = []

    def request(**kw):
        seen.append(kw)
        return _Resp(status, body)

    client.session.request = request
    return seen


def test_media_link_answers_an_absolute_url_and_expires_at():
    client = PlaidClient('http://core:8085/', 'tok')
    seen = _answer(client, 200, LINK)
    link = client.documents.media_link('d1')
    assert link == {
        'url': 'http://core:8085/api/v1/documents/d1/media?v=1-10&media-token=abc.def.ghi',
        'expires_at': '2026-10-09T18:00:00.000000000Z',
    }
    assert len(seen) == 1
    assert seen[0]['method'] == 'POST'
    assert seen[0]['url'] == 'http://core:8085/api/v1/documents/d1/media/link'
    headers = {k.lower(): v for k, v in (seen[0].get('headers') or {}).items()}
    assert 'idempotency-key' not in headers


def test_on_a_batch_media_link_goes_over_the_wire_and_queues_nothing():
    client = PlaidClient('http://core', 'tok')
    _answer(client, 200, LINK)
    b = client.batch()
    try:
        link = b.documents.media_link('d1')
        assert link['url'] == 'http://core' + LINK['url']
        assert b.operations == []
    finally:
        b.abort()


def test_a_document_with_no_recording_raises_with_status_404():
    client = PlaidClient('http://core', 'tok')
    _answer(client, 404, {'error': 'No media file found'})
    with pytest.raises(PlaidAPIError) as e:
        client.documents.media_link('d1')
    assert e.value.status == 404
