"""The keep-alive on ``client.documents.locked()``.

plaid-core expires a document lock 60 seconds after it was taken
(``plaid.server.locks/default-lock-expiration-ms``) and the holder's own writes
are what renew it. A service that reads a document, loads a model, parses for
minutes and only then writes therefore held the lock for its first minute and
nothing after that: it lapsed in silence, a person's edit could land between the
read the work was planned from and the write about to go out, and the write
clobbered it.

So the block renews on a timer, and a renewal it cannot make ends the run rather
than letting it write unlocked. The beat runs on a thread in real use; every
test here drives its policy on a fake clock instead, so nothing waits.

Run with::

    cd plaid-client-py && python -m pytest tests/test_document_lock.py -q
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.client import PlaidClient  # noqa: E402
from plaid_client.document_lock import (  # noqa: E402
    DOCUMENT_LOCK_TTL_S, DocumentLockLost, LockKeeper, lock_ttl_s,
)
from plaid_client.http import PlaidAPIError  # noqa: E402


class FakeClock:
    """A clock the keeper's own sleeps advance, plus a stop after N of them.

    ``sleep`` returns True the way ``threading.Event.wait`` does once the block
    holding the lock has exited, which is how ``run()`` terminates.
    """

    def __init__(self, stop_after):
        self.t = 0.0
        self.slept = []
        self._stop_after = stop_after

    def now(self):
        return self.t

    def sleep(self, delay):
        if len(self.slept) >= self._stop_after:
            return True
        self.slept.append(delay)
        self.t += delay
        return False


def _keeper(clock, refresh, ttl_s=DOCUMENT_LOCK_TTL_S, lost=None):
    return LockKeeper(refresh, 'd1', ttl_s, clock=clock.now, sleep=clock.sleep,
                      on_lost=lost.append if lost is not None else None)


# --- reading the window the server actually gave us --------------------------

def test_the_window_comes_from_the_servers_own_expires_at():
    # An operator who retunes :plaid.server.locks/config :expiration-ms changes
    # the only number that matters here. /info publishes the window; the acquire
    # response names the moment, which is what a renewal plans against.
    assert lock_ttl_s(45_000, 0.0) == 45.0
    assert lock_ttl_s(120_000, 60.0) == 60.0


def test_an_unbelievable_expiry_falls_back_to_the_documented_default():
    # A clock skew between this machine and the server is the one thing that can
    # produce these, and either a beat that never fires or one that fires
    # constantly is worse than the documented 60 seconds.
    assert lock_ttl_s(None, 0.0) == DOCUMENT_LOCK_TTL_S
    assert lock_ttl_s(1000, 500.0) == DOCUMENT_LOCK_TTL_S       # already past
    assert lock_ttl_s(99_999_999_999, 0.0) == DOCUMENT_LOCK_TTL_S  # hours away
    assert lock_ttl_s('soon', 0.0) == DOCUMENT_LOCK_TTL_S
    assert lock_ttl_s(True, 0.0) == DOCUMENT_LOCK_TTL_S


def test_the_beat_is_half_the_window_and_the_retry_a_tenth():
    short = LockKeeper(lambda _: None, 'd1', 20.0)
    assert short.interval_s == 10.0
    assert short.retry_s == 2.0
    # A window too short to leave room for a retry is a misconfiguration, not an
    # instruction to hammer the server.
    assert LockKeeper(lambda _: None, 'd1', 0.5).interval_s == DOCUMENT_LOCK_TTL_S / 2


# --- the beat ----------------------------------------------------------------

def test_a_long_quiet_run_keeps_the_lock():
    clock = FakeClock(stop_after=4)
    calls = []
    keeper = _keeper(clock, calls.append)
    keeper.run()
    # Four minutes of a parse that writes nothing, and the lock was renewed
    # every thirty seconds rather than lapsing after the first.
    assert clock.slept == [30.0, 30.0, 30.0, 30.0]
    assert calls == ['d1'] * 4
    assert keeper.lost is None


def test_one_failed_renewal_is_retried_before_the_lock_runs_out():
    clock = FakeClock(stop_after=4)
    attempts = []

    def refresh(document_id):
        attempts.append(clock.now())
        if len(attempts) == 1:
            raise PlaidAPIError('Network error', status=0)

    keeper = _keeper(clock, refresh)
    keeper.run()
    # Failed at 30s, retried at 36s, well inside the 60s the lock had left.
    assert clock.slept == [30.0, 6.0, 30.0, 30.0]
    assert attempts == [30.0, 36.0, 66.0, 96.0]
    assert keeper.lost is None


def test_failures_that_outlast_the_window_lose_the_lock():
    clock = FakeClock(stop_after=20)
    lost = []
    keeper = _keeper(clock, _raise(PlaidAPIError('Network error', status=0)), lost=lost)
    keeper.run()
    # 30, 36, 42, 48, 54, 60: the sixth attempt is the first at or past the
    # moment the lock we were renewing actually expired.
    assert clock.slept == [30.0, 6.0, 6.0, 6.0, 6.0, 6.0]
    assert keeper.lost is not None
    assert isinstance(keeper.lost, DocumentLockLost)
    assert keeper.lost.document_id == 'd1'
    assert lost == [keeper.lost]


def test_a_423_loses_the_lock_at_once():
    # Somebody else holds the document now, so ours had already expired. There
    # is nothing to retry.
    clock = FakeClock(stop_after=20)
    keeper = _keeper(clock, _raise(PlaidAPIError('Locked', status=423)))
    keeper.run()
    assert clock.slept == [30.0]
    assert keeper.lost is not None


def _raise(error):
    def fn(_document_id):
        raise error
    return fn


# --- what a lost lock does to the block that was holding it ------------------

class _Resp:
    ok = True
    status_code = 200
    headers = {'content-type': 'application/json'}
    text = '{}'
    content = b'{}'
    reason = 'OK'

    def __init__(self, body):
        self._body = body

    def json(self):
        return self._body


def _client(monkeypatch, keeper_cls=None):
    """A client whose requests are recorded rather than sent, with the keeper
    swapped for one the test triggers by hand (the real one is exercised above
    on a fake clock)."""
    client = PlaidClient('http://plaid.internal:8085', 'tok')
    sent = []

    class _Session:
        def request(self, **kw):
            sent.append((kw.get('method'), kw.get('url', '')))
            if '/lock' in kw.get('url', ''):
                return _Resp({'lock-id': 'L1', 'user-id': 'me', 'expires-at': 0})
            return _Resp({})

        def close(self):
            pass

    client.session = _Session()
    if keeper_cls is not None:
        monkeypatch.setattr('plaid_client.client.LockKeeper', keeper_cls)
    return client, sent


class _ManualKeeper:
    """Stands in for the real keeper so a test can lose the lock on cue."""

    made = []

    def __init__(self, refresh, document_id, ttl_s, *, on_lost=None, **kwargs):
        self.refresh = refresh
        self.document_id = document_id
        self.ttl_s = ttl_s
        self._on_lost = on_lost
        self.started = False
        self.stopped = False
        self.lost = None
        _ManualKeeper.made.append(self)

    def start(self):
        self.started = True

    def stop(self):
        self.stopped = True

    def lose(self):
        self.lost = DocumentLockLost('lapsed', document_id=self.document_id)
        self._on_lost(self.lost)


@pytest.fixture(autouse=True)
def _fresh_keepers():
    _ManualKeeper.made = []


def test_a_block_renews_while_it_runs_and_stops_renewing_on_the_way_out(monkeypatch):
    client, sent = _client(monkeypatch, _ManualKeeper)
    with client.documents.locked('d1'):
        assert _ManualKeeper.made[0].started is True
    keeper = _ManualKeeper.made[0]
    assert keeper.stopped is True
    assert keeper.document_id == 'd1'
    assert len(sent) == 2
    assert _is_acquire_with_minted_id(sent[0])
    assert sent[1] == ('DELETE', 'http://plaid.internal:8085/api/v1/documents/d1/lock?lock-id=L1')


def test_the_block_renews_and_releases_with_the_holder_id_the_acquire_named(monkeypatch):
    client, sent = _client(monkeypatch, _ManualKeeper)
    with client.documents.locked('d1') as lock:
        assert lock.lock_id == 'L1'
        _ManualKeeper.made[0].refresh('d1')
    assert len(sent) == 3
    assert _is_acquire_with_minted_id(sent[0])
    assert sent[1:] == [('POST', 'http://plaid.internal:8085/api/v1/documents/d1/lock?lock-id=L1'),
                        ('DELETE', 'http://plaid.internal:8085/api/v1/documents/d1/lock?lock-id=L1')]


def _is_acquire_with_minted_id(request):
    """The block's acquire names a holder id the client minted, a UUID."""
    import re
    method, url = request
    return (method == 'POST'
            and re.fullmatch(r'http://plaid\.internal:8085/api/v1/documents/d1/lock'
                             r'\?new-lock-id=[0-9a-f-]{36}', url) is not None)


