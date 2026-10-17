import re
import sys

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


@pytest.fixture(autouse=True)
def release_code_workers(monkeypatch):
    """Every sandbox worker a test checked out goes back when the test ends.

    The service gives the turn's worker back when the turn ends
    (``Workspace.close``). A test's workspace is just dropped, and one that
    loaded a document is held by a reference cycle until the collector runs,
    with its worker. The pool holds as many workers as the machine has CPUs,
    so on a 4-CPU CI runner the fifth such test waited for a worker forever,
    and the release run of v0.2.0-alpha.27 hung for 3.5 hours in
    test_code_load_argument.py."""
    from plaid_agent.core import sandbox
    held = []
    get = sandbox.Session.get

    def tracked(self):
        held.append(self)
        return get(self)

    monkeypatch.setattr(sandbox.Session, 'get', tracked)
    yield
    for session in held:
        session.close()


def pytest_configure(config):
    config.addinivalue_line('markers', 'isolates: keep the bidi isolates in plan lines (see plain_isolates)')
    # A pool of two workers on every machine, as small as a CI runner's or
    # smaller, and a checkout that waits a minute at most, so a test that
    # keeps a worker fails where it is, here as on CI, rather than hanging
    # the run (release_code_workers).
    from plaid_agent.core import sandbox
    sandbox.POOL_OPTIONS.update(max_processes=2, checkout_timeout=60.0)


# An import of a module through which a test may read the session's core:
# the igt fixtures (their fake client sends its queries there), the live
# helpers, and the sweeps that build igt workspaces.
READS_CORE = re.compile(r'^\s*(?:from|import)\s+(?:fixtures|fixtures_ext|multi_fixtures|live|test_read_tools_smoke)\b',
                        re.M)


def pytest_collection_modifyitems(session, config, items):
    """The tests of modules that may read through the core run last, in their
    own order, so it boots while the others run: it takes about twenty
    seconds from source, and the first of them asked for it four seconds in."""
    seen = {}

    def reads_core(item):
        path = getattr(item, 'path', None)
        if path not in seen:
            try:
                seen[path] = bool(READS_CORE.search(path.read_text()))
            except (OSError, AttributeError):
                seen[path] = False
        return seen[path]
    items.sort(key=reads_core)


def pytest_collection_finish(session):
    """Start booting the session's Plaid core (``live.py``) while the first
    tests run, when a collected module reads through it: the igt fixtures send
    their queries there. A run that collected none of them never boots one."""
    if session.items and ('live' in sys.modules or 'fixtures' in sys.modules):
        import live
        live.start_early()


@pytest.fixture(scope='session', autouse=True)
def _stop_the_core():
    """Stop the core the session booted, once every test is done."""
    yield
    if 'live' in sys.modules:
        sys.modules['live'].stop()
