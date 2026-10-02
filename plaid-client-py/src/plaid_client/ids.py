"""Ids a client mints for what it creates.

A create may name the id of the row it makes, so a create sent again after
its answer was lost lands under the same id or is told the id is taken (409
with ``id-taken``). The server takes only a UUIDv7 (RFC 9562), shaped as its
own ids are: a 48-bit millisecond timestamp, a 12-bit counter within the
millisecond, then 62 random bits. Reads are id-ordered, so ids minted in one
millisecond must still sort in the order they were made.

``uuid.uuid7`` exists only from Python 3.14, and its layout is not this one.
"""

import hashlib
import secrets
import threading
import time
import uuid

_lock = threading.Lock()
_last_ms = 0
_counter = 0


def uuid7() -> str:
    """A fresh UUIDv7, later than every one this process minted before it."""
    global _last_ms, _counter
    with _lock:
        now = time.time_ns() // 1_000_000
        if now > _last_ms:
            _last_ms = now
            _counter = 0
        elif _counter < 0xFFF:
            _counter += 1
        else:
            # This millisecond is full: take the next one rather than repeat
            # an order.
            _last_ms += 1
            _counter = 0
        ms, counter = _last_ms, _counter
    return _compose(ms, counter, secrets.randbits(62))


def _compose(ms: int, counter: int, rand: int) -> str:
    """The UUIDv7 of a millisecond, a 12-bit counter within it and 62
    random bits."""
    value = ((ms & 0xFFFF_FFFF_FFFF) << 80) | (0x7 << 76) | (counter << 64) | (0b10 << 62) | rand
    h = f'{value:032x}'
    return f'{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}'


def drawn_uuid7(seed: str, n: int) -> str:
    """The ``n``th id drawn from ``seed``, a UUIDv7: the same every time, so
    work run again from the top names the same rows (an applied plan draws
    the ids it creates rows under from its own id). It is a UUIDv7 just after
    the seed, ``n + 1`` steps of its 12-bit counter on, so the ids sort in the
    order they were drawn and are dated with the seed, and its 62 random bits
    are a hash of the seed and ``n``.

    Python only: the JS client mints, and a browser's SHA-256 is async."""
    u = uuid.UUID(seed)
    if u.version != 7:
        raise ValueError(f'ids are drawn from a UUIDv7, not {seed!r}')
    top = u.int >> 64
    # The millisecond and the counter within it, as one number to count on from.
    at = ((top >> 16) << 12) + (top & 0xFFF) + 1 + n
    rand = int.from_bytes(hashlib.sha256(f'{u}/{n}'.encode()).digest()[:8], 'big') >> 2
    return _compose(at >> 12, at & 0xFFF, rand)
