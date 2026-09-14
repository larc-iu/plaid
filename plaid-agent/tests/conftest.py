import pytest


@pytest.fixture
def fresh_document_cache():
    """An empty parsed-document cache, before and after.

    The cache is keyed by (id, version), exact on a real server. The fake
    client opts out of it entirely (``no_doc_cache``, because fixtures reuse
    document ids with different content), so only a test that opts back IN
    needs this. It used to be autouse and ran for every test in the suite,
    which put one app's internals in the conftest every app shares.
    """
    from plaid_agent.igt import workspace
    workspace._DOC_CACHE.clear()
    yield workspace._DOC_CACHE
    workspace._DOC_CACHE.clear()
