"""Reading documents ahead of being asked, and the bounds on doing so.

The point of the reader is that a corpus walk overlaps its reads. The point of
the bounds is that it does not overlap ALL of them: the server is expected to
run on a small machine, and a walk that started a thousand reads at once would
trade one problem for a worse one at both ends.
"""

import threading

import pytest

from plaid_agent.core import docload


class Doc:
    def __init__(self, doc_id, version=1):
        self.id = doc_id
        self.version = version


class Fetcher:
    """Counts what it was asked for, and can be made to wait."""

    def __init__(self, version=1):
        self.version = version
        self.calls = []
        self.lock = threading.Lock()
        self.gate = None

    def __call__(self, doc_id):
        if self.gate is not None:
            self.gate.wait(5)
        with self.lock:
            self.calls.append(doc_id)
        return Doc(doc_id, self.version)

    @property
    def count(self):
        with self.lock:
            return len(self.calls)


@pytest.fixture
def reader_factory():
    made = []

    def make(fetch, cache=None, **kw):
        r = docload.Reader(fetch, cache if cache is not None else docload.DocCache(16), **kw)
        made.append(r)
        return r

    yield make
    for r in made:
        r.close()


def test_a_cached_document_is_not_read_again(reader_factory):
    cache = docload.DocCache(16)
    fetch = Fetcher()
    first = reader_factory(fetch, cache)
    first.get('d1', 1)
    assert fetch.count == 1
    # A second turn, its own reader, the same process-wide cache.
    second = reader_factory(fetch, cache)
    assert second.get('d1', 1).id == 'd1'
    assert fetch.count == 1


def test_a_document_read_ahead_is_waited_on_rather_than_read_twice(reader_factory):
    fetch = Fetcher()
    r = reader_factory(fetch)
    r.read_ahead([('d1', 1), ('d2', 1)])
    assert r.get('d1', 1).id == 'd1'
    assert r.get('d2', 1).id == 'd2'
    assert sorted(fetch.calls) == ['d1', 'd2'], 'each document read exactly once'


def test_an_unversioned_document_is_never_cached_or_read_ahead(reader_factory):
    """A client may opt out by listing no version, which the test doubles do:
    they reuse ids across different content, so a version means nothing."""
    cache = docload.DocCache(16)
    fetch = Fetcher()
    r = reader_factory(fetch, cache)
    r.read_ahead([('d1', None)])
    assert fetch.count == 0, 'nothing to key it under, so nothing started'
    r.get('d1', None)
    r.get('d1', None)
    assert fetch.count == 2, 'and nothing remembered between reads'


def test_a_document_that_changed_under_us_is_not_cached_under_the_old_version(reader_factory):
    """The version comes from the document list; a write between that list and
    this read means the body is NOT the version we asked for, and caching it
    under that key would hand the next turn a document its key lies about."""
    cache = docload.DocCache(16)
    fetch = Fetcher(version=7)
    r = reader_factory(fetch, cache)
    assert r.get('d1', 3).version == 7
    assert cache.get(('d1', 3)) is None


def test_reading_ahead_stays_within_its_window(monkeypatch, reader_factory):
    """However long the list, only a bounded few are in flight or waiting to
    be taken. This is the memory bound on a walk over a large corpus."""
    monkeypatch.setenv('PLAID_AGENT_READ_WORKERS', '1')
    fetch = Fetcher()
    fetch.gate = threading.Event()  # nothing finishes until we say so
    r = reader_factory(fetch)
    window = r._window
    assert window < 50, 'the window is what the test is about'
    r.read_ahead([(f'd{i}', 1) for i in range(50)])
    assert len(r._inflight) == window
    assert len(r._queued) == 50 - window
    fetch.gate.set()
    # Taking one lets exactly one more start.
    r.get('d0', 1)
    assert len(r._inflight) <= window
    assert len(r._queued) <= 50 - window


def test_closing_drops_what_had_not_started(monkeypatch, reader_factory):
    monkeypatch.setenv('PLAID_AGENT_READ_WORKERS', '1')
    fetch = Fetcher()
    fetch.gate = threading.Event()
    r = reader_factory(fetch)
    r.read_ahead([(f'd{i}', 1) for i in range(50)])
    r.close()
    fetch.gate.set()
    assert not r._queued
    r.read_ahead([('d99', 1)])
    assert not r._queued, 'a closed reader starts nothing new'


def test_a_walk_is_two_documents(reader_factory):
    fetch = Fetcher()
    r = reader_factory(fetch)
    assert not r.walking()
    r.get('d1', 1)
    assert not r.walking(), 'one document is a question about one document'
    r.get('d2', 1)
    assert r.walking()
    r.get('d1', 1)
    assert r.walking()


def test_read_ahead_once_arms_once(reader_factory):
    fetch = Fetcher()
    r = reader_factory(fetch)
    r.read_ahead([('d1', 1)], once=True)
    r.read_ahead([('d2', 1)], once=True)
    assert 'd2' not in fetch.calls and ('d2', 1) not in r._queued


def test_the_cache_forgets_the_least_recently_used():
    cache = docload.DocCache(2)
    cache.put(('a', 1), Doc('a'))
    cache.put(('b', 1), Doc('b'))
    cache.get(('a', 1))  # a is used again, so b is the oldest
    cache.put(('c', 1), Doc('c'))
    assert cache.get(('b', 1)) is None
    assert cache.get(('a', 1)) is not None and cache.get(('c', 1)) is not None


def test_the_worker_ceiling_is_an_operator_setting(monkeypatch):
    assert docload.workers() == docload.WORKERS
    monkeypatch.setenv('PLAID_AGENT_READ_WORKERS', '1')
    assert docload.workers() == 1, 'one worker turns overlapping off'
    monkeypatch.setenv('PLAID_AGENT_READ_WORKERS', '500')
    assert docload.workers() == 16, 'and nothing an operator types uncaps it'
    monkeypatch.setenv('PLAID_AGENT_READ_WORKERS', 'lots')
    assert docload.workers() == docload.WORKERS, 'nonsense falls back, it does not throw'


def test_a_finished_read_gives_its_window_slot_back(reader_factory):
    """A read that finished ahead of the walk has ALREADY cached its document.
    Answering the walk from the cache without taking that slot back leaves the
    window full of finished reads nobody is waiting for: nothing tops it up,
    and the rest of the walk goes back to reading one document at a time."""
    cache = docload.DocCache(64)
    fetch = Fetcher()
    r = reader_factory(fetch, cache)
    r.read_ahead([(f'd{i}', 1) for i in range(20)])
    window = r._window
    for f in list(r._inflight.values()):
        f.result()  # the window's worth has finished and is in the cache
    assert len(r._queued) == 20 - window
    assert cache.get(('d0', 1)) is not None, 'the read ahead cached it'

    r.get('d0', 1)
    assert len(r._queued) == 20 - window - 1, 'taking one started one more'


def test_a_walk_says_what_it_is_reading_even_when_it_did_not_wait(reader_factory):
    """Reporting only the documents the walk had to wait for would go quiet
    exactly when the reading ahead is working, which reads as a hang."""
    said = []
    fetch = Fetcher()
    r = reader_factory(fetch, docload.DocCache(16), on_progress=said.append)
    r.read_ahead([('d1', 1), ('d2', 1)])
    r.get('d1', 1, 'First')
    r.get('d2', 1, 'Second')
    r.get('d3', 1, 'Third')  # not read ahead, read here
    assert said == ['Reading "First"…', 'Reading "Second"…', 'Reading "Third"…']
