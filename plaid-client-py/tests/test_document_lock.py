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
    DocumentLockLost, LockKeeper, lock_ttl_s,
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


# What plaid-core holds a lock for by default.
TTL_S = 60.0


def _keeper(clock, refresh, ttl_s=TTL_S, lost=None):
    return LockKeeper(refresh, 'd1', ttl_s, clock=clock.now, sleep=clock.sleep,
                      on_lost=lost.append if lost is not None else None)


# --- reading the window the server actually gave us --------------------------

def test_the_window_comes_from_the_servers_own_expires_at_on_the_servers_clock():
    # An operator who retunes :plaid.server.locks/config :expiration-ms changes
    # the only number that matters here. /info publishes the window; the acquire
    # response names the moment, which is what a renewal plans against, read
    # against the server's clock (server_now), so this machine's clock cannot
    # skew it.
    assert lock_ttl_s(45_000, 0.0) == 45.0
    assert lock_ttl_s(120_000, 60.0) == 60.0


def test_a_window_that_cannot_be_one_falls_back_to_cores_default():
    # REV-DEBT-R1 F4: with no Date header read the server clock is this
    # machine's, unbounded, and a missing expires_at was a KeyError.
    assert lock_ttl_s(None, 0.0) == 60.0
    assert lock_ttl_s(1000, 5.0) == 60.0
    assert lock_ttl_s(99_999_999_999, 0.0) == 60.0
    assert lock_ttl_s('soon', 0.0) == 60.0


def test_the_beat_is_half_the_window_and_the_retry_a_tenth():
    short = LockKeeper(lambda _: None, 'd1', 20.0)
    assert short.interval_s == 10.0
    assert short.retry_s == 2.0
    # A window too short to leave room for a retry still beats at most once a
    # second.
    assert LockKeeper(lambda _: None, 'd1', 0.5).interval_s == 1.0


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


def test_a_stopped_run_stops_renewing_and_loses_the_lock_once_the_window_is_out():
    # REV-W3-SVC F3: a run stopped while its model call hangs lets the
    # document go within the window instead of holding it until the call ends.
    clock = FakeClock(stop_after=20)
    calls, lost = [], []
    stopping = []
    keeper = LockKeeper(calls.append, 'd1', TTL_S, clock=clock.now, sleep=clock.sleep,
                        on_lost=lost.append, should_renew=lambda: not stopping)

    def sleep(delay):
        if clock.t >= 30:
            stopping.append(True)        # Stop pressed after the first renewal
        return clock.sleep(delay)
    keeper._sleep = sleep
    keeper.run()
    # Renewed at 30, then asked every 6 s and renewed nothing, lost at 84:
    # the last tick whose next one would be past the 90 s the renewal gave,
    # less a margin for the renewal's latency (REV-W3F F1).
    assert calls == ['d1']
    assert clock.t == 84.0
    assert keeper.lost is not None and lost == [keeper.lost]
    assert 'stopped' in str(keeper.lost)


def test_a_stopped_run_is_lost_while_the_server_still_holds_the_lock():
    # REV-W3F F1: a run whose stop lands after its last checkpoint enters
    # critical() whenever its planning ends. The keeper must have declared the
    # lock lost before the server's expiry, or that critical() writes unheld.
    # Every tick that does not declare it lost must leave the next tick inside
    # the lock the server holds, so a critical() entered then is renewed live.
    clock = FakeClock(stop_after=40)
    server = {'expires': TTL_S}
    lost, ticks = [], []

    def refresh(_document_id):
        server['expires'] = clock.t + TTL_S    # the server stamps on receipt
        clock.t += 0.3                         # and the answer takes 0.3 s back

    stopping = []
    keeper = LockKeeper(refresh, 'd1', TTL_S, clock=clock.now, sleep=clock.sleep,
                        on_lost=lost.append,
                        should_renew=lambda: ticks.append(clock.t) or not stopping)

    def sleep(delay):
        if clock.t >= 30:
            stopping.append(True)
        return clock.sleep(delay)
    keeper._sleep = sleep
    keeper.run()
    assert lost == [keeper.lost]
    lost_at = ticks[-1]
    assert lost_at < server['expires']
    for t in ticks[:-1]:
        assert t + keeper.retry_s < server['expires']