class _PerHolderCore:
    """plaid-core's lock rule, per holder: an acquire without an id is a new
    holder and is refused while anyone holds the document, and only the
    holder's id renews or releases it."""

    def __init__(self):
        self.holder = None
        self.minted = 0

    def request(self, **kw):
        from urllib.parse import parse_qs, urlparse
        url = urlparse(kw.get('url', ''))
        query = parse_qs(url.query)
        lock_id = query.get('lock-id', query.get('new-lock-id', [None]))[0]
        method = kw.get('method')
        if method == 'POST':
            if self.holder is not None and self.holder != lock_id:
                return _Denied423()
            if lock_id is None:
                self.minted += 1
                lock_id = f'L{self.minted}'
            self.holder = lock_id
            return _Resp({'lock-id': lock_id, 'user-id': 'me', 'expires-at': 0})
        if method == 'DELETE':
            if self.holder == lock_id:
                self.holder = None
            return _Resp({})
        return _Resp({})

    def close(self):
        pass


class _Denied423:
    ok = False
    status_code = 423
    headers = {'content-type': 'application/json'}
    text = '{}'
    reason = 'Locked'

    def json(self):
        return {'error': 'Document is locked', 'user-id': 'me'}


def test_a_second_block_of_the_same_user_is_refused_and_cannot_release_the_first(monkeypatch):
    # Two approvals by one person on one document at once. Each is its own
    # holder, so the second gets the 423 instead of sharing the lock, and its
    # way out does not release the lock from under the first.
    monkeypatch.setattr('plaid_client.client.LockKeeper', _ManualKeeper)
    core = _PerHolderCore()
    first = PlaidClient('http://plaid.internal:8085', 'tok')
    second = PlaidClient('http://plaid.internal:8085', 'tok')
    first.session = core
    second.session = core
    with first.documents.locked('d1') as held:
        with pytest.raises(PlaidAPIError) as caught:
            with second.documents.locked('d1'):
                pytest.fail('the second block ran')
        assert caught.value.status == 423
        assert core.holder == held.lock_id
        # The first's beat still renews it.
        _ManualKeeper.made[0].refresh('d1')
        assert core.holder == held.lock_id
    assert core.holder is None


