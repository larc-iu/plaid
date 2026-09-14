"""The Whisper transcribe service's REQUEST HANDLER, driven end to end.

Whisper itself is replaced at its one seam (``whisper.load_model``), the media
download at ``requests.get``, and the document at the client, so a whole run --
fetch, download, transcribe, write, report -- happens in milliseconds with no
model and no server.

Run: pytest plaid-igt/services/tests
"""

import argparse
import threading
import types

import pytest
import servicetest
from plaid_client.http import PlaidAPIError
from plaid_client.workflows.asr import alignment_processor as ap_module

DOC = 'd1'
TEXT_LAYER = 'text-layer'
ALIGN_LAYER = 'align-layer'
SENTENCE_LAYER = 'sentence-layer'
MEDIA_URL = '/api/v1/documents/d1/media?v=3'
SOURCE = 'service:asr:whisper-asr'

REQUEST = {
    'document_id': DOC,
    'text_layer_id': TEXT_LAYER,
    'alignment_token_layer_id': ALIGN_LAYER,
    'sentence_token_layer_id': SENTENCE_LAYER,
    'model_size': 'small',
    'language': 'tr',
    'overwrite': False,
}

SEGMENTS = [
    {'text': ' evler geliyor', 'start': 0.0, 'end': 1.5,
     'avg_logprob': -0.25, 'no_speech_prob': 0.01},
    {'text': ' kedi uyuyor', 'start': 1.5, 'end': 3.0,
     'avg_logprob': -0.4, 'no_speech_prob': 0.02},
]


# --- the seams ---------------------------------------------------------------

class _Transcriber:
    """Stands in for a loaded Whisper model."""

    device = 'cpu'

    def __init__(self, calls, segments, before_return=None):
        self._calls = calls
        self._segments = segments
        self._before_return = before_return

    def transcribe(self, audio_path, **options):
        self._calls.append(('transcribe', audio_path, options))
        if self._before_return:
            self._before_return()
        return {'segments': self._segments}


def fake_whisper(segments=SEGMENTS, before_return=None):
    """A ``whisper`` module that loads instantly and transcribes to order."""
    module = types.ModuleType('whisper')
    module.calls = []
    module.load_model = lambda name: (
        module.calls.append(('load_model', name))
        or _Transcriber(module.calls, segments, before_return))
    return module


def load_whisper(segments=SEGMENTS, before_return=None):
    module = fake_whisper(segments, before_return)
    service = servicetest.load_service('igt_transcribe_whisper', {'whisper': module})
    return service, module


