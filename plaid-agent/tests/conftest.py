import pytest


@pytest.fixture(autouse=True)
def plain_isolates(request, monkeypatch):
    """Plan lines without their bidi isolates (``core.bidi``), so a test
    reads ``Gloss "a" → "b"`` as written. A test marked ``isolates`` keeps
    them, and the ones in ``test_bidi_isolates.py`` check where they go."""
    if request.node.get_closest_marker('isolates') is None:
        from plaid_agent.core import bidi
        monkeypatch.setattr(bidi, 'FSI', '')
        monkeypatch.setattr(bidi, 'LRI', '')
        monkeypatch.setattr(bidi, 'PDI', '')
    yield


@pytest.fixture
def fresh_document_cache():
    """An empty parsed-document cache, before and after.

    The cache is keyed by id, server, version and last write. The fake
    client opts out of it entirely (``no_doc_cache``, because fixtures reuse
    document ids with different content), so only a test that opts back IN
    needs this. It used to be autouse and ran for every test in the suite,
    which put one app's internals in the conftest every app shares.
    """
    from plaid_agent.igt import workspace
    workspace._DOC_CACHE.clear()
    yield workspace._DOC_CACHE
    workspace._DOC_CACHE.clear()


def pytest_configure(config):
    config.addinivalue_line('markers', 'isolates: keep the bidi isolates in plan lines (see plain_isolates)')