def test_a_lost_lock_stops_the_next_write(monkeypatch):
    client, sent = _client(monkeypatch, _ManualKeeper)
    with pytest.raises(DocumentLockLost):
        with client.documents.locked('d1'):
            _ManualKeeper.made[0].lose()
            # The guard is in the request layer, not in a check the service has
            # to remember to make.
            with pytest.raises(DocumentLockLost):
                client.tokens.create('tl1', 't1', 0, 5)
            # A read is still fine: it cannot clobber anyone.
            client.documents.get('d1')
    # The write never went out; the read and the release did.
    methods = [m for m, _ in sent]
    assert methods == ['POST', 'GET', 'DELETE']


def test_a_block_that_finished_anyway_ends_with_the_loss(monkeypatch):
    # The whole point: a run that kept computing after the lock went, and wrote
    # nothing more, must not report success.
    client, _sent = _client(monkeypatch, _ManualKeeper)
    with pytest.raises(DocumentLockLost) as caught:
        with client.documents.locked('d1'):
            _ManualKeeper.made[0].lose()
    assert caught.value.document_id == 'd1'


def test_the_blocks_own_error_is_never_masked_by_the_loss(monkeypatch):
    client, _sent = _client(monkeypatch, _ManualKeeper)
    with pytest.raises(ValueError, match='no gloss field'):
        with client.documents.locked('d1'):
            _ManualKeeper.made[0].lose()
            raise ValueError('no gloss field by that name')


def test_the_flag_is_cleared_so_a_later_block_can_write(monkeypatch):
    client, sent = _client(monkeypatch, _ManualKeeper)
    with pytest.raises(DocumentLockLost):
        with client.documents.locked('d1'):
            _ManualKeeper.made[0].lose()
    assert client.document_lock_lost is None
    client.tokens.create('tl1', 't1', 0, 5)
    assert ('POST', 'http://plaid.internal:8085/api/v1/tokens') in sent


def test_the_handle_lets_work_give_up_before_its_next_write(monkeypatch):
    client, _sent = _client(monkeypatch, _ManualKeeper)
    seen = []
    with pytest.raises(DocumentLockLost):
        with client.documents.locked('d1') as lock:
            assert lock.lost is None
            lock.raise_if_lost()
            _ManualKeeper.made[0].lose()
            seen.append(lock.lost)
            lock.raise_if_lost()
    assert isinstance(seen[0], DocumentLockLost)


