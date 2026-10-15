"""A document's recording and its time alignment, read only (survey item 11,
Luke 2026-10-15: "yes, read-only").

Where they live (memory plaid_igt_media_transcript): the time alignment is a
token layer of its own (role ``time-alignment``), one token per segment of the
transcript over the baseline, ``metadata.timeBegin`` and ``timeEnd`` in
seconds and an optional ``speaker``. The recording is the document's media
file. Its length is stored nowhere: the editor reads it from the file. So does
this, from the file's header, fetched in byte ranges through the document's
media link: an MP4/M4A/MOV ``mvhd`` box (the box chain is walked, so a
``moov`` at the end costs a few small reads), a WAV ``fmt `` and ``data``
chunk, a FLAC ``STREAMINFO``, and an MP3's Xing/Info or VBRI frame count, or
its first frame's bit rate over the file's size. Anything else (WebM, Ogg) is
of unknown length, and the tools say so rather than guess.

Nothing here writes. Word-level alignment is out of scope
(plaid_igt_planned_features).
"""

import struct
import urllib.request
from typing import Callable, Optional

#: How long one ranged read of a recording may take.
READ_TIMEOUT_S = 20
#: The most bytes a header read asks for at once.
CHUNK = 64 * 1024

Reader = Callable[[int, int], bytes]  # (start, end exclusive) -> bytes


# --- the headers ----------------------------------------------------------------

def duration(read: Reader, size: int) -> Optional[float]:
    """Seconds, from the header ``read`` serves, or None when the format is
    not one read here or the header does not say."""
    if size < 12:
        return None
    head = read(0, min(size, CHUNK))
    for fn in (_wav, _mp4, _flac, _mp3):
        try:
            got = fn(head, read, size)
        except (struct.error, IndexError, ValueError, ZeroDivisionError):
            got = None
        if got is not None and got > 0:
            return got
    return None


def _wav(head: bytes, read: Reader, size: int) -> Optional[float]:
    if head[:4] != b'RIFF' or head[8:12] != b'WAVE':
        return None
    at, byte_rate = 12, None
    while at + 8 <= size:
        chunk = head[at:at + 8] if at + 8 <= len(head) else read(at, at + 8)
        cid, n = chunk[:4], struct.unpack('<I', chunk[4:8])[0]
        if cid == b'fmt ':
            body = head[at + 8:at + 24] if at + 24 <= len(head) else read(at + 8, at + 24)
            byte_rate = struct.unpack('<I', body[8:12])[0]
        elif cid == b'data':
            if not byte_rate:
                return None
            n = min(n, size - at - 8)  # a streamed WAV may say 0xFFFFFFFF
            return n / byte_rate
        at += 8 + n + (n & 1)
    return None


def _mp4(head: bytes, read: Reader, size: int) -> Optional[float]:
    if head[4:8] not in (b'ftyp', b'moov', b'mdat', b'free', b'wide', b'skip'):
        return None

    def walk(start: int, end: int, wanted: bytes):
        at = start
        while at + 8 <= end:
            box = read(at, at + 16)
            n, kind = struct.unpack('>I', box[:4])[0], box[4:8]
            body = at + 8
            if n == 1:
                n, body = struct.unpack('>Q', box[8:16])[0], at + 16
            elif n == 0:
                n = end - at
            if n < 8:
                return None
            if kind == wanted:
                return body, at + n
            at += n
        return None

    moov = walk(0, size, b'moov')
    if not moov:
        return None
    mvhd = walk(moov[0], moov[1], b'mvhd')
    if not mvhd:
        return None
    box = read(mvhd[0], mvhd[0] + 32)
    if box[0] == 1:
        scale, length = struct.unpack('>I', box[20:24])[0], struct.unpack('>Q', box[24:32])[0]
    else:
        scale, length = struct.unpack('>I', box[12:16])[0], struct.unpack('>I', box[16:20])[0]
    if not scale or length in (0, 0xFFFFFFFF):
        return None
    return length / scale


def _flac(head: bytes, read: Reader, size: int) -> Optional[float]:
    if head[:4] != b'fLaC' or head[4] & 0x7F != 0:
        return None
    info = head[8:8 + 34]
    rate = (info[10] << 12) | (info[11] << 4) | (info[12] >> 4)
    samples = ((info[13] & 0x0F) << 32) | struct.unpack('>I', info[14:18])[0]
    return samples / rate if rate and samples else None


