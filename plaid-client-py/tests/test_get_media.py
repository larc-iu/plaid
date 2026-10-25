"""documents.get_media reads a document's recording through the client, so a
reader gets the client's retries and error shape (getMedia in the JS client).
With ``to_path`` the file streams to disk rather than into memory, and
``on_progress`` hears ``{'loaded', 'total'}`` as it arrives. ``timeout``
replaces the client's for this one read."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

import pytest

from plaid_client.client import PlaidClient
from plaid_client.http import PlaidAPIError
from plaid_client.testing import Response, recording_session

CHUNKS = [b'ab', b'cd', b'ef']


def _media(status=200, length=True):
    """The media as core streams it, or core's refusal."""
    if status >= 400:
        return Response(status, {'error': 'Busy'}, reason='Service Unavailable')
    headers = {'content-type': 'audio/x-wav'}
    if length:
        headers['Content-Length'] = str(sum(len(c) for c in CHUNKS))
    return Response(status, headers=headers, chunks=CHUNKS)


def _client(*answers):
    client = PlaidClient('http://x', 'tok')
    session = recording_session(list(answers))
    client.session.request = session.request
    return client, session.sent


def test_get_media_answers_the_bytes():
    client, sent = _client(_media())
    assert client.documents.get_media('d1') == b'abcdef'
    assert sent[0]['url'] == 'http://x/api/v1/documents/d1/media'
    assert sent[0]['headers']['Authorization'] == 'Bearer tok'


def test_get_media_streams_to_a_path_and_says_how_far_in_it_is(tmp_path):
    client, sent = _client(_media())
    heard = []
    target = str(tmp_path / 'media')
    answer = client.documents.get_media('d1', to_path=target, on_progress=heard.append)
    assert answer == target
    with open(target, 'rb') as f:
        assert f.read() == b'abcdef'
    assert sent[0]['stream'] is True
    assert heard == [{'loaded': 2, 'total': 6}, {'loaded': 4, 'total': 6},
                     {'loaded': 6, 'total': 6}]


def test_get_media_reports_progress_into_memory_too_with_no_length():
    client, _ = _client(_media(length=False))
    heard = []
    assert client.documents.get_media('d1', on_progress=heard.append) == b'abcdef'
    assert heard[-1] == {'loaded': 6, 'total': None}


def test_get_media_takes_its_own_timeout():
    client, sent = _client(_media())
    client.documents.get_media('d1', timeout=(15, 60))
    client.documents.get_media('d1')
    assert sent[0]['timeout'] == (15, 60)
    assert sent[1]['timeout'] == client.timeout


def test_get_media_reads_again_when_the_core_is_busy(monkeypatch, tmp_path):
    monkeypatch.setattr('plaid_client.http.time.sleep', lambda s: None)
    client, sent = _client(_media(status=503), _media())
    target = str(tmp_path / 'media')
    assert client.documents.get_media('d1', to_path=target) == target
    assert len(sent) == 2


def test_a_refused_media_read_is_the_clients_error():
    client, _ = _client(_media(status=404))
    with pytest.raises(PlaidAPIError) as caught:
        client.documents.get_media('d1')
    assert caught.value.status == 404


def test_a_connection_lost_partway_is_the_clients_network_error(tmp_path):
    class _Cut(Response):
        def iter_content(self, chunk_size=None):
            yield b'ab'
            raise ConnectionResetError('reset by peer')

    client, _ = _client(_Cut(200, headers={'content-type': 'audio/x-wav'}, chunks=CHUNKS))
    with pytest.raises(PlaidAPIError) as caught:
        client.documents.get_media('d1', to_path=str(tmp_path / 'media'))
    assert caught.value.status == 0
