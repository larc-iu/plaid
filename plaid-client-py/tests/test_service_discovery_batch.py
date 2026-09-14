"""Discovery reads the registry over the wire even while a batch is open."""
from types import SimpleNamespace

from plaid_client.services import discover_services


class _Messages:
    def __init__(self):
        self.calls = []

    def _request(self, method, path, **kwargs):
        self.calls.append((method, path, kwargs))
        return [{'service_id': 'igt:assist:x', 'online': True}]


def test_discovery_bypasses_an_open_batch():
    # The JS assistant probe polls after a mount and landed inside long
    # batches, where a queued read answers a batch marker instead of a list.
    # The Python twin takes the same flag so a service polling from inside a
    # `client.batched()` block reads the registry rather than joining the batch.
    messages = _Messages()
    client = SimpleNamespace(messages=messages, is_batching=True)
    found = discover_services(client, 'p1')
    assert found == [{'service_id': 'igt:assist:x', 'online': True}]
    (method, path, kwargs), = messages.calls
    assert (method, path) == ('GET', '/api/v1/projects/p1/services')
    assert kwargs.get('bypass_batch') is True
