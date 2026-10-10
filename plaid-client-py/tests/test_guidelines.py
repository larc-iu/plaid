"""The guidelines resource: a project's annotation manual. What each method
sends (an omitted field left out rather than sent as None, ``include_bodies``
as the kebab-case query) is in the shared request table
(``test_requests.py``). Here: a write queues on a batch rather than going over
the wire beside it."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import http
from plaid_client.client import PlaidClient


def test_a_write_queues_on_a_batch_and_a_read_still_goes_over_the_wire(monkeypatch):
    # The pagination helpers call http.make_request directly rather than the
    # client's own _request, so the module function is what gets stubbed.
    calls = []

    def fake(client, method, path, **kwargs):
        calls.append((method, path))
        return {'entries': [], 'next_cursor': None}

    monkeypatch.setattr(http, 'make_request', fake)
    batch = PlaidClient('http://example.test', 'tok').batch()
    # A guideline write is ordinary project data, so it queues with no flag.
    assert batch.guidelines.create('p1', 'T') == {'batched': True}
    assert len(batch.operations) == 1
    assert batch.operations[0]['path'] == '/api/v1/projects/p1/guidelines'

    batch.guidelines.list('p1')
    # The read was answered from the wire, not queued.
    assert len(calls) == 1
    assert len(batch.operations) == 1
