"""One channel of a multichannel recording, taken out for a model. Run::

    cd plaid-client-py && python -m pytest tests/test_asr_channels.py -q
"""

import os
import struct
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.service import Refusal  # noqa: E402
from plaid_client.workflows.asr import channels as ch  # noqa: E402
from plaid_client.workflows.asr import extract_channel, wav_channel_count  # noqa: E402

np = pytest.importorskip('numpy')


def wav_bytes(frames, rate=16000, bits=16, tag=ch.WAV_PCM, extensible=False):
    """A WAV of ``frames`` (a list of per-frame tuples, one value per channel)."""
    channels = len(frames[0])
    width = bits // 8
    if tag == ch.WAV_FLOAT:
        fmt_char = {32: 'f', 64: 'd'}[bits]
        data = b''.join(struct.pack('<' + fmt_char * channels, *f) for f in frames)
    elif bits == 24:
        data = b''.join(int(v).to_bytes(3, 'little', signed=True) for f in frames for v in f)
    elif bits == 8:
        data = bytes(v for f in frames for v in f)
    else:
        code = {16: 'h', 32: 'i'}[bits]
        data = b''.join(struct.pack('<' + code * channels, *f) for f in frames)
    block = channels * width
    if extensible:
        fmt = struct.pack('<HHIIHH', ch.WAV_EXTENSIBLE, channels, rate, rate * block, block, bits)
        fmt += struct.pack('<HHI', 22, bits, 0)
        fmt += struct.pack('<H', tag) + bytes.fromhex('0000000000108000 00aa00389b71'.replace(' ', ''))
    else:
        fmt = struct.pack('<HHIIHH', tag, channels, rate, rate * block, block, bits)
    body = b'fmt ' + struct.pack('<I', len(fmt)) + fmt + b'data' + struct.pack('<I', len(data)) + data
    return b'RIFF' + struct.pack('<I', 4 + len(body)) + b'WAVE' + body


def read_mono(path):
    with open(path, 'rb') as f:
        header = ch._read_wav_header(f)
        tag, channels, rate, bits, offset, size = header
        f.seek(offset)
        raw = f.read(size)
    return (tag, channels, rate, bits), np.frombuffer(raw, dtype='<i2').tolist()


def test_a_channel_of_a_plain_pcm_wav_comes_out_as_mono_at_the_same_rate(tmp_path):
    src = tmp_path / 'mix.wav'
    src.write_bytes(wav_bytes([(1, 10, 100), (2, 20, 200), (3, 30, 300)], rate=22050))
    assert wav_channel_count(str(src)) == 3
    out = extract_channel(str(src), 1, str(tmp_path))
    assert os.path.basename(out) == 'channel-1.wav'
    header, samples = read_mono(out)
    assert header == (ch.WAV_PCM, 1, 22050, 16)
    assert samples == [10, 20, 30]


def test_the_mix_the_app_writes_past_two_channels_is_extensible_and_reads_the_same(tmp_path):
    src = tmp_path / 'mix.wav'
    src.write_bytes(wav_bytes([(1, 10, 100), (2, 20, 200)], extensible=True))
    assert wav_channel_count(str(src)) == 3
    _, samples = read_mono(extract_channel(str(src), 2, str(tmp_path)))
    assert samples == [100, 200]


def test_wider_samples_are_scaled_to_sixteen_bits(tmp_path):
    src24 = tmp_path / 'a.wav'
    src24.write_bytes(wav_bytes([(0, 256 * 1000), (0, -256 * 2)], bits=24))
    _, samples = read_mono(extract_channel(str(src24), 1, str(tmp_path)))
    assert samples == [1000, -2]
    src32 = tmp_path / 'b.wav'
    src32.write_bytes(wav_bytes([(65536 * 7, 0)], bits=32))
    _, samples = read_mono(extract_channel(str(src32), 0, str(tmp_path)))
    assert samples == [7]
    srcf = tmp_path / 'c.wav'
    srcf.write_bytes(wav_bytes([(0.5, -1.0), (0.0, 1.0)], bits=32, tag=ch.WAV_FLOAT))
    _, samples = read_mono(extract_channel(str(srcf), 1, str(tmp_path)))
    assert samples == [-32767, 32767]


