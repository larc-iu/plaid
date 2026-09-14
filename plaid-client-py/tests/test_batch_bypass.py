"""Coverage guard for the batch-mode classification (see the note at the top of
plaid_client/http.py).

``client.batched()`` sets ONE flag on the whole client, so a call made while it
is open is queued no matter which code made it. A client is shared by an editor,
an importer and the app's chrome at once, and four separate reads were found
queued into other people's batches before the rule was written down: the query
endpoint, the server info probe, service discovery, and the document page the
``@`` list reads. A queued read answers ``{'batched': True}`` instead of data,
takes a slot in the batch's results that shifts every positional read after it,
and server-side runs against the batch's transaction connection, where
``/query`` 500s and rolls back every write.

So: no read is ever queued, and neither is an out-of-band signal. The first test
finds every method on the client by reflection, calls it with a batch open, and
compares the reads that answered from the wire against READS below. The second
names the signals, which are shaped like writes and cannot be found by their
verb.
"""

import inspect
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.client import PlaidClient
from plaid_client.http import PlaidAPIError
from plaid_client.services import (cancel_service_request, discover_services,
                                   _report_event)

# Every read the client exposes, as ``resource.method``. ADD A NEW READ HERE:
# the test calls every method by reflection and compares what actually went over
# the wire against this list, so a read missing from it fails exactly as loudly
# as one that joined the batch.
READS = [
    'admin.locks',
    'admin.log_file',
    'admin.logs',
    'admin.rate_limits',
    'admin.server',
    'admin.user_data',
    'admin.user_data_page',
    'api_tokens.iter_pages',
    'api_tokens.list',
    'api_tokens.list_page',
    'audit.iter_pages',
    'audit.list',
    'audit.list_page',
    'audit.tally',
    'comments.counts',
    'comments.counts_in_vocab',
    'comments.get',
    'comments.iter_pages',
    'comments.list',
    'comments.list_in_vocab',
    'comments.list_in_vocab_page',
    'comments.list_page',
    'documents.audit',
    'documents.audit_page',
    'documents.check_lock',
    'documents.get',
    'documents.get_media',
    'invites.iter_pages',
    'invites.list',
    'invites.list_page',
    'messages.discover_services',
    'operation_groups.get',
    'projects.audit',
    'projects.audit_page',
    'projects.get',
    'projects.iter_documents',
    'projects.iter_pages',
    'projects.list',
    'projects.list_documents',
    'projects.list_documents_page',
    'projects.list_page',
    'projects.my_last_edits',
    'relation_layers.get',
    'relations.get',
    'server.health',
    'server.info',
    'span_layers.get',
    'spans.get',
    'text_layers.get',
    'texts.get',
    'token_layers.get',
    'tokens.get',
    'user_data.get',
    'user_data.iter_pages',
    'user_data.list',
    'user_data.list_page',
    'users.audit',
    'users.audit_page',
    'users.get',
    'users.get_avatar',
    'users.iter_pages',
    'users.list',
    'users.list_page',
    'vocab_items.get',
    'vocab_layers.get',
    'vocab_layers.iter_pages',
    'vocab_layers.list',
    'vocab_layers.list_page',
    'vocab_links.get',
]

# The only methods the probe skips. Each opens a stream or runs a loop rather
# than making one request, so calling it with fake arguments would hang or run
# past the request layer. Everything else on the client is probed.
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


def test_every_read_goes_over_the_wire_and_reads_names_them_all():
    client = PlaidClient('http://x', 'tok')
    sent = _stub_session(client)
    client.begin_batch()

    over_the_wire = set()
    queued_reads = []

    def probe(label, fn):
        sent_before = len(sent)
        queued_before = len(client.batch_operations)
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
        for op in client.batch_operations[queued_before:]:
            if op['method'] == 'GET':
                queued_reads.append(f"{label} -> {op['path']}")
        for req in sent[sent_before:]:
            if req['method'] == 'GET':
                over_the_wire.add(label)

    try:
        # Reflection, so a whole new resource is probed the day it is added
        # rather than the day someone remembers to name it here.
        for name, res in list(vars(client).items()):
            if not type(res).__name__.endswith('Resource'):
                continue
            for mname, fn in inspect.getmembers(res, inspect.ismethod):
                label = f'{name}.{mname}'
                if mname.startswith('_') or label in _STREAM_METHODS:
                    continue
                probe(label, fn)
        probe('query', client.query)
    finally:
        client.abort_batch()

    assert not queued_reads, (
        'these reads joined the batch instead of going over the wire:\n  '
        + '\n  '.join(queued_reads))

    observed = sorted(over_the_wire)
    unlisted = [n for n in observed if n not in READS]
    assert not unlisted, (
        'these reads are missing from READS at the top of this file. Add every '
        'new read to it:\n  ' + '\n  '.join(unlisted))
    # ``server.limits`` is deliberately absent: it returns ``server.info()``,
    # which memoizes its one request, so by the time it is probed there is
    # nothing left to send.
    missing = [n for n in READS if n not in observed]
    assert not missing, (
        'READS names these, but they sent no GET with a batch open:\n  '
        + '\n  '.join(missing))