def test_keep_alive_false_takes_the_lock_and_starts_nothing(monkeypatch):
    client, sent = _client(monkeypatch, _ManualKeeper)
    with client.documents.locked('d1', keep_alive=False) as lock:
        assert lock.lost is None
    assert _ManualKeeper.made == []
    assert [m for m, _ in sent] == ['POST', 'DELETE']


def test_the_window_is_read_off_the_acquire_response(monkeypatch):
    import plaid_client.client as client_mod

    client = PlaidClient('http://plaid.internal:8085', 'tok')

    class _Session:
        def request(self, **kw):
            return _Resp({'user-id': 'me', 'expires-at': 1_000_000 + 20_000})

        def close(self):
            pass

    client.session = _Session()
    monkeypatch.setattr(client_mod.time, 'time', lambda: 1000.0)
    monkeypatch.setattr('plaid_client.client.LockKeeper', _ManualKeeper)
    with client.documents.locked('d1'):
        pass
    # 20 seconds of window, not the 60-second default.
    assert _ManualKeeper.made[0].ttl_s == 20.0


def test_another_users_lock_still_refuses_before_the_block_runs(monkeypatch):
    client = PlaidClient('http://plaid.internal:8085', 'tok')

    class _Denied:
        ok = False
        status_code = 423
        headers = {'content-type': 'application/json'}
        text = '{}'
        reason = 'Locked'

        def json(self):
            return {'user-id': 'someone@else.com'}

    class _Session:
        def request(self, **kw):
            return _Denied()

        def close(self):
            pass

    client.session = _Session()
    ran = []
    with pytest.raises(PlaidAPIError) as caught:
        with client.documents.locked('d1'):
            ran.append(True)
    assert caught.value.status == 423
    assert 'someone@else.com' in str(caught.value)
    assert ran == []


# --- an acquire whose answer was lost ----------------------------------------

class _LostAnswerCore(_PerHolderCore):
    """The per-holder core behind a network that loses the answers to the
    first `lose` acquires. The core took the lock each time."""

    def __init__(self, lose):
        super().__init__()
        self.lose = lose
        self.acquires = []

    def request(self, **kw):
        resp = super().request(**kw)
        if kw.get('method') == 'POST' and 'new-lock-id' in kw.get('url', ''):
            self.acquires.append(kw['url'])
            if len(self.acquires) <= self.lose:
                import requests
                raise requests.exceptions.ReadTimeout('read timed out')
        return resp


def _lost_answer_client(monkeypatch, lose):
    monkeypatch.setattr('plaid_client.client.LockKeeper', _ManualKeeper)
    monkeypatch.setattr('plaid_client.client.LOCK_ACQUIRE_RETRY_S', 0)
    core = _LostAnswerCore(lose)
    client = PlaidClient('http://plaid.internal:8085', 'tok')
    client.session = core
    return client, core


def test_an_acquire_whose_answer_was_lost_is_sent_again_under_the_same_id(monkeypatch):
    # The core took the lock and the answer never came. The retry names the
    # same holder, so it is that holder's lock and not a 423 against itself.
    client, core = _lost_answer_client(monkeypatch, lose=1)
    with client.documents.locked('d1') as lock:
        assert core.holder == lock.lock_id
    assert len(core.acquires) == 2
    assert core.acquires[0] == core.acquires[1]
    assert core.holder is None, 'the block released it on the way out'


def test_an_acquire_never_answered_releases_what_it_may_hold(monkeypatch):
    client, core = _lost_answer_client(monkeypatch, lose=3)
    ran = []
    with pytest.raises(PlaidAPIError) as caught:
        with client.documents.locked('d1'):
            ran.append(True)
    assert caught.value.status == 0
    assert ran == []
    assert len(core.acquires) == 3
    assert core.holder is None, 'the lock it took unseen is released, not left to expire'


def test_the_refusal_names_the_holder_and_no_document_id(monkeypatch):
    monkeypatch.setattr('plaid_client.client.LockKeeper', _ManualKeeper)
    core = _PerHolderCore()
    core.holder = 'someone-else'
    client = PlaidClient('http://plaid.internal:8085', 'tok')
    client.session = core
    with pytest.raises(PlaidAPIError) as caught:
        with client.documents.locked('01a0ee8b-fe96-7000-9884-d5be54bc5a86'):
            pytest.fail('the block ran')
    assert caught.value.status == 423
    assert str(caught.value) == "This document is being edited by me. Try again once they're done."
