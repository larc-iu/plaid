"""Coverage guard: EVERY write method (POST/PUT/PATCH/DELETE) on the audited
resource bundles must accept an ``audit_message`` keyword and thread it into the
request URL as ``?audit-message=``. A method is a write by the verb it sends,
found by calling it against a stubbed session, not by its signature, so a new
write method added without the param fails this test. The twin of the JS
``auditMessageCoverage.test.js``.
"""

import inspect
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.client import PlaidClient
from plaid_client.testing import recording_session

WRITE = {'POST', 'PUT', 'PATCH', 'DELETE'}
SENT = 'COVPROBE'

# Bundles whose writes core does not audit: comments, user data, admin and
# auth, events and messages (the services' real-time routes), operation
# groups, and the reads.
UNAUDITED = {'admin', 'audit', 'auth', 'comments', 'events', 'messages', 'operation_groups',
             'server', 'user_data'}
# Reads that travel as a POST take no audit message.
READ_POSTS = {
    'token_layers.check_constraints', 'span_layers.check_constraints',
    'relation_layers.check_constraints', 'token_layers.count_matching', 'users.avatar_token',
}


def test_every_write_method_threads_audit_message():
    client = PlaidClient('http://x', 'tok')
    client.session = recording_session()
    last = {}
    checked = []

    def call(method, **kw):
        sig = inspect.signature(method)
        required = [p for p in sig.parameters.values()
                    if p.default is p.empty
                    and p.kind in (p.POSITIONAL_OR_KEYWORD, p.POSITIONAL_ONLY)
                    and p.name != 'self']
        last.clear()
        sent = len(client.session.sent)
        try:
            method(*(['x'] * len(required)), **kw)
        except Exception:
            return None
        if len(client.session.sent) > sent:
            last.update(client.session.sent[-1])
        return last.get('method')

    def probe(label, method):
        if call(method) not in WRITE:
            return  # a read, or a call the stub cannot answer
        checked.append(label)
        assert 'audit_message' in inspect.signature(method).parameters, \
            f'{label} is a write and takes no audit_message'
        call(method, audit_message=SENT)
        assert 'audit-message=' + SENT in last.get('url', ''), \
            f"{label} ({last.get('method')}) did not thread audit_message: {last.get('url')}"

    for name, res in vars(client).items():
        if type(res).__name__.endswith('Resource') and name not in UNAUDITED:
            for mname, fn in inspect.getmembers(res, inspect.ismethod):
                label = f'{name}.{mname}'
                if not mname.startswith('_') and label not in READ_POSTS:
                    probe(label, fn)
    # ``query`` is a read that travels as a POST, so it takes no audit message.

    assert len(checked) >= 105, f'expected ~109 write methods, only checked {len(checked)}'