def test_a_channel_the_recording_does_not_have_is_refused(tmp_path):
    src = tmp_path / 'mix.wav'
    src.write_bytes(wav_bytes([(1, 10)]))
    with pytest.raises(Refusal) as caught:
        extract_channel(str(src), 2, str(tmp_path))
    assert str(caught.value) == 'The recording has 2 channels, not a channel 3.'


def test_a_recording_that_is_not_a_wav_needs_ffmpeg_and_is_refused_without_one(tmp_path, monkeypatch):
    src = tmp_path / 'talk.mp3'
    src.write_bytes(b'\xff\xfb\x90\x00' + b'\0' * 100)
    assert wav_channel_count(str(src)) is None
    monkeypatch.setattr(ch.shutil, 'which', lambda name: None)
    with pytest.raises(Refusal) as caught:
        extract_channel(str(src), 0, str(tmp_path))
    assert 'ffmpeg is not installed' in str(caught.value)


def stub_ffmpeg(tmp_path, monkeypatch, wav):
    """An ``ffmpeg`` on PATH that writes ``wav`` (bytes) to the last path it
    is given and records its arguments, one per line, in ``argv.txt``."""
    bin_dir = tmp_path / 'bin'
    bin_dir.mkdir()
    (tmp_path / 'stub.wav').write_bytes(wav)
    script = bin_dir / 'ffmpeg'
    script.write_text(
        f'#!{sys.executable}\n'
        'import shutil, sys\n'
        f'open({str(tmp_path / "argv.txt")!r}, "w").write("\\n".join(sys.argv[1:]))\n'
        f'shutil.copyfile({str(tmp_path / "stub.wav")!r}, sys.argv[-1])\n')
    script.chmod(0o755)
    monkeypatch.setenv('PATH', f'{bin_dir}{os.pathsep}{os.environ.get("PATH", "")}')
    return lambda: (tmp_path / 'argv.txt').read_text().split('\n')


def test_a_recording_that_is_not_a_wav_is_decoded_whole_by_ffmpeg_then_split_here(tmp_path, monkeypatch):
    src = tmp_path / 'talk.mp3'
    src.write_bytes(b'\xff\xfb\x90\x00')
    argv = stub_ffmpeg(tmp_path, monkeypatch, wav_bytes([(1, 10), (2, 20)], rate=44100))
    out_dir = tmp_path / 'out'
    out_dir.mkdir()
    out = extract_channel(str(src), 1, str(out_dir))
    assert os.path.basename(out) == 'channel-1.wav'
    header, samples = read_mono(out)
    assert header == (ch.WAV_PCM, 1, 44100, 16)
    assert samples == [10, 20]
    args = argv()
    assert args[args.index('-i') + 1] == str(src)
    assert args[args.index('-c:a') + 1] == 'pcm_s16le'
    assert '-af' not in args
    assert args[-1].endswith('.wav') and args[-1] != out
    # The whole decode is not left beside the channel.
    assert os.listdir(out_dir) == ['channel-1.wav']


def test_a_channel_a_recording_that_is_not_a_wav_does_not_have_is_refused(tmp_path, monkeypatch):
    src = tmp_path / 'talk.mp3'
    src.write_bytes(b'\xff\xfb\x90\x00')
    stub_ffmpeg(tmp_path, monkeypatch, wav_bytes([(1,), (2,)]))
    with pytest.raises(Refusal) as caught:
        extract_channel(str(src), 1, str(tmp_path))
    assert str(caught.value) == 'The recording has 1 channel, not a channel 2.'


def test_an_ffmpeg_failure_with_nothing_said_is_still_refused_readably(tmp_path, monkeypatch):
    src = tmp_path / 'talk.mp3'
    src.write_bytes(b'\xff\xfb\x90\x00')
    monkeypatch.setattr(ch.shutil, 'which', lambda name: '/usr/bin/ffmpeg')
    monkeypatch.setattr(ch.subprocess, 'run',
                        lambda args, **kw: type('R', (), {'returncode': 1, 'stderr': ' \n '})())
    with pytest.raises(Refusal) as caught:
        extract_channel(str(src), 0, str(tmp_path))
    assert str(caught.value) == 'Channel 1 cannot be taken out of this recording (ffmpeg failed).'
