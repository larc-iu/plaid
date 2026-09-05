"""A media upload can report its progress, as in the JS client.

``requests`` cannot say how many bytes of a ``files=`` upload have gone up,
so with ``on_progress`` the multipart body is encoded up front (by requests'
own encoder, so it is the same body) and streamed from memory through a
file-like object that reports every read. Everything after the wire is the
same as for the plain path.
"""

import io

from plaid_client.client import PlaidClient


class FakeResponse:
    ok = True
    status_code = 200
    headers = {'content-type': 'application/json'}
    text = '{"ok": true}'

    def json(self):
        return {'ok': True}


class FakeSession:
    """Reads the body the way http.client does: in blocks."""

    def __init__(self, block=7):
        self.block = block
        self.calls = []

    def request(self, **kwargs):
        body = kwargs.get('data')
        sent = b''
        if hasattr(body, 'read'):
            while True:
                chunk = body.read(self.block)
                if not chunk:
                    break
                sent += chunk
        self.calls.append({'kwargs': kwargs, 'sent': sent})
        return FakeResponse()


def make_client():
    client = PlaidClient('http://plaid.test', 'tok')
    client.session = FakeSession()
    return client


def test_upload_with_on_progress_streams_the_same_multipart_body_and_reports_bytes():
    client = make_client()
    seen = []
    result = client.documents.upload_media(
        'doc-1', ('talk.wav', io.BytesIO(b'RIFF' * 10), 'audio/wav'),
        on_progress=seen.append)

    assert result == {'ok': True}
    call = client.session.calls[0]
    kwargs = call['kwargs']
    assert kwargs['method'] == 'PUT'
    assert kwargs['url'].endswith('/api/v1/documents/doc-1/media')
    assert kwargs['headers']['Authorization'] == 'Bearer tok'
    assert kwargs['headers']['Content-Type'].startswith('multipart/form-data; boundary=')
    assert 'files' not in kwargs

    # The body is a real multipart body carrying the file, with a length so
    # requests sends Content-Length rather than chunking.
    assert b'filename="talk.wav"' in call['sent']
    assert b'RIFF' * 10 in call['sent']
    assert len(kwargs['data']) == len(call['sent'])

    # Progress: monotonic, ending exactly at the body's size.
    assert seen, 'the callback ran'
    loaded = [p['loaded'] for p in seen]
    assert loaded == sorted(loaded)
    assert loaded[-1] == len(call['sent'])
    assert all(p['total'] == len(call['sent']) for p in seen)
    assert len(seen) > 1, 'reported per block, not once at the end'


def test_upload_without_on_progress_still_uses_requests_files():
    client = make_client()
    client.documents.upload_media('doc-1', ('talk.wav', io.BytesIO(b'x'), 'audio/wav'))
    kwargs = client.session.calls[0]['kwargs']
    assert kwargs['files'] == {'file': ('talk.wav', kwargs['files']['file'][1], 'audio/wav')}
    assert 'data' not in kwargs
    assert 'Content-Type' not in kwargs['headers']


def test_a_retried_upload_starts_the_body_over(monkeypatch):
    # A 503 busy refusal is retried; the second attempt must send the whole
    # body again, not the empty tail of a body already read once.
    import plaid_client.http as http
    monkeypatch.setattr(http.time, 'sleep', lambda s: None)
    client = make_client()
    attempts = []

    class BusyOnce(FakeSession):
        def request(self, **kwargs):
            resp = super().request(**kwargs)
            attempts.append(self.calls[-1]['sent'])
            if len(attempts) == 1:
                busy = FakeResponse()
                busy.ok = False
                busy.status_code = 503
                busy.text = '{"error": "Database busy"}'
                busy.json = lambda: {'error': 'Database busy'}
                busy.reason = 'Service Unavailable'
                return busy
            return resp

    client.session = BusyOnce()
    client.documents.upload_media(
        'doc-1', ('talk.wav', io.BytesIO(b'abc'), 'audio/wav'), on_progress=lambda p: None)
    assert len(attempts) == 2
    assert attempts[0] == attempts[1]
    assert b'abc' in attempts[1]
