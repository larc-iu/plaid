"""Read-only time alignment for the igt assistant (survey item 11, Luke
2026-10-15): the segments' times and the recording's length in corpus_stats,
read_document and run_code, so "how many minutes are transcribed" is one
call. Nothing here writes."""

import copy
import io
import wave

import pytest

import fixtures as igt_fx
from fixtures import FakeClient, fake_ws, project_raw, document_raw, lexicon_raw, VOCAB
from live import live_client, require_sandbox, seed  # noqa: F401 - fixture

from plaid_agent.core.bidi import for_model
from plaid_agent.igt import media
from plaid_agent.igt.project import load_project
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.workspace import Workspace

ALIGN = 'tk-align'


# --- the clocks ---------------------------------------------------------------------

def _wav(seconds: float, rate: int = 8000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b'\x00\x00' * int(rate * seconds))
    return buf.getvalue()


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
        client._documents['d1']['media_duration'] = seconds
    return fake_ws(client)


def test_a_recording_of_unknown_length_says_so(monkeypatch):
    w = _ws(monkeypatch, seconds=125.0)
    w.client._documents['d1']['media_duration'] = None
    out = for_model(call_tool(w, 'corpus_stats', {'by': 'document'}))
    assert '\t3\t0:04\t?\t2020' in out, out


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
            'recording("Text 1"), d["segments"][0]["speaker"])\n'
            'print([recording(e) for e in documents()])')
    out = call_tool(w, 'run_code', {'code': code})
    assert '3.75 [4.0, 5.0] 125.0 A' in out and '[125.0]' in out, out


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


def test_the_recording_length_is_the_one_core_stored_at_upload_and_the_segments_by_query(proj):
    c = proj.client
    ws = Workspace(c, load_project(c, proj.project_id))
    out = for_model(call_tool(ws, 'corpus_stats', {}))
    assert ('Time alignment: 2 segments in 1 document, 0:03 transcribed (segment lengths summed); '
            'recordings: 1 document, 0:04 in all; in 1 document the segments run past the end of the '
            'recording.') in out, out
    doc = proj.ids['d1']
    assert c.documents.get(doc)['media_duration'] == pytest.approx(3.5)
    assert media.recording_of(ws, doc) == (True, pytest.approx(3.5))
    out = for_model(call_tool(ws, 'read_document', {'document': 'Text 1'}))
    assert 'recording 0:04 (segments run to 0:05, past its end at 0:04); 2 time-aligned segments' in out and '@0:04.0-0:05.2' in out, out


def test_a_time_near_a_whole_minute_reads_as_the_next_minute():
    """H16-IGT-TOOLS-7: rounded to tenths before the minutes are taken."""
    assert media.at_time(59.97) == '1:00.0' and media.at_time(119.96) == '2:00.0'
    assert media.at_time(3599.97) == '1:00:00.0' and media.at_time(59.94) == '0:59.9'


def test_segments_past_the_end_of_the_recording_are_said(monkeypatch):
    w = _ws(monkeypatch, seconds=4.5)
    out = for_model(call_tool(w, 'read_document', {'document': 'Text 1'}))
    assert 'recording 0:04 (segments run to 0:05, past its end at 0:04)' in out.splitlines()[0], out
    out = for_model(call_tool(w, 'corpus_stats', {}))
    assert 'in 1 document the segments run past the end of the recording.' in out, out


def test_recordings_all_of_unknown_length_say_so(monkeypatch):
    w = _ws(monkeypatch, seconds=125.0)
    w.client._documents['d1']['media_duration'] = None
    out = for_model(call_tool(w, 'corpus_stats', {}))
    assert 'recordings: 1 document, of unknown length.' in out and '0:00 in all' not in out, out


def test_a_length_stored_after_the_document_was_parsed_is_read_on_the_next_turn(proj):
    """H16-REVIEW-5: a length can be stored without a new version,
    and a parse is kept for its version, so the length is never taken from
    the parse. The kept parse is made to hold no length, as one made before
    a length was stored would."""
    c = proj.client
    ws = Workspace(c, load_project(c, proj.project_id))
    doc = ws.doc(proj.ids['d1'])
    assert doc.media_duration == pytest.approx(3.5)
    doc.media_duration = None  # the kept parse, as before the length was stored
    ws2 = Workspace(c, load_project(c, proj.project_id))
    assert ws2.doc(proj.ids['d1']) is doc, 'the parse is kept across turns'
    out = for_model(call_tool(ws2, 'read_document', {'document': 'Text 1'}))
    assert 'recording 0:04' in out.splitlines()[0] and 'unknown length' not in out, out
    assert 'recordings: 1 document, 0:04 in all' in for_model(call_tool(ws2, 'corpus_stats', {}))
