"""A message payload is opaque application data, like ``metadata`` and
``config``: its keys must reach every listener exactly as the sender wrote
them, regardless of which language client is reading. Only the envelope around
it is API surface subject to snake_case recasing.

See the manual's Real-time Messaging > Event Reference.

Run with::

    cd plaid-client-py && python -m pytest tests/ -q
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import PlaidClient
from plaid_client.sse import event_payload


PAYLOAD = {
    'case-marker': 'ERG',
    'camelCaseKey': 1,
    'snake_case_key': 2,
    'nested': {'another-key': [1, {'deep-key': 'v'}]},
}


def test_send_message_puts_the_payload_on_the_wire_verbatim():
    # Batch mode captures the fully prepared request body without any network.
    c = PlaidClient('http://localhost:0', 'dummy-token')
    c.begin_batch()
    c.messages.send_message('11111111-2222-3333-4444-555555555555', PAYLOAD)
    ops = list(c.batch_operations)
    c.abort_batch()

    assert len(ops) == 1
    assert ops[0]['method'] == 'POST'
    assert ops[0]['body'] == {'body': PAYLOAD}


def test_message_event_hands_the_payload_to_the_callback_verbatim():
    wire = {
        'type': 'message',
        'id': 'm1',
        'project': 'p1',
        'user': 'u@example.com',
        'time': '2025-07-09T20:14:36.168Z',
        'data': PAYLOAD,
    }
    seen = event_payload('message', wire)
    assert seen['data'] == PAYLOAD
    # The envelope still gets the usual treatment.
    assert seen['user'] == 'u@example.com'
    assert seen['type'] == 'message'


def test_audit_log_event_is_transformed_normally():
    wire = {
        'type': 'audit-log',
        'id': 'a1',
        'projects': ['p1'],
        'documents': ['d1'],
        'user': 'u@example.com',
        'time': '2025-07-09T20:27:59.616Z',
        'ops': [{'id': 'a1', 'type': 'document:update', 'project': 'p1',
                 'document': 'd1', 'description': 'x'}],
    }
    seen = event_payload('audit-log', wire)
    assert len(seen['ops']) == 1
    assert seen['ops'][0]['type'] == 'document:update'
    assert seen['documents'][0] == 'd1'
