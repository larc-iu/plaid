"""Regression tests for the cursor-pagination helpers.

The auto-cursor-follow loop in ``list_all`` is exactly what caused a prior
production revert (silent truncation at page 1), so these tests prove the full
set is returned across multiple pages, that the cursor is threaded, and that the
safety guards behave.

Run with::

    cd plaid-client-py && python -m pytest tests/ -q

The tests also run with no dependencies via::

    python tests/test_pagination.py
"""

import os
import sys

# Make ``plaid_client`` importable when running this file directly.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import http
from plaid_client.http import list_all, iter_pages


class _FakeClient:
    """Minimal stand-in; the request layer is monkeypatched, so this only needs
    to exist as the ``client`` argument.

    ``is_batching`` mirrors the real client's batch-mode flag, which the
    auto-paginating helpers check up front."""

    def __init__(self, is_batching=False):
        self.is_batching = is_batching


def _script_make_request(pages, calls):
    """Build a fake ``make_request`` that returns scripted pages in sequence and
    records the cursor seen on each call."""

    state = {'i': 0}

    def fake(client, method, path, *, query_params=None, **kwargs):
        cursor = query_params.get('cursor') if query_params else None
        calls.append({'method': method, 'path': path, 'cursor': cursor,
                      'bypass_batch': kwargs.get('bypass_batch')})
        i = state['i']
        if i >= len(pages):
            raise AssertionError(f'unexpected extra request (call #{len(calls)})')
        state['i'] += 1
        return pages[i]

    return fake


def _three_page_sequence():
    return [
        {'entries': [{'id': 'a'}, {'id': 'b'}], 'next_cursor': 'c1'},
        {'entries': [{'id': 'c'}, {'id': 'd'}], 'next_cursor': 'c2'},
        {'entries': [{'id': 'e'}], 'next_cursor': None},
    ]


def _patch(monkeypatch_or_none, pages, calls):
    """Patch ``http.make_request`` either via pytest's monkeypatch or, when run
    standalone, by direct attribute assignment (caller restores)."""
    fake = _script_make_request(pages, calls)
    if monkeypatch_or_none is not None:
        monkeypatch_or_none.setattr(http, 'make_request', fake)
        return None
    original = http.make_request
    http.make_request = fake
    return original


def test_list_all_returns_full_set_across_pages(monkeypatch):
    calls = []
    _patch(monkeypatch, _three_page_sequence(), calls)

    result = list_all(_FakeClient(), '/api/v1/things')

    assert [x['id'] for x in result] == ['a', 'b', 'c', 'd', 'e']
    assert len(calls) == 3
    assert [c['cursor'] for c in calls] == [None, 'c1', 'c2']


def test_list_all_raises_on_non_advancing_cursor(monkeypatch):
    calls = []
    _patch(monkeypatch, [
        {'entries': [{'id': 'a'}], 'next_cursor': 'stuck'},
        {'entries': [{'id': 'b'}], 'next_cursor': 'stuck'},
    ], calls)

    raised = False
    try:
        list_all(_FakeClient(), '/api/v1/things')
    except RuntimeError as e:
        raised = True
        assert 'did not advance' in str(e)
    assert raised, 'expected RuntimeError on non-advancing cursor'


# Every collection endpoint answers with the envelope, so a bare list is a
# broken endpoint. Absorbing it as a terminal full page is how a listing gets
# silently truncated, which is what caused the pagination revert once already.
def test_list_all_rejects_a_bare_list_naming_the_endpoint(monkeypatch):
    calls = []
    _patch(monkeypatch, [[{'id': 'a'}, {'id': 'b'}]], calls)

    raised = False
    try:
        list_all(_FakeClient(), '/api/v1/things')
    except ValueError as e:
        raised = True
        assert '/api/v1/things' in str(e)
        assert 'paginated envelope' in str(e)
    assert raised, 'expected ValueError on a bare list response'


def test_iter_pages_rejects_a_bare_list_naming_the_endpoint(monkeypatch):
    calls = []
    _patch(monkeypatch, [[{'id': 'a'}]], calls)

    raised = False
    try:
        for _page in iter_pages(_FakeClient(), '/api/v1/things'):
            break
    except ValueError as e:
        raised = True
        assert '/api/v1/things' in str(e)
        assert 'paginated envelope' in str(e)
    assert raised, 'expected ValueError on a bare list response'


def test_list_all_empty_envelope_returns_empty(monkeypatch):
    calls = []
    _patch(monkeypatch, [{'entries': [], 'next_cursor': None}], calls)

    result = list_all(_FakeClient(), '/api/v1/things')

    assert result == []
    assert len(calls) == 1


