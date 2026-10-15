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
    stored it (None when core could not read it). A document loaded this turn
    says so itself, any other is one light read."""
    doc = ws._docs.get(doc_id)
    if doc is not None:
        return bool(doc.media_url), doc.media_duration
    raw = ws.client.documents.get(doc_id) or {}
    return bool(raw.get('media_url')), raw.get('media_duration')


def clock(seconds: Optional[float]) -> str:
    """``1:02:03`` or ``12:03`` for a length, ``?`` when unknown."""
    if seconds is None:
        return '?'
    s = int(round(seconds))
    h, m, sec = s // 3600, (s % 3600) // 60, s % 60
    return f'{h}:{m:02d}:{sec:02d}' if h else f'{m}:{sec:02d}'


def at_time(seconds: float) -> str:
    """``1:02.5`` for a point in a recording, to a tenth of a second."""
    m, sec = divmod(max(0.0, seconds), 60)
    h, m = divmod(int(m), 60)
    return (f'{h}:{m:02d}:' if h else f'{m}:') + f'{sec:04.1f}'