def test_a_short_window_still_leaves_room_before_the_expiry():
    # The probe's numbers (REV-W3F F1): a 2 s lock, a 0.3 s renewal.
    clock = FakeClock(stop_after=40)
    server = {'expires': 2.0}
    stopping = []

    def refresh(_document_id):
        server['expires'] = clock.t + 2.0
        clock.t += 0.3

    keeper = LockKeeper(refresh, 'd1', 2.0, clock=clock.now, sleep=clock.sleep,
                        should_renew=lambda: not stopping)

    def sleep(delay):
        if clock.t >= 1.0:
            stopping.append(True)
        return clock.sleep(delay)
    keeper._sleep = sleep
    keeper.run()
    assert keeper.lost is not None
    assert clock.t + keeper.retry_s <= server['expires']


def test_renewal_goes_on_once_the_run_is_inside_its_writes_again():
    clock = FakeClock(stop_after=6)
    calls = []
    answers = iter([True, False, False, True, True, True])
    keeper = LockKeeper(calls.append, 'd1', TTL_S, clock=clock.now, sleep=clock.sleep,
                        should_renew=lambda: next(answers))
    keeper.run()
    assert clock.slept == [30.0, 30.0, 6.0, 6.0, 30.0, 30.0]
    assert len(calls) == 4
    assert keeper.lost is None


def test_locked_hands_should_renew_to_its_keeper(monkeypatch):
    client, _ = _client(monkeypatch, _ManualKeeper)
    ask = lambda: True  # noqa: E731
    with client.documents.locked('d1', should_renew=ask):
        pass
    assert _ManualKeeper.made[0].should_renew is ask


def test_locked_for_writes_stops_renewing_once_a_stop_is_pending_outside_the_writes(monkeypatch):
    from plaid_client.service import locked_for_writes
    from plaid_client.testing import Helper
    client, _ = _client(monkeypatch, _ManualKeeper)
    monkeypatch.setattr(client.documents, 'get', lambda *a, **k: {'id': 'd1', 'version': 3})
    helper = Helper()
    with locked_for_writes(client, 'd1', response_helper=helper):
        should_renew = _ManualKeeper.made[0].should_renew
        assert should_renew() is True
        helper.stop()
        assert should_renew() is False
        with helper.critical():
            assert should_renew() is True     # the writes are under way
    with locked_for_writes(client, 'd1'):
        assert _ManualKeeper.made[1].should_renew is None


def test_a_lock_a_stop_let_lapse_ends_the_run_as_stopped(monkeypatch):
    # REV-W3F F5: a stopped run whose body ends with no checkpoint after the
    # lapse (Whisper finding no speech) is a stop, not a failure. So is a
    # write the lost lock refused.
    from plaid_client.service import locked_for_writes
    from plaid_client.services import ServiceCancelled
    from plaid_client.testing import Helper
    client, _ = _client(monkeypatch, _ManualKeeper)
    monkeypatch.setattr(client.documents, 'get', lambda *a, **k: {'id': 'd1', 'version': 3})
    helper = Helper()
    with pytest.raises(ServiceCancelled):
        with locked_for_writes(client, 'd1', response_helper=helper):
            helper.stop()
            _ManualKeeper.made[-1].lose()
    with pytest.raises(ServiceCancelled):
        with locked_for_writes(client, 'd1', response_helper=helper):
            _ManualKeeper.made[-1].lose()
            client.spans.update('s1', 'NOUN')


def test_a_lock_lost_to_a_failed_renewal_is_still_a_failure(monkeypatch):
    from plaid_client.service import locked_for_writes
    from plaid_client.testing import Helper
    client, _ = _client(monkeypatch, _ManualKeeper)
    monkeypatch.setattr(client.documents, 'get', lambda *a, **k: {'id': 'd1', 'version': 3})
    with pytest.raises(DocumentLockLost):
        with locked_for_writes(client, 'd1', response_helper=Helper()):
            _ManualKeeper.made[-1].lose(PlaidAPIError('Locked', status=423))


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

    def __init__(self, refresh, document_id, ttl_s, *, on_lost=None, should_renew=None,
                 **kwargs):
        self.refresh = refresh
        self.should_renew = should_renew
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

    def lose(self, cause=None):
        self.lost = DocumentLockLost('lapsed', document_id=self.document_id, cause=cause)
        self._on_lost(self.lost)

    def now(self):
        return 7.0

    def note_write(self, sent_at):
        self.writes = getattr(self, 'writes', []) + [sent_at]


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