_MP3_RATES = {  # MPEG version bits -> sample rates by index
    3: (44100, 48000, 32000), 2: (22050, 24000, 16000), 0: (11025, 12000, 8000)}
_MP3_KBPS = {  # (MPEG-1?, layer bits) -> bit rates by index
    (True, 1): (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320),
    (True, 2): (0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384),
    (True, 3): (0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448),
    (False, 1): (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160),
    (False, 2): (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160),
    (False, 3): (0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256)}


def _mp3(head: bytes, read: Reader, size: int) -> Optional[float]:
    at = 0
    if head[:3] == b'ID3':
        at = 10 + ((head[6] & 0x7F) << 21 | (head[7] & 0x7F) << 14 | (head[8] & 0x7F) << 7 | (head[9] & 0x7F))
        if head[5] & 0x10:
            at += 10
    frame = read(at, at + 256) if at + 256 > len(head) else head[at:at + 256]
    # The first frame sync within a little way of where it should be.
    for skip in range(0, min(len(frame) - 4, 64)):
        if frame[skip] == 0xFF and frame[skip + 1] & 0xE0 == 0xE0:
            frame, at = frame[skip:], at + skip
            break
    else:
        return None
    b1, b2, b3 = frame[1], frame[2], frame[3]
    version, layer = (b1 >> 3) & 3, (b1 >> 1) & 3
    if version == 1 or layer == 0:
        return None
    mpeg1 = version == 3
    kbps = _MP3_KBPS[(mpeg1, layer)][b2 >> 4] if (b2 >> 4) < 15 else 0
    rate = _MP3_RATES[version][(b2 >> 2) & 3] if (b2 >> 2) & 3 < 3 else 0
    if not rate:
        return None
    per_frame = 384 if layer == 3 else (1152 if mpeg1 or layer == 2 else 576)
    mono = (b3 >> 6) == 3
    side = (17 if mono else 32) if mpeg1 else (9 if mono else 17)
    for off in (4 + side, 36):
        tag = frame[off:off + 4]
        if tag in (b'Xing', b'Info') and frame[off + 7] & 1:
            frames = struct.unpack('>I', frame[off + 8:off + 12])[0]
            return frames * per_frame / rate
        if tag == b'VBRI':
            frames = struct.unpack('>I', frame[off + 14:off + 18])[0]
            return frames * per_frame / rate
    if not kbps:
        return None
    return (size - at) * 8 / (kbps * 1000)


# --- over the wire --------------------------------------------------------------

def ranged_reader(url: str) -> tuple:
    """(read, size) over a media link, each read one HTTP Range request; the
    size is the file's, from the first answer's Content-Range."""
    size_box = [None]

    def read(start: int, end: int) -> bytes:
        if end <= start:
            return b''
        req = urllib.request.Request(url, headers={'Range': f'bytes={start}-{end - 1}'})
        with urllib.request.urlopen(req, timeout=READ_TIMEOUT_S) as res:  # noqa: S310 - the server's own link
            whole = res.headers.get('Content-Range') or ''
            if '/' in whole and whole.rsplit('/', 1)[1].isdigit():
                size_box[0] = int(whole.rsplit('/', 1)[1])
            data = res.read(end - start + 1)
        return data[:end - start]

    read(0, 16)
    return read, size_box[0]


def recording_seconds(ws, doc_id: str, media_url: Optional[str]) -> Optional[float]:
    """The length of a document's recording in seconds, None when it has
    none or its length cannot be read. Kept for the turn, by the media URL,
    which names the file's version."""
    if not media_url:
        return None
    cache = ws.__dict__.setdefault('_recording_seconds', {})
    if media_url in cache:
        return cache[media_url]
    got = None
    try:
        link = ws.client.documents.media_link(doc_id)
        read, size = ranged_reader(link['url'])
        if size:
            got = duration(read, size)
    except Exception:  # noqa: BLE001 - a recording that cannot be read is of unknown length, said so
        got = None
    cache[media_url] = got
    return got


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
