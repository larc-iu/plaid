"""One channel of a multichannel recording, as a mono file a model can read.

A recording with a speaker on each channel is transcribed channel by
channel: the app sends one request per channel, and the service pulls that
channel out before the model hears it. A PCM WAV (plain or
WAVE_FORMAT_EXTENSIBLE, which is what the app's mix writes) is read here
with numpy and written back as 16-bit mono at the same rate. Anything else
goes through ffmpeg when there is one on the PATH, and is refused otherwise,
naming what was asked.
"""

import os
import shutil
import struct
import subprocess

from plaid_client.service import Refusal

WAV_PCM = 0x0001
WAV_FLOAT = 0x0003
WAV_EXTENSIBLE = 0xFFFE


def _read_wav_header(f):
    """``(format_tag, channels, sample_rate, bits, data_offset, data_size)``
    of the RIFF/WAVE file at ``f``, or None when it is not one."""
    head = f.read(12)
    if len(head) < 12 or head[:4] != b'RIFF' or head[8:12] != b'WAVE':
        return None
    fmt = None
    size = os.fstat(f.fileno()).st_size
    at = 12
    while at + 8 <= size:
        f.seek(at)
        chunk = f.read(8)
        if len(chunk) < 8:
            return None
        cid = chunk[:4]
        csize = struct.unpack('<I', chunk[4:8])[0]
        body = at + 8
        if cid == b'fmt ' and csize >= 16:
            raw = f.read(min(csize, 40))
            tag, channels, rate, _, _, bits = struct.unpack('<HHIIHH', raw[:16])
            if tag == WAV_EXTENSIBLE and len(raw) >= 26:
                # The real coding is the first two bytes of the subformat GUID.
                tag = struct.unpack('<H', raw[24:26])[0]
            fmt = (tag, channels, rate, bits)
        elif cid == b'data':
            if fmt is None:
                return None
            data_size = csize if csize > 0 else size - body
            return (*fmt, body, min(data_size, size - body))
        at = body + csize + (csize % 2)
    return None


def _write_mono_wav(path, samples_int16, rate):
    data = samples_int16.astype('<i2').tobytes()
    with open(path, 'wb') as out:
        out.write(b'RIFF')
        out.write(struct.pack('<I', 36 + len(data)))
        out.write(b'WAVE')
        out.write(b'fmt ')
        out.write(struct.pack('<IHHIIHH', 16, WAV_PCM, 1, rate, rate * 2, 2, 16))
        out.write(b'data')
        out.write(struct.pack('<I', len(data)))
        out.write(data)


def wav_channel_count(path):
    """How many channels the WAV at ``path`` has, or None when it is not a
    PCM or float WAV this module reads."""
    with open(path, 'rb') as f:
        header = _read_wav_header(f)
    if header is None:
        return None
    tag, channels = header[0], header[1]
    return channels if tag in (WAV_PCM, WAV_FLOAT) else None


def _extract_wav_channel(path, channel, out_path):
    import numpy as np

    with open(path, 'rb') as f:
        header = _read_wav_header(f)
        if header is None:
            return False
        tag, channels, rate, bits, offset, data_size = header
        if tag not in (WAV_PCM, WAV_FLOAT):
            raise Refusal(f'Channel {channel + 1} cannot be read from this WAV (coding {tag:#06x}).')
        if not 0 <= channel < channels:
            raise Refusal(f'The recording has {channels} channel{"" if channels == 1 else "s"}, '
                          f'not a channel {channel + 1}.')
        width = bits // 8
        frames = data_size // (width * channels)
        f.seek(offset)
        raw = f.read(frames * width * channels)
    if tag == WAV_FLOAT and bits == 32:
        samples = np.frombuffer(raw, dtype='<f4').reshape(-1, channels)[:, channel]
        mono = np.clip(np.rint(samples * 32767), -32768, 32767).astype('<i2')
    elif tag == WAV_FLOAT and bits == 64:
        samples = np.frombuffer(raw, dtype='<f8').reshape(-1, channels)[:, channel]
        mono = np.clip(np.rint(samples * 32767), -32768, 32767).astype('<i2')
    elif bits == 16:
        mono = np.frombuffer(raw, dtype='<i2').reshape(-1, channels)[:, channel]
    elif bits == 8:
        samples = np.frombuffer(raw, dtype='u1').reshape(-1, channels)[:, channel]
        mono = ((samples.astype('<i2') - 128) << 8).astype('<i2')
    elif bits == 24:
        block = np.frombuffer(raw, dtype='u1').reshape(-1, channels, 3)[:, channel, :]
        value = (block[:, 0].astype('<i4') | (block[:, 1].astype('<i4') << 8)
                 | (block[:, 2].astype('<i4') << 16))
        value = np.where(value >= 1 << 23, value - (1 << 24), value)
        mono = (value >> 8).astype('<i2')
    elif bits == 32:
        samples = np.frombuffer(raw, dtype='<i4').reshape(-1, channels)[:, channel]
        mono = (samples >> 16).astype('<i2')
    else:
        raise Refusal(f'Channel {channel + 1} cannot be read from this WAV ({bits}-bit samples).')
    _write_mono_wav(out_path, mono, rate)
    return True


def extract_channel(path, channel, out_dir):
    """The one channel ``channel`` (0-based) of the recording at ``path`` as a
    mono 16-bit WAV in ``out_dir``. Answers the new file's path.

    Raises:
        Refusal: the recording has no such channel, or it is not a WAV and
            there is no ffmpeg to read it with.
    """
    out_path = os.path.join(out_dir, f'channel-{channel}.wav')
    if _extract_wav_channel(path, channel, out_path):
        return out_path
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        raise Refusal(f'Channel {channel + 1} cannot be taken out of this recording: it is not a '
                      'WAV, and ffmpeg is not installed where the service runs.')
    result = subprocess.run(
        [ffmpeg, '-y', '-loglevel', 'error', '-i', path,
         '-af', f'pan=mono|c0=c{channel}', '-acodec', 'pcm_s16le', out_path],
        capture_output=True, text=True)
    if result.returncode != 0:
        raise Refusal(f'Channel {channel + 1} cannot be taken out of this recording '
                      f'({(result.stderr or "ffmpeg failed").strip().splitlines()[-1]}).')
    return out_path
