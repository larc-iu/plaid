"""The guidelines resource: a project's annotation manual.

The mirror of ``plaid-client-js/test/guidelines.test.js``, test for test. Three
things are easy to get wrong and expensive to notice later: an omitted field
must be OMITTED rather than sent as null (a PATCH sending ``title=None`` would
blank the handle the assistant addresses the guideline by), ``include_bodies``
must reach the wire as the kebab-case query the server reads, and a write must
queue on a batch rather than going over the wire beside it.

Run with::

    cd plaid-client-py && python -m pytest tests/ -q

The tests also run with no dependencies via::

    python tests/test_guidelines.py
"""

import os
import sys

# Make ``plaid_client`` importable when running this file directly.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import http
from plaid_client.client import PlaidClient


def _recording_client():
    """A client whose requests are recorded rather than sent."""
    client = PlaidClient('http://example.test', 'tok')
    client.calls = []

    def fake_request(method, path, **kwargs):
        client.calls.append({'method': method, 'path': path, **kwargs})
        return {'entries': [], 'next_cursor': None}

    client._request = fake_request
    return client


def test_create_sends_only_the_fields_it_was_given():
    client = _recording_client()
    client.guidelines.create('p1', 'Glossing', 'How this project glosses.')

    call = client.calls[0]
    assert call['method'] == 'POST'
    assert call['path'] == '/api/v1/projects/p1/guidelines'
    # An omitted body or pinned flag is absent, not None.
    assert call['body'] == {'title': 'Glossing', 'summary': 'How this project glosses.'}


def test_create_passes_body_pinned_and_the_audit_message_through():
    client = _recording_client()
    client.guidelines.create('p1', 'Glossing', 'How this project glosses.',
                             body='Loanwords are **not** segmented.', pinned=True,
                             audit_message='seeding the manual')

    call = client.calls[0]
    assert call['body'] == {
        'title': 'Glossing',
        'summary': 'How this project glosses.',
        'body': 'Loanwords are **not** segmented.',
        'pinned': True,
    }
    assert call['audit_message'] == 'seeding the manual'


def test_update_sends_only_what_changed_so_a_body_edit_cannot_blank_the_title():
    client = _recording_client()
    client.guidelines.update('g1', body='New text.')

    call = client.calls[0]
    assert call['method'] == 'PATCH'
    assert call['path'] == '/api/v1/guidelines/g1'
    assert call['body'] == {'body': 'New text.'}


def test_update_can_unpin_since_false_is_a_value_and_not_an_omission():
    client = _recording_client()
    client.guidelines.update('g1', pinned=False)
    assert client.calls[0]['body'] == {'pinned': False}


def _recording_wire():
    """Record what the pagination helpers put on the wire.

    Unlike the JS client, `list_all` / `list_page` / `iter_pages` here call
    `http.make_request` directly rather than the client's own `_request`, so a
    stub on the client would never see them. Patching the module function is
    what the other pagination tests do too.
    """
    calls = []
    original = http.make_request

    def fake(client, method, path, *, query_params=None, **kwargs):
        calls.append({'method': method, 'path': path, 'query_params': query_params or {}})
        return {'entries': [], 'next_cursor': None}

    http.make_request = fake
    return calls, (lambda: setattr(http, 'make_request', original))


def test_list_asks_for_the_whole_set_and_include_bodies_reaches_the_wire_kebab_cased():
    client = PlaidClient('http://example.test', 'tok')
    calls, restore = _recording_wire()
    try:
        client.guidelines.list('p1')
        assert calls[0]['path'] == '/api/v1/projects/p1/guidelines'
        # An unasked-for flag is not sent.
        assert calls[0]['query_params'].get('include-bodies') is None

        calls.clear()
        client.guidelines.list('p1', include_bodies=True)
        assert calls[0]['query_params']['include-bodies'] is True
    finally:
        restore()


def test_list_page_threads_limit_and_cursor():
    client = PlaidClient('http://example.test', 'tok')
    calls, restore = _recording_wire()
    try:
        client.guidelines.list_page('p1', limit=2, cursor='c1')
        params = calls[0]['query_params']
        assert params['limit'] == 2
        assert params['cursor'] == 'c1'
    finally:
        restore()


def test_get_and_delete_address_one_guideline_by_id():
    client = _recording_client()
    client.guidelines.get('g1')
    client.guidelines.delete('g1', audit_message='tidying up')
    assert [(c['method'], c['path']) for c in client.calls] == [
        ('GET', '/api/v1/guidelines/g1'),
        ('DELETE', '/api/v1/guidelines/g1'),
    ]
    assert client.calls[1]['audit_message'] == 'tidying up'


def test_a_write_queues_on_a_batch_and_a_read_still_goes_over_the_wire():
    client = PlaidClient('http://example.test', 'tok')
    calls, restore = _recording_wire()
    try:
        batch = client.batch()
        # A guideline write is ordinary project data, so it queues with no flag.
        queued = batch.guidelines.create('p1', 'T', 'S')
        assert queued == {'batched': True}
        assert len(batch.operations) == 1
        assert batch.operations[0]['path'] == '/api/v1/projects/p1/guidelines'

        batch.guidelines.list('p1')
        # The read was answered from the wire, not queued.
        assert len(calls) == 1
        assert len(batch.operations) == 1
    finally:
        restore()


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            fn()
            print(f'ok  {name}')
    print('all passed')