def test_a_server_clock_half_an_hour_ahead_does_not_stretch_the_window(monkeypatch):
    # expires_at is the server's moment. Read against this machine's clock it
    # looked 31 minutes away, and the block went 15 minutes between renewals
    # of a one-minute lock.
    from datetime import datetime, timedelta, timezone
    from email.utils import format_datetime
    monkeypatch.setattr('plaid_client.client.LockKeeper', _ManualKeeper)
    server_now = datetime.now(timezone.utc).replace(microsecond=0) + timedelta(minutes=30)

    class _Skewed(_Resp):
        headers = {'content-type': 'application/json', 'Date': format_datetime(server_now, usegmt=True)}

    class _Core(_PerHolderCore):
        def request(self, **kw):
            resp = super().request(**kw)
            body = resp.json() if isinstance(resp, _Resp) else None
            if kw.get('method') == 'POST' and body and 'lock-id' in body:
                return _Skewed(dict(body, **{'expires-at': int(server_now.timestamp() * 1000) + 60_000}))
            return resp

    client = PlaidClient('http://plaid.internal:8085', 'tok')
    client.session = _Core()
    with client.documents.locked('d1'):
        pass
    (keeper,) = _ManualKeeper.made
    assert 55 < keeper.ttl_s <= 61


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


# --- a write the server took renewed the lock too (REV-R4-CORE F4) ----------

def test_an_accepted_write_moves_the_window_a_failing_renewal_counts_against():
    # Renewals fail with a 5xx from 30 s on while the run's writes land: the
    # server renews the lock on each, so the keeper must not call it lost at
    # 60 s, the end of the window its own renewals gave.
    clock = FakeClock(stop_after=40)
    lost = []
    keeper = _keeper(clock, None, lost=lost)

    def refresh(document_id):
        if clock.t <= 54:
            keeper.note_write(clock.t - 1)     # a write sent just before
        raise PlaidAPIError('Bad gateway', status=502)
    keeper._refresh = refresh
    keeper.run()
    # The last write was sent at 53, so the window runs to 113: lost at the
    # first failed renewal at or past it.
    assert clock.t == 114.0
    assert lost == [keeper.lost]


def test_a_write_answered_after_the_window_ran_out_moves_nothing():
    # The server may have taken it after the lock lapsed, when a write by the
    # holder passes and renews nothing.
    clock = FakeClock(stop_after=40)
    keeper = _keeper(clock, _raise(PlaidAPIError('Bad gateway', status=502)))
    clock.t = 61.0
    keeper.note_write(10.0)
    clock.t = 0.0
    keeper.run()
    assert clock.t == 60.0
    assert keeper.lost is not None


class _VersionedResp(_Resp):
    def __init__(self, body, versions, replayed=False):
        super().__init__(body)
        self.headers = {'content-type': 'application/json',
                        'X-Document-Versions': __import__('json').dumps(versions)}
        if replayed:
            from plaid_client.http import REPLAYED_HEADER
            self.headers[REPLAYED_HEADER] = 'true'


def _versioned_client(monkeypatch, answers):
    """A client whose writes are answered, in turn, by ``answers``: (versions,
    replayed) pairs, for single requests and batches alike."""
    monkeypatch.setattr('plaid_client.client.LockKeeper', _ManualKeeper)
    client = PlaidClient('http://plaid.internal:8085', 'tok')
    queue = list(answers)

    class _Session:
        def request(self, **kw):
            if '/lock' in kw.get('url', ''):
                return _Resp({'lock-id': 'L1', 'user-id': 'me', 'expires-at': 0})
            versions, replayed = queue.pop(0)
            return _VersionedResp({'id': 't1'}, versions, replayed)

        def post(self, url, **kw):
            versions, replayed = queue.pop(0)
            return _VersionedResp([{'status': 201, 'headers': {}, 'body': {'id': 't1'}}],
                                  versions, replayed)

        def close(self):
            pass

    client.session = _Session()
    return client


def test_a_write_that_moves_the_held_documents_version_tells_its_keeper(monkeypatch):
    client = _versioned_client(monkeypatch, [({'d1': 4}, False), ({'d1': 4}, False),
                                             ({'d2': 9}, False), ({'d1': 5}, True),
                                             ({'d1': 6}, False)])
    client.document_versions['d1'] = 3
    with client.documents.locked('d1'):
        keeper = _ManualKeeper.made[0]
        client.tokens.create('tl1', 't1', 0, 5)       # moved d1: renewed
        client.tokens.create('tl1', 't1', 0, 5)       # d1 where it was: not a write of it
        client.tokens.create('tl1', 't1', 0, 5)       # another document
        client.tokens.create('tl1', 't1', 0, 5)       # replayed: taken before, renews nothing
        with client.batched() as b:                   # a batch's request counts as well
            b.tokens.create('tl1', 't1', 0, 5)
    assert keeper.writes == [7.0, 7.0]
    assert client.lock_keepers == {}