def test_a_read_or_a_signal_shaped_like_a_write_goes_over_the_wire():
    client = PlaidClient('http://x', 'tok')
    sent = _stub_session(client)
    client.begin_batch()

    # None of these is a GET, so the discovery test above cannot see them. The
    # first is a read that travels as a POST. The rest are out-of-band signals:
    # shaped like a write, carrying no project data, and worth having only if
    # they happen now. Queued, each happens when the batch submits, or never if
    # the batch aborts, while its caller reads success.
    signals = [
        # A query runs against the pool; inside the batch's transaction it 500s
        # and rolls back every write the batch had queued.
        ('run a query', lambda: client.query({'find': ['?t'], 'where': []})),
        # The assistant's Stop button, pressed during an import.
        ('cancel a service request', lambda: cancel_service_request(client, 'p1', 'r1')),
        # A service reporting from inside its own batch of writes.
        ('report a service request event',
         lambda: _report_event(client, 'p1', 'r1', {'status': 'progress'})),
        # Discovery, which the availability probe polls.
        ('discover services', lambda: discover_services(client, 'p1')),
        # A lock taken at submit time is taken after every write it guards.
        ('acquire a document lock', lambda: client.documents.acquire_lock('d1')),
        ('release a document lock', lambda: client.documents.release_lock('d1')),
        # Admin actions on the server itself, none of them project data.
        ('take a backup', lambda: client.admin.backup()),
        ('drop a stranded lock', lambda: client.admin.release_lock('d1')),
        ('clear rate limits', lambda: client.admin.clear_rate_limits()),
    ]

    try:
        for label, fn in signals:
            before = len(sent)
            queued_before = len(client.batch_operations)
            fn()
            assert len(sent) == before + 1, f'{label} did not go over the wire'
            assert len(client.batch_operations) == queued_before, \
                f'{label} was queued into the batch'
    finally:
        client.abort_batch()


def test_a_write_of_project_data_still_queues():
    client = PlaidClient('http://x', 'tok')
    sent = _stub_session(client)
    client.begin_batch()

    client.tokens.create('tl1', 't1', 0, 5)
    client.spans.update('s1', 'NOUN')
    client.relations.delete('r1')
    # Blobless DELETEs beside a multipart upload. The upload cannot be batched;
    # these carry nothing the transport cannot express.
    client.documents.delete_media('d1')
    client.users.delete_avatar('u1')

    assert sent == [], 'a queued write must not reach the wire'
    assert [op['method'] for op in client.batch_operations] == \
        ['POST', 'PATCH', 'DELETE', 'DELETE', 'DELETE']
    client.abort_batch()


def test_only_the_calls_the_batch_transport_cannot_carry_refuse_a_batch():
    client = PlaidClient('http://x', 'tok')
    sent = _stub_session(client)
    client.begin_batch()

    # A batch inside a batch, the two multipart uploads, and the user-data
    # store. Nothing else may raise here: ``no_batch`` on a read turns a
    # swallowed read into a thrown one, and on a write it refuses work a batch
    # could have done.
    refuse = [
        ('submit a batch', lambda: client.batch.submit([])),
        ('upload media', lambda: client.documents.upload_media('d1', b'f')),
        ('upload an avatar', lambda: client.users.set_avatar('u1', b'f')),
        ('write user data', lambda: client.user_data.put('u1', 'k', 1)),
        ('delete user data', lambda: client.user_data.delete('u1', 'k')),
    ]

    try:
        for label, fn in refuse:
            with pytest.raises(PlaidAPIError, match='cannot be used in batch mode'):
                fn()
        assert sent == [], 'a refused call must not reach the wire'
        assert client.batch_operations == []
    finally:
        client.abort_batch()
