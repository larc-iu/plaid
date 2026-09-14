"""What a batch carries, and what goes over the wire regardless (see the note
at the top of plaid_client/http.py).

A batch is a view of the client. A write of project data made on it queues; a
read, or a signal that carries no project data, goes over the wire even when
made on the batch; and a call made on the CLIENT is never touched by a batch,
however many are open. The last is the point: a client is shared by an editor,
an importer and a keep-alive at once, and under the old one-flag-on-the-client
model reads and a lock beat were found queued into other people's batches.
"""

import inspect
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.client import PlaidClient
from plaid_client.http import PlaidAPIError
from plaid_client.services import (cancel_service_request, discard_service,
                                   discover_services, _report_event)

# The only methods the probe skips. Each opens a stream or runs a loop rather
# than making one request, so calling it with fake arguments would hang or run
# past the request layer. Everything else on the batch is probed.
_STREAM_METHODS = {
    'messages.listen',
    'messages.serve',
    'messages.request_service',
    'messages.attach_service_request',
}


class _Resp:
    """Answers anything with an empty paginated envelope, so a probe of a read
    method runs to completion whatever shape it expects."""

    ok = True
    status_code = 200
    headers = {}
    text = '{}'
    content = b'{}'
    reason = 'OK'

    def json(self):
        return {'entries': [], 'next-cursor': None}


def _stub_session(client):
    """Replace the client's HTTP session; return the list its requests land in."""
    sent = []

    class _Session:
        def request(self, **kw):
            sent.append({'method': kw.get('method'), 'url': kw.get('url', '')})
            return _Resp()

        def close(self):
            pass

    client.session = _Session()
    return sent


def test_a_write_made_on_the_client_goes_over_the_wire_while_a_batch_is_open():
    client = PlaidClient('http://x', 'tok')
    sent = _stub_session(client)
    b = client.batch()
    b.tokens.create('tl1', 't1', 0, 5)
    # A keep-alive or an editor writing on the shared client while the
    # importer's batch is open.
    client.spans.update('s1', 'NOUN')
    b.abort()
    assert len(sent) == 1
    assert sent[0]['url'].endswith('/api/v1/spans/s1')


def test_every_read_made_on_a_batch_goes_over_the_wire_and_none_queues():
    client = PlaidClient('http://x', 'tok')
    sent = _stub_session(client)
    b = client.batch()

    over_the_wire = 0
    queued_reads = []

    def probe(label, fn):
        nonlocal over_the_wire
        sent_before = len(sent)
        queued_before = len(b.operations)
        sig = inspect.signature(fn)
        required = [p for p in sig.parameters.values()
                    if p.default is p.empty
                    and p.kind in (p.POSITIONAL_OR_KEYWORD, p.POSITIONAL_ONLY)]
        try:
            out = fn(*(['x'] * len(required)))
            if inspect.isgenerator(out):
                list(out)
        except Exception:
            # A probe with fake arguments may raise; what it did with the batch
            # before raising is still the thing under test.
            pass
        for op in b.operations[queued_before:]:
            if op['method'] == 'GET':
                queued_reads.append(f"{label} -> {op['path']}")
        for req in sent[sent_before:]:
            if req['method'] == 'GET':
                over_the_wire += 1

    try:
        # Reflection over the batch's own resources, so a whole new resource
        # is probed the day it is added.
        for name, res in list(vars(b).items()):
            if not type(res).__name__.endswith('Resource'):
                continue
            for mname, fn in inspect.getmembers(res, inspect.ismethod):
                label = f'{name}.{mname}'
                if mname.startswith('_') or label in _STREAM_METHODS:
                    continue
                probe(label, fn)
        probe('query', b.query)
    finally:
        b.abort()

    assert not queued_reads, (
        'these reads joined the batch:\n  ' + '\n  '.join(queued_reads))
    assert over_the_wire > 40, f'only {over_the_wire} reads went over the wire'


def test_a_read_or_a_signal_shaped_like_a_write_goes_over_the_wire_from_a_batch():
    client = PlaidClient('http://x', 'tok')
    sent = _stub_session(client)
    b = client.batch()

    # None of these is a GET. The first is a read that travels as a POST. The
    # rest are out-of-band signals: shaped like a write, carrying no project
    # data, and worth having only if they happen now. Queued, each would
    # happen when the batch submits, or never if the batch aborts, while its
    # caller read success.
    signals = [
        ('run a query', lambda: b.query({'find': ['?t'], 'where': []})),
        ('cancel a service request', lambda: cancel_service_request(b, 'p1', 'r1')),
        ('report a service request event',
         lambda: _report_event(b, 'p1', 'r1', {'status': 'progress'})),
        ('discover services', lambda: discover_services(b, 'p1')),
        ('forget a service', lambda: discard_service(b, 'p1', 's1')),
        ('acquire a document lock', lambda: b.documents.acquire_lock('d1')),
        ('release a document lock', lambda: b.documents.release_lock('d1')),
        ('take a backup', lambda: b.admin.backup()),
        ('drop a stranded lock', lambda: b.admin.release_lock('d1')),
        ('clear rate limits', lambda: b.admin.clear_rate_limits()),
    ]

    try:
        for label, fn in signals:
            before = len(sent)
            queued_before = len(b.operations)
            fn()
            assert len(sent) == before + 1, f'{label} did not go over the wire'
            assert len(b.operations) == queued_before, \
                f'{label} was queued into the batch'
    finally:
        b.abort()


def test_a_write_of_project_data_queues_on_the_batch_and_answers_a_marker():
    client = PlaidClient('http://x', 'tok')
    sent = _stub_session(client)
    b = client.batch()

    assert b.tokens.create('tl1', 't1', 0, 5) == {'batched': True}
    b.spans.update('s1', 'NOUN')
    b.relations.delete('r1')
    # Blobless DELETEs beside a multipart upload. The upload cannot be batched;
    # these carry nothing the transport cannot express.
    b.documents.delete_media('d1')
    b.users.delete_avatar('u1')

    assert sent == [], 'a queued write must not reach the wire'
    assert [op['method'] for op in b.operations] == \
        ['POST', 'PATCH', 'DELETE', 'DELETE', 'DELETE']
    b.abort()


def test_only_the_calls_the_batch_transport_cannot_carry_refuse_a_batch():
    client = PlaidClient('http://x', 'tok')
    sent = _stub_session(client)
    b = client.batch()

    # The two multipart uploads and the user-data store. Nothing else may
    # raise here: ``no_batch`` on a read turns a read into a thrown one, and
    # on a write it refuses work a batch could have done.
    refuse = [
        ('upload media', lambda: b.documents.upload_media('d1', b'f')),
        ('upload an avatar', lambda: b.users.set_avatar('u1', b'f')),
        ('write user data', lambda: b.user_data.put('u1', 'k', 1)),
        ('delete user data', lambda: b.user_data.delete('u1', 'k')),
    ]

    try:
        for label, fn in refuse:
            with pytest.raises(PlaidAPIError, match='cannot be used in a batch'):
                fn()
        assert sent == [], 'a refused call must not reach the wire'
        assert b.operations == []
    finally:
        b.abort()