def test_list_all_follows_cursors_over_the_wire_while_batching(monkeypatch):
    # A page is a read, so it never joins the batch: chrome that lists comments
    # or documents beside an import gets its pages from the pool, in order,
    # instead of a batch marker it cannot follow a cursor through.
    calls = []
    _patch(monkeypatch, _three_page_sequence(), calls)

    result = list_all(_FakeClient(is_batching=True), '/api/v1/things')

    assert [x['id'] for x in result] == ['a', 'b', 'c', 'd', 'e']
    assert len(calls) == 3
    assert all(c['bypass_batch'] is True for c in calls)


def test_iter_pages_yields_each_non_empty_page(monkeypatch):
    calls = []
    _patch(monkeypatch, _three_page_sequence(), calls)

    pages = [[x['id'] for x in page]
             for page in iter_pages(_FakeClient(), '/api/v1/things')]

    assert pages == [['a', 'b'], ['c', 'd'], ['e']]


def test_iter_pages_suppresses_trailing_empty_page(monkeypatch):
    calls = []
    _patch(monkeypatch, [
        {'entries': [{'id': 'a'}, {'id': 'b'}], 'next_cursor': 'c1'},
        {'entries': [], 'next_cursor': None},
    ], calls)

    pages = [[x['id'] for x in page]
             for page in iter_pages(_FakeClient(), '/api/v1/things')]

    assert pages == [['a', 'b']]
    assert len(calls) == 2


def test_iter_pages_yields_over_the_wire_while_batching(monkeypatch):
    calls = []
    _patch(monkeypatch, _three_page_sequence(), calls)

    pages = [[x['id'] for x in page]
             for page in iter_pages(_FakeClient(is_batching=True), '/api/v1/things')]

    assert pages == [['a', 'b'], ['c', 'd'], ['e']]
    assert all(c['bypass_batch'] is True for c in calls)


def test_list_page_always_goes_over_the_wire(monkeypatch):
    # A page read by app chrome belongs to whoever asked for it, not to whatever
    # import or bulk edit holds a batch open on the same client. Queued, it
    # answered {'batched': True} instead of an envelope AND took a slot in the
    # batch's own results list.
    calls = []
    _patch(monkeypatch, [{'entries': [], 'next_cursor': None},
                         {'entries': [], 'next_cursor': None}], calls)

    http.list_page(_FakeClient(is_batching=True), '/api/v1/things', limit=1000)
    http.list_page(_FakeClient(), '/api/v1/things')

    assert len(calls) == 2
    assert all(c['bypass_batch'] is True for c in calls)


def test_list_documents_page_reads_during_an_open_batch(monkeypatch):
    from plaid_client.client import PlaidClient

    calls = []
    _patch(monkeypatch, [{'entries': [], 'next_cursor': None}], calls)
    client = PlaidClient('http://example.test', 'tok')
    client.is_batching = True

    client.projects.list_documents_page('p1', limit=1000)

    assert len(calls) == 1
    assert calls[0]['path'] == '/api/v1/projects/p1/documents'
    assert calls[0]['bypass_batch'] is True


def _run_standalone():
    """Fallback runner with no pytest dependency."""
    tests = [
        test_list_all_returns_full_set_across_pages,
        test_list_all_raises_on_non_advancing_cursor,
        test_list_all_rejects_a_bare_list_naming_the_endpoint,
        test_iter_pages_rejects_a_bare_list_naming_the_endpoint,
        test_list_all_empty_envelope_returns_empty,
        test_list_all_follows_cursors_over_the_wire_while_batching,
        test_iter_pages_yields_each_non_empty_page,
        test_iter_pages_suppresses_trailing_empty_page,
        test_iter_pages_yields_over_the_wire_while_batching,
        test_list_page_always_goes_over_the_wire,
        test_list_documents_page_reads_during_an_open_batch,
    ]
    failures = 0
    for t in tests:
        # Standalone: pass None for monkeypatch, restore make_request manually.
        original = http.make_request
        try:
            # None makes the _patch helper fall back to direct attribute
            # assignment instead of pytest's monkeypatch fixture.
            t(None)
            print(f'ok   {t.__name__}')
        except Exception as e:  # noqa: BLE001
            failures += 1
            print(f'FAIL {t.__name__}: {e}')
        finally:
            http.make_request = original
    if failures:
        print(f'{failures} failure(s)')
        sys.exit(1)
    print(f'{len(tests)} passed')


if __name__ == '__main__':
    _run_standalone()
