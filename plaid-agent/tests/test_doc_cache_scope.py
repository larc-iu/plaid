"""The parsed-document cache is shared by every turn of a process, and a
document id at one version is not one document everywhere: two servers, or
two copies of one database, hold different content under it, and a database
restored from a backup brings back versions the cache has seen. A parse is
cached under the server, the version and the time of the last write, so none
of these is ever served another's document (bench note 6)."""

import pytest

from fixtures import FakeClient as IgtClient, document_raw as igt_document, scan_ws
from ud_fixtures import PID, document_raw, ud_client

from plaid_agent.ud import tools as ud_tools
from plaid_agent.ud.project import load_project
from plaid_agent.ud.tools import Workspace


@pytest.fixture
def ud_cache():
    ud_tools._DOC_CACHE.clear()
    yield ud_tools._DOC_CACHE
    ud_tools._DOC_CACHE.clear()


def _client(base_url, modified='2026-10-01T10:00:00Z'):
    raw = document_raw()
    raw['time_modified'] = modified
    c = ud_client(documents={'ud1': raw})
    c.no_doc_cache = False
    c.base_url = base_url
    return c


def _doc(c):
    return Workspace(c, load_project(c, PID)).doc('Viaje')


def test_a_turn_on_the_same_server_reuses_the_parse(ud_cache):
    c = _client('http://one:8085')
    assert _doc(c) is _doc(c)


def test_another_server_with_the_same_id_and_version_reads_its_own(ud_cache):
    a = _doc(_client('http://one:8085'))
    b = _doc(_client('http://two:8085'))
    assert a is not b


def test_a_restored_database_written_again_is_read_afresh(ud_cache):
    before = _doc(_client('http://one:8085', modified='2026-10-01T10:00:00Z'))
    # Restored to an older backup, then written back up to the same version.
    after = _doc(_client('http://one:8085', modified='2026-10-05T09:30:00Z'))
    assert after is not before


def test_a_version_a_query_answered_takes_the_listing_time_or_is_not_cached(fresh_document_cache):
    c = IgtClient()
    c.no_doc_cache = False
    raw = igt_document()
    raw['time_modified'] = '2026-10-01T10:00:00Z'
    c._documents['d1'] = raw
    w = scan_ws(c)
    listed = w._version_of(w.documents()[0])
    assert w._version_of({'id': 'd1', 'version': raw['version']}) == listed
    assert listed.server == c.base_url and listed.modified == '2026-10-01T10:00:00Z'
    # Moved on since the listing: nothing to tell a restored copy apart by.
    assert w._version_of({'id': 'd1', 'version': raw['version'] + 1}) is None
    assert w._version_of({'version': raw['version']}) is None
