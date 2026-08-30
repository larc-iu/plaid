import pytest


@pytest.fixture(autouse=True)
def _fresh_document_cache():
    """The parsed-document cache is keyed by (id, version), exact on a real
    server; fake fixtures reuse ids with different content, so start empty."""
    from plaid_igt_agent import tools
    tools._DOC_CACHE.clear()
    yield
    tools._DOC_CACHE.clear()
