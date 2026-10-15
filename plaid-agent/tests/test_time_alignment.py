"""Read-only time alignment for the igt assistant (survey item 11, Luke
2026-10-15): the segments' times and the recording's length in corpus_stats,
read_document and run_code, so "how many minutes are transcribed" is one
call. Nothing here writes."""

import copy
import io
import struct
import wave

import pytest

import fixtures as igt_fx
from fixtures import FakeClient, fake_ws, project_raw, document_raw, lexicon_raw, VOCAB
from live import live_client, require_sandbox, seed  # noqa: F401 - fixture

from plaid_agent.core.bidi import for_model
from plaid_agent.igt import media, stats
from plaid_agent.igt.project import load_project
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.workspace import Workspace

ALIGN = 'tk-align'


# --- the headers --------------------------------------------------------------------

def _reader(data: bytes):
    return (lambda a, b: data[a:b]), len(data)


def _wav(seconds: float, rate: int = 8000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b'\x00\x00' * int(rate * seconds))
    return buf.getvalue()


def _box(kind: bytes, body: bytes) -> bytes:
    return struct.pack('>I', 8 + len(body)) + kind + body


def test_a_wav_says_its_length_in_its_fmt_and_data_chunks():
    assert media.duration(*_reader(_wav(2.5))) == pytest.approx(2.5)


@pytest.mark.parametrize('version', [0, 1])
def test_an_mp4_says_its_length_in_mvhd_even_after_a_large_mdat(version):
    if version == 0:
        mvhd = bytes([0, 0, 0, 0]) + struct.pack('>IIII', 0, 0, 1000, 83500) + b'\x00' * 80
    else:
        mvhd = bytes([1, 0, 0, 0]) + struct.pack('>QQIQ', 0, 0, 600, 600 * 90) + b'\x00' * 80
    data = _box(b'ftyp', b'isom\x00\x00\x02\x00') + _box(b'mdat', b'\x00' * 200000) \
        + _box(b'moov', _box(b'mvhd', mvhd))
    assert media.duration(*_reader(data)) == pytest.approx(83.5 if version == 0 else 90)


def test_an_mp3_by_its_xing_frame_count_or_its_bit_rate():
    # MPEG-1 layer III, 128 kbps, 44.1 kHz, stereo: FF FB 90 00.
    frame = b'\xff\xfb\x90\x00' + b'\x00' * 32 + b'Xing' + struct.pack('>II', 1, 100) + b'\x00' * 400
    assert media.duration(*_reader(b'ID3\x03\x00\x00\x00\x00\x00\x00' + frame)) == pytest.approx(100 * 1152 / 44100)
    cbr = b'\xff\xfb\x90\x00' + b'\x00' * (16000 - 4)
    assert media.duration(*_reader(cbr)) == pytest.approx(16000 * 8 / 128000)


def test_a_flac_by_its_streaminfo():
    info = bytearray(34)
    rate, samples = 16000, 16000 * 7
    info[10], info[11], info[12] = rate >> 12, (rate >> 4) & 0xFF, (rate & 0x0F) << 4
    info[13] = (samples >> 32) & 0x0F
    info[14:18] = struct.pack('>I', samples & 0xFFFFFFFF)
    data = b'fLaC' + bytes([0, 0, 0, 34]) + bytes(info) + b'\x00' * 100
    assert media.duration(*_reader(data)) == pytest.approx(7)


@pytest.mark.parametrize('data', [b'OggS' + b'\x00' * 200, b'\x1aE\xdf\xa3' + b'\x00' * 200, b'', b'RIFF'])
def test_another_format_or_a_broken_header_is_of_unknown_length(data):
    assert media.duration(*_reader(data)) is None


def test_clocks():
    assert media.clock(None) == '?' and media.clock(62.4) == '1:02' and media.clock(3723) == '1:02:03'
    assert media.at_time(12.34) == '0:12.3' and media.at_time(3725.06) == '1:02:05.1'


# --- the reads, over a fixture with segments ------------------------------------------

def _aligned():
    """The fixture with a time-alignment layer: three segments, the first
    over "Ali-di gam" (0.5-2.0 s), the second over "akuna." (2.0-3.25 s, so
    sentence 1 is 0.5-3.25), the third over all of sentence 2 (4.0-5.0 s)."""
    raw = project_raw()
    raw['text_layers'][0]['token_layers'].append(
        {'id': ALIGN, 'name': 'Time alignment', 'overlap_mode': 'non-overlapping',
         'config': {'plaid': {'role': 'time-alignment'}}, 'span_layers': []})
    doc = document_raw()
    doc['text_layers'][0]['token_layers'].append({'id': ALIGN, 'tokens': [
        {'id': 'a-1', 'begin': 0, 'end': 10, 'metadata': {'timeBegin': 0.5, 'timeEnd': 2.0, 'speaker': 'A'}},
        {'id': 'a-2', 'begin': 11, 'end': 17, 'metadata': {'timeBegin': 2.0, 'timeEnd': 3.25}},
        {'id': 'a-3', 'begin': 18, 'end': 25, 'metadata': {'timeBegin': 4.0, 'timeEnd': 5.0}}],
        'span_layers': []})
    return raw, doc