def _media(monkeypatch, size=3 << 20, chunks=3):
    """A media file that arrives in ``chunks`` pieces, recording the request."""
    seen = {}

    class _Response:
        headers = {'Content-Length': str(size)}

        def raise_for_status(self):
            pass

        def iter_content(self, chunk_size=None):
            for _ in range(chunks):
                yield b'\0' * (size // chunks)

    def get(url, stream=None, headers=None, timeout=None):
        seen['url'] = url
        seen['headers'] = headers
        return _Response()

    monkeypatch.setattr(ap_module.requests, 'get', get)
    return seen


def _document(*, body='', media_url=MEDIA_URL, sentences=(), align=(), sentence_spans=()):
    return {
        'id': DOC,
        'version': 58,
        'media_url': media_url,
        'text_layers': [{
            'id': TEXT_LAYER,
            'text': {'id': 'text-1', 'body': body},
            'token_layers': [
                {'id': ALIGN_LAYER, 'name': 'Alignment',
                 'tokens': [{'id': f'a{i}', 'begin': b, 'end': e,
                             'metadata': {'timeBegin': tb, 'timeEnd': te}}
                            for i, (b, e, tb, te) in enumerate(align)]},
                {'id': SENTENCE_LAYER, 'name': 'Sentences',
                 'tokens': [{'id': f's{i}', 'begin': b, 'end': e}
                            for i, (b, e) in enumerate(sentences)],
                 'span_layers': [{'id': 'note', 'name': 'Note', 'spans': list(sentence_spans)}],
                 'vocabs': []},
            ],
        }],
    }


def _service(module, fails=None, documents=None, model='base'):
    service = module.WhisperASRService()
    service.setup(argparse.Namespace(model=model, no_keep_loaded=False))
    service.client = servicetest.FakeClient(documents or [_document()], fails=fails)
    return service


# --- the happy path ----------------------------------------------------------

def test_a_transcription_lands_stamped_machine_made_and_never_confirmed(monkeypatch):
    _media(monkeypatch)
    module, whisper = load_whisper()
    service = _service(module)
    helper = servicetest.run(service, REQUEST)

    assert helper.errors == []
    [result] = helper.results
    assert result['status'] == 'success'
    assert result['document_id'] == DOC
    assert result['segments_transcribed'] == 2
    assert result['tokens_created'] == 2
    assert 'stopped' not in result

    # The text gained both segments, and each got an alignment token stamped
    # machine-made with the model's own scores in provDetail.
    [(text_id, edits)] = service.client.payloads('texts.update')
    assert text_id == 'text-1'
    assert [op['value'] for op in edits] == ['evler geliyor ', 'kedi uyuyor']

    [ops] = [ops for ops in service.client.payloads('tokens.bulk_create')
             if ops[0]['token_layer_id'] == ALIGN_LAYER]
    assert [(op['begin'], op['end']) for op in ops] == [(0, 13), (14, 25)]
    for op, segment in zip(ops, SEGMENTS):
        meta = op['metadata']
        assert meta['prov'] == 'inferred'
        assert meta['provSource'] == SOURCE
        assert 'provConfirmed' not in meta
        assert 'provProb' not in meta          # avg_logprob is not a probability
        assert meta['provDetail'] == {'model': 'whisper-small',
                                      'avgLogprob': segment['avg_logprob'],
                                      'noSpeechProb': segment['no_speech_prob']}
        assert meta['timeBegin'] == segment['start'] and meta['timeEnd'] == segment['end']

    # The per-request model size is what got loaded, and the language was forced.
    assert ('load_model', 'small') in whisper.calls
    assert [call[2] for call in whisper.calls if call[0] == 'transcribe'] == [{'language': 'tr'}]
    # One audit entry names the run, and the writes sit under it.
    assert service.client.operations == ['Whisper ASR transcription (tr)']


def test_the_token_and_the_sentence_partition_go_in_one_batch(monkeypatch):
    _media(monkeypatch)
    module, _ = load_whisper()
    service = _service(module)
    servicetest.run(service, REQUEST)
    kinds = [kind for kind, _ in service.client.writes]
    # text edit, the alignment tokens, then the sentence partition reset --
    # all of it queued and submitted together.
    assert kinds == ['texts.update', 'tokens.bulk_create', 'tokens.bulk_create']
    assert service.client.operations == ['Whisper ASR transcription (tr)']


# --- the lock ----------------------------------------------------------------

def test_the_lock_is_taken_before_the_writes_and_released_after_them(monkeypatch):
    _media(monkeypatch)
    module, _ = load_whisper()
    service = _service(module)
    servicetest.run(service, REQUEST)
    kinds = service.client.kinds
    assert kinds.count('lock') == 1 and kinds.count('unlock') == 1
    writes = [i for i, k in enumerate(kinds) if k.startswith(('texts.', 'tokens.'))]
    assert kinds.index('lock') < min(writes)
    assert kinds.index('unlock') > max(writes)


def test_the_lock_is_released_when_a_write_fails(monkeypatch):
    _media(monkeypatch)
    module, _ = load_whisper()
    service = _service(module, fails={'tokens.bulk_create': PlaidAPIError(
        'HTTP 500 Internal error at http://plaid.internal:8085/api/v1/tokens/bulk',
        status=500, url='http://plaid.internal:8085/api/v1/tokens/bulk', method='POST')})
    helper = servicetest.run(service, REQUEST)

    assert service.client.kinds[-1] == 'unlock'
    # The batch aborted, so not even the text edit that preceded the failure
    # reached the server.
    assert service.client.writes == []
    assert len(helper.errors) == 1


def test_the_lock_is_never_taken_when_the_run_is_stopped_before_the_writes(monkeypatch):
    _media(monkeypatch)
    module, _ = load_whisper()
    service = _service(module)
    # Stop during the transcription: the checkpoint that follows it is the last
    # one before anything is written.
    helper = servicetest.Helper(stop_when=lambda pct, msg: msg.startswith('Transcribing'))
    servicetest.run(service, REQUEST, helper)

    assert 'lock' not in service.client.kinds
    assert [kind for kind, _ in service.client.writes] == []
    assert helper.reports == [('completed', {'stopped': True})]


# --- the plan is built from a read taken under the lock ----------------------

def test_the_writes_are_planned_from_a_read_taken_under_the_lock(monkeypatch):
    """Whisper does not call ``check_unchanged``, and does not need to: the
    read every write is planned from (collision detection, insertion offsets,
    the protected-annotation guard) happens AFTER the lock is taken, so there
    is no window for the document to move underneath it. The first read is for
    the media URL alone. Moving that planning read before the lock would put
    this service back in the shape ``check_unchanged`` exists for."""
    _media(monkeypatch)
    module, _ = load_whisper()
    service = _service(module)
    servicetest.run(service, REQUEST)

    kinds = service.client.kinds
    reads = [i for i, k in enumerate(kinds) if k == 'read']
    lock = kinds.index('lock')
    assert reads[0] < lock, 'the media-URL read comes first'
    assert len([i for i in reads if i > lock]) == 2, \
        'the planning read and the read-back both happen under the lock'
    assert kinds.index('unlock') > reads[-1]


def test_a_document_that_moved_under_the_lock_is_what_the_run_writes_against(monkeypatch):
    """The same fact from the other side: the second read is the one the plan
    uses, so a segment that collides in time with a token added since the
    first read is dropped rather than written twice."""
    _media(monkeypatch)
    module, _ = load_whisper()
    before = _document()
    after = _document(body='evler geliyor', align=[(0, 13, 0.0, 1.5)])
    service = _service(module, documents=[before, after, after])
    helper = servicetest.run(service, REQUEST)

    [result] = helper.results
    assert result['tokens_created'] == 1          # the colliding segment was dropped
    [ops] = [ops for ops in service.client.payloads('tokens.bulk_create')
             if ops[0]['token_layer_id'] == ALIGN_LAYER]
    assert [op['metadata']['timeBegin'] for op in ops] == [1.5]


# --- refusals ----------------------------------------------------------------

def test_a_document_with_no_media_is_refused_once_in_its_own_words(monkeypatch):
    _media(monkeypatch)
    module, _ = load_whisper()
    service = _service(module, documents=[_document(media_url=None)])
    helper = servicetest.run(service, REQUEST)

    assert helper.reports == [('error', 'No media file attached to document')]
    assert service.client.writes == []


def test_a_missing_parameter_is_reported_once_and_nothing_is_read(monkeypatch):
    _media(monkeypatch)
    module, _ = load_whisper()
    service = _service(module)
    helper = servicetest.run(service, {**REQUEST, 'alignment_token_layer_id': None})

    assert helper.reports == [('error', 'Missing required parameter: alignmentTokenLayerId')]
    assert service.client.calls == []


def test_human_work_the_reset_would_delete_refuses_the_run_once(monkeypatch):
    _media(monkeypatch)
    module, _ = load_whisper()
    human = {'id': 'sp1', 'tokens': ['s0'], 'value': 'a note', 'metadata': {}}
    doc = _document(body='already here', sentences=[(0, 12)],
                    align=[(0, 12, 9.0, 10.0)], sentence_spans=[human])
    service = _service(module, documents=[doc])
    helper = servicetest.run(service, REQUEST)

    assert len(helper.errors) == 1
    assert 'human-made or human-verified' in helper.errors[0]
    assert 'overwrite enabled' in helper.errors[0]
    # It fails closed, inside the batch and before submit, so nothing at all
    # reached the server.
    assert service.client.writes == []
    assert service.client.kinds[-1] == 'unlock'


def test_a_failure_reaches_the_requester_once_without_an_internal_url(monkeypatch):
    _media(monkeypatch)
    module, _ = load_whisper()
    service = _service(module, fails={'texts.update': PlaidAPIError(
        'HTTP 400 Text edit out of range at http://plaid.internal:8085/api/v1/texts/text-1',
        status=400, url='http://plaid.internal:8085/api/v1/texts/text-1', method='PATCH')})
    helper = servicetest.run(service, REQUEST)

    assert helper.errors == ['Whisper ASR: HTTP 400 Text edit out of range']
    assert 'plaid.internal' not in helper.errors[0] and 'http' not in helper.errors[0]


def test_a_download_failure_names_what_failed_and_not_where(monkeypatch):
    module, _ = load_whisper()
    service = _service(module)

    def get(url, **kwargs):
        raise Exception('404 Client Error: Not Found for url: '
                        'http://plaid.internal:8085/api/v1/documents/d1/media?v=3')

    monkeypatch.setattr(ap_module.requests, 'get', get)
    helper = servicetest.run(service, REQUEST)

    assert len(helper.errors) == 1
    assert helper.errors[0] == ("The document's media file could not be downloaded "
                                '(404 Client Error: Not Found).')
    assert 'plaid.internal' not in helper.errors[0]


def test_a_recording_with_no_speech_in_it_is_refused_once(monkeypatch):
    _media(monkeypatch)
    module, _ = load_whisper(segments=[])
    service = _service(module)
    helper = servicetest.run(service, REQUEST)

    assert helper.reports == [('error', 'No transcription results generated')]
    assert service.client.writes == []


# --- progress through the long stretches -------------------------------------

def test_the_download_says_how_far_in_it_is(monkeypatch):
    seen = _media(monkeypatch, size=30 << 20, chunks=3)
    module, _ = load_whisper()
    service = _service(module)
    helper = servicetest.run(service, REQUEST)

    downloads = [(pct, msg) for pct, msg in helper.beats if msg.startswith('Downloading')]
    assert downloads[0] == (10, 'Downloading media file...')
    assert [msg for _, msg in downloads[1:]] == [
        'Downloading media file (10 MB of 30 MB)...',
        'Downloading media file (20 MB of 30 MB)...',
        'Downloading media file (30 MB of 30 MB)...',
    ]
    assert [pct for pct, _ in downloads[1:]] == [16, 23, 30]
    # The token rides in a header, never in the URL: a media URL already
    # carries a `?v=` cache-buster, and a second `?` swallowed the token.
    assert seen['url'] == 'http://plaid.internal:8085' + MEDIA_URL
    assert seen['headers'] == {'Authorization': 'Bearer tok'}


def test_the_transcription_keeps_talking_while_it_runs(monkeypatch):
    """One blocking call, an hour of audio, nothing to poll inside it. The
    heartbeat is the only thing between a working run and a requester who
    gives up on the silence."""
    _media(monkeypatch)
    beaten = threading.Event()
    module, _ = load_whisper(before_return=lambda: beaten.wait(5))
    # The beat's interval is an argument, so a test can ask for it in
    # milliseconds rather than waiting out the real 20 seconds.
    real_heartbeat = module.progress_heartbeat
    module.progress_heartbeat = (
        lambda helper, percent, message, interval_s=0.01:
        real_heartbeat(helper, percent, message, interval_s=0.01))

    class _Counting(servicetest.Helper):
        def progress(self, percent, msg='', **extra):
            super().progress(percent, msg, **extra)
            if self.messages.count('Transcribing audio...') >= 3:
                beaten.set()

    service = _service(module)
    helper = servicetest.run(service, REQUEST, _Counting())

    assert beaten.is_set(), 'the blocking call went quiet'
    assert helper.messages.count('Transcribing audio...') >= 3
    assert helper.errors == [] and len(helper.results) == 1
    # …and the beat stops with the block rather than running on into the writes.
    after_writing = helper.messages[helper.messages.index('ASR processing completed successfully'):]
    assert 'Transcribing audio...' not in after_writing


# --- stopping ----------------------------------------------------------------

@pytest.mark.parametrize('stop_at', ['Fetching document...', 'Downloading media file...',
                                     'Transcribing audio...'])
def test_a_stop_before_the_writes_ends_the_run_with_one_report(monkeypatch, stop_at):
    _media(monkeypatch)
    module, _ = load_whisper()
    service = _service(module)
    helper = servicetest.run(
        service, REQUEST, servicetest.Helper(stop_when=lambda pct, msg: msg == stop_at))

    assert helper.reports == [('completed', {'stopped': True})]
    assert service.client.writes == []


def test_a_stop_that_lands_in_the_writes_is_ignored_and_the_run_finishes(monkeypatch):
    """Luke's ruling: a stop with nothing left to prevent is silently ignored.
    Everything from the lock to the final report sits in one critical block, so
    a stop pressed while the document is half-written finishes the job and
    reports what it did rather than calling a written document stopped."""
    _media(monkeypatch)
    module, _ = load_whisper()
    service = _service(module)
    helper = servicetest.run(
        service, REQUEST,
        servicetest.Helper(stop_when=lambda pct, msg: msg.startswith('Committing')))

    assert helper.cancelled, 'the stop never landed, so this proves nothing'
    [result] = helper.results
    assert result['status'] == 'success' and 'stopped' not in result
    assert result['tokens_created'] == 2
    assert service.client.kinds[-1] == 'unlock'


def test_a_second_request_is_rejected_rather_than_queued(monkeypatch):
    """The model is one shared, single-flight resource. A concurrent request is
    told to try again, not made to wait past its requester's deadline."""
    _media(monkeypatch)
    release = threading.Event()
    module, _ = load_whisper(before_return=lambda: release.wait(5))
    service = _service(module)

    first = servicetest.Helper()
    thread = service.handle_service_request(dict(REQUEST), first)
    second = servicetest.Helper()
    for _ in range(500):                       # wait for the first to be in flight
        if first.beats:
            break
        release.wait(0.01)
    assert service.handle_service_request(dict(REQUEST), second) is None
    assert len(second.errors) == 1 and 'another request' in second.errors[0]
    release.set()
    thread.join(10)
    assert len(first.results) == 1
