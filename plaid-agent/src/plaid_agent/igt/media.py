"""A document's recording and its time alignment, read only (survey item 11,
Luke 2026-10-15: "yes, read-only").

Where they live (memory plaid_igt_media_transcript): the time alignment is a
token layer of its own (role ``time-alignment``), one token per segment of the
transcript over the baseline, ``metadata.timeBegin`` and ``timeEnd`` in
seconds and an optional ``speaker``. The recording is the document's media
file, and core reads its length from the file's header when it is uploaded
and gives it with the document as ``media_duration`` (WAV, MP4, M4A, MOV,
FLAC, MP3). A recording of another format (WebM, Ogg) has none, and the tools
say its length is unknown rather than guess.

Nothing here writes. Word-level alignment is out of scope
(plaid_igt_planned_features).
"""

from typing import Optional, Tuple


def recording_of(ws, doc_id: str) -> Tuple[bool, Optional[float]]:
    """Whether a document has a recording, and its length in seconds as core
    stored it (None when core could not read it). One light read of the
    document a turn, never the parsed document: a parse is kept while the
    document's version stands, and a length can be stored without moving the
    version (the 2026-10 one-off backfill did, H16-REVIEW-5)."""
    memo = ws.recordings
    if doc_id not in memo:
        raw = ws.client.documents.get(doc_id) or {}
        memo[doc_id] = (bool(raw.get('media_url')), raw.get('media_duration'))
    return memo[doc_id]


def clock(seconds: Optional[float]) -> str:
    """``1:02:03`` or ``12:03`` for a length, ``?`` when unknown."""
    if seconds is None:
        return '?'
    s = int(round(seconds))
    h, m, sec = s // 3600, (s % 3600) // 60, s % 60
    return f'{h}:{m:02d}:{sec:02d}' if h else f'{m}:{sec:02d}'


def at_time(seconds: float) -> str:
    """``1:02.5`` for a point in a recording, to a tenth of a second."""
    # In tenths before the minutes are taken, so 59.97 s is 1:00.0, not 0:60.0
    # (H16-IGT-TOOLS-7).
    tenths = int(round(max(0.0, seconds) * 10))
    m, t = divmod(tenths, 600)
    h, m = divmod(m, 60)
    return (f'{h}:{m:02d}:' if h else f'{m}:') + f'{t // 10:02d}.{t % 10}'


#: Seconds a segment may run past a recording's stored length before it is
#: said to: the length is read from a header, to about a hundredth.
PAST_END_SLACK = 0.05


def past_end(last: Optional[float], length: Optional[float]) -> Optional[str]:
    """``"segments run to 1:04, past its end at 1:00"`` when the last segment
    ends past a recording of known length, else None."""
    if last is None or length is None or last <= length + PAST_END_SLACK:
        return None
    return f'segments run to {clock(last)}, past its end at {clock(length)}'