def _ws(monkeypatch, seconds=None):
    raw, doc = _aligned()
    client = FakeClient(project=raw)
    client._documents['d1'] = doc
    if seconds is not None:
        client._documents['d1']['media_url'] = '/api/v1/documents/d1/media?v=1-2'
        monkeypatch.setattr(media, 'recording_seconds', lambda ws, did, url: seconds)
        monkeypatch.setattr(stats, 'recording_seconds', lambda ws, did, url: seconds)
    return fake_ws(client)


def test_corpus_stats_says_the_minutes_transcribed_and_the_recordings(monkeypatch):
    w = _ws(monkeypatch, seconds=125.0)
    out = for_model(call_tool(w, 'corpus_stats', {}))
    assert ('Time alignment: 3 segments in 1 document, 0:04 transcribed (segment lengths summed); '
            'recordings: 1 document, 2:05 in all.') in out, out
    out = for_model(call_tool(w, 'corpus_stats', {'by': 'document'}))
    assert out.splitlines()[0].endswith('segments\ttranscribed\trecording\tDate')
    assert '\t3\t0:04\t2:05\t2020' in out, out


def test_a_project_with_no_segments_says_nothing_of_time():
    out = call_tool(fake_ws(FakeClient()), 'corpus_stats', {})
    assert 'Time alignment' not in out and 'recording' not in out


def test_a_read_shows_where_each_sentence_is_in_the_recording(monkeypatch):
    w = _ws(monkeypatch, seconds=125.0)
    out = for_model(call_tool(w, 'read_document', {'document': 'Text 1'}))
    head = out.splitlines()[0]
    assert head.endswith('recording 2:05; 3 time-aligned segments, 0:04 transcribed; @start-end after a sentence '
                         'is where it is in the recording'), head
    assert '[s1] Ali-di gam akuna. @0:00.5-0:03.2' in out or '[s1] Ali-di gam akuna. @0:00.5-0:03.3' in out
    assert '[s2] Gam-ar. @0:04.0-0:05.0' in out


@require_sandbox()
def test_run_code_sees_the_segments_and_the_recording(monkeypatch):
    w = _ws(monkeypatch, seconds=125.0)
    code = ('d = load("Text 1")\n'
            'print(round(sum(g["end"] - g["start"] for g in d["segments"]), 2), d["sentences"][1]["time"], '
            'recording("Text 1"), d["segments"][0]["speaker"])')
    out = call_tool(w, 'run_code', {'code': code})
    assert '3.75 [4.0, 5.0] 125.0 A' in out, out


# --- over the wire, against a real core -----------------------------------------------

@pytest.fixture(scope='module')
def proj(live_client):
    s = seed(live_client, project_raw(), {'d1': document_raw()}, {VOCAB: lexicon_raw()}, name='igt-agent time')
    c = s.client
    tl = s.ids[igt_fx.TEXT_LAYER]
    layer = c.token_layers.create(tl, 'Time alignment', overlap_mode='non-overlapping')
    lid = layer['id'] if isinstance(layer, dict) else layer
    c.token_layers.set_config(lid, 'plaid', 'role', 'time-alignment')
    doc = s.ids['d1']
    text = s.ids[igt_fx.TEXT_ID]
    c.tokens.create(lid, text, 0, 10, metadata={'timeBegin': 0.5, 'timeEnd': 2.0})
    c.tokens.create(lid, text, 18, 25, metadata={'timeBegin': 4.0, 'timeEnd': 5.25})
    c.documents.upload_media(doc, ('talk.wav', _wav(3.5), 'audio/wav'))
    yield s
    s.delete()


def test_the_recording_is_read_through_its_media_link_and_the_segments_by_query(proj):
    c = proj.client
    ws = Workspace(c, load_project(c, proj.project_id))
    out = for_model(call_tool(ws, 'corpus_stats', {}))
    assert ('Time alignment: 2 segments in 1 document, 0:03 transcribed (segment lengths summed); '
            'recordings: 1 document, 0:04 in all.') in out, out
    doc = proj.ids['d1']
    url = c.documents.get(doc)['media_url']
    assert media.recording_seconds(ws, doc, url) == pytest.approx(3.5)
    out = for_model(call_tool(ws, 'read_document', {'document': 'Text 1'}))
    assert 'recording 0:04; 2 time-aligned segments' in out and '@0:04.0-0:05.2' in out, out
