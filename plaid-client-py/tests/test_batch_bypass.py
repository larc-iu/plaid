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
discovers every method on the client and proves it. The second names the
signals, which are shaped like writes and cannot be found by their verb.
"""

import inspect
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.client import PlaidClient
from plaid_client.services import (cancel_service_request, discover_services,
                                   _report_event)


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


# Resources carrying the REST surface. ``messages`` is covered by the
# out-of-band test below (its methods open streams rather than make plain
# requests).
_SKIP_RESOURCES = {'messages'}
# Methods whose probe would run past the request layer into real work.
_SKIP_METHODS = {'locked', 'avatar_url'}


def test_no_read_is_ever_queued_into_an_open_batch():
    client = PlaidClient('http://x', 'tok')
    sent = _stub_session(client)
    client.begin_batch()

    over_the_wire = []
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
                over_the_wire.append(label)

    try:
        for name, res in list(vars(client).items()):
            if not type(res).__name__.endswith('Resource'):
                continue
            if name in _SKIP_RESOURCES:
                continue
            for mname, fn in inspect.getmembers(res, inspect.ismethod):
                if mname.startswith('_') or mname in _SKIP_METHODS:
                    continue
                probe(f'{name}.{mname}', fn)
        probe('query', client.query)
    finally:
        client.abort_batch()

    assert not queued_reads, (
        'these reads joined the batch instead of going over the wire:\n  '
        + '\n  '.join(queued_reads))
    # The count is the table: every read method on the client answered from the
    # wire with a batch open. It only ever goes up.
    assert len(over_the_wire) >= 60, (
        f'expected every read (66 of them) to go over the wire, saw '
        f'{len(over_the_wire)}: {over_the_wire}')


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

    assert sent == [], 'a queued write must not reach the wire'
    assert [op['method'] for op in client.batch_operations] == \
        ['POST', 'PATCH', 'DELETE']
    client.abort_batch()
