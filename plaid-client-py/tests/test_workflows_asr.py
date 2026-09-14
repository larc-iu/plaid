"""Tests for the ASR workflow's document rewrite.

The 700 lines that every transcribe service runs had no test of their own. Run::

    cd plaid-client-py && python -m pytest tests/ -q
"""

import contextlib
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.workflows.asr import Alignment, AlignmentProcessor  # noqa: E402

TEXT_LAYER = 'text-layer'
ALIGN_LAYER = 'align-layer'
SENTENCE_LAYER = 'sentence-layer'


class _Helper:
    def __init__(self):
        self.errors = []
        self.done = []

    def progress(self, percent, msg='', **extra):
        pass

    def complete(self, data=None):
        self.done.append(data)

    def error(self, err):
        self.errors.append(str(err))

    @contextlib.contextmanager
    def critical(self):
        yield


class _FakeClient:
    """A client that models the one thing a test of this code must get right:
    a batch that ABORTS on an exception writes nothing at all."""

    def __init__(self, documents):
        self._documents = list(documents)
        self.token = 'tok'
        self.base_url = 'http://plaid.test'
        self.calls = []
        self.reads = []
        self._queued = None
        self.documents = self._Documents(self)
        self.tokens = self._Tokens(self)
        self.texts = self._Texts(self)

    def _record(self, call):
        (self._queued if self._queued is not None else self.calls).append(call)

    @contextlib.contextmanager
    def batched(self):
        self._queued = []
        try:
            yield self
        except BaseException:
            self._queued = None          # aborted: nothing reaches the server
            raise
        queued, self._queued = self._queued, None
        self.calls.extend(queued)

    class _Documents:
        def __init__(self, client):
            self._client = client

        def get(self, document_id, include_body=None, layers=None):
            self._client.reads.append({'layers': layers})
            index = min(len(self._client.reads) - 1, len(self._client._documents) - 1)
            return self._client._documents[index]

        @contextlib.contextmanager
        def locked(self, document_id):
            self._client._record(('lock', document_id))
            try:
                yield
            finally:
                self._client._record(('unlock', document_id))

    class _Tokens:
        def __init__(self, client):
            self._client = client

        def bulk_create(self, ops):
            self._client._record(('bulk_create', list(ops)))

        def bulk_delete(self, ids):
            self._client._record(('bulk_delete', list(ids)))

    class _Texts:
        def __init__(self, client):
            self._client = client

        def update(self, text_id, ops):
            self._client._record(('text_update', list(ops)))

        def create(self, layer_id, document_id, body):
            self._client._record(('text_create', body))
            return {'id': 'text-1'}


def _document(body, *, sentences=(), align=(), sentence_spans=()):
    return {
        'id': 'd1',
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


def _run(client, helper=None, overwrite=False):
    return AlignmentProcessor().process_alignments(
        client, 'd1', [Alignment(text='hello there', start=0.0, end=1.5)],
        TEXT_LAYER, ALIGN_LAYER, SENTENCE_LAYER, helper or _Helper(),
        prov_source='service:asr:test', overwrite=overwrite)


def test_a_transcription_is_stamped_machine_made_and_lands_in_one_batch():
    client = _FakeClient([_document('')])
    created = _run(client)
    assert created == 1
    writes = [c for c in client.calls if c[0] in ('text_update', 'bulk_create', 'bulk_delete')]
    kinds = [c[0] for c in writes]
    assert kinds[0] == 'text_update'
    token_ops = next(c[1] for c in writes if c[0] == 'bulk_create'
                     and c[1][0]['token_layer_id'] == ALIGN_LAYER)
    assert token_ops[0]['metadata']['prov'] == 'inferred'
    assert token_ops[0]['metadata']['provSource'] == 'service:asr:test'
    assert token_ops[0]['metadata']['timeBegin'] == 0.0


def test_the_sentence_reset_refuses_to_take_a_persons_work_with_it():
    # The reset cascade-deletes every sentence-level annotation. It fails
    # CLOSED, inside the batch and before submit, so nothing at all is written.
    human = {'id': 'sp1', 'tokens': ['s0'], 'value': 'a note', 'metadata': {}}
    client = _FakeClient([_document('already here', sentences=[(0, 12)],
                                    align=[(0, 12, 5.0, 6.0)], sentence_spans=[human])])
    with pytest.raises(ValueError) as caught:
        _run(client)
    assert 'human-made or human-verified' in str(caught.value)
    assert [c for c in client.calls if c[0] in ('text_update', 'bulk_create', 'bulk_delete')] == []
    assert client.calls[0] == ('lock', 'd1') and client.calls[-1] == ('unlock', 'd1')


def test_overwrite_lets_the_reset_through():
    human = {'id': 'sp1', 'tokens': ['s0'], 'value': 'a note', 'metadata': {}}
    client = _FakeClient([_document('already here', sentences=[(0, 12)],
                                    align=[(0, 12, 5.0, 6.0)], sentence_spans=[human])])
    assert _run(client, overwrite=True) == 1
    assert any(c[0] == 'bulk_delete' for c in client.calls)


def test_the_invariants_are_checked_against_the_document_the_writes_left(capsys):
    # The sentence check used to be handed the document as it was BEFORE the
    # batch, so it reported on the partition the run had just replaced.
    before = _document('')
    after = _document('hello there', sentences=[(0, 8), (4, 11)],
                      align=[(0, 11, 0.0, 1.5)])
    client = _FakeClient([before, after])
    _run(client)
    printed = capsys.readouterr().out
    assert 'Sentence partitioning invariant violated' in printed
    # And it reads only the two layers it checks, not a transcribed recording's
    # whole body.
    assert client.reads[-1]['layers'] == [ALIGN_LAYER, SENTENCE_LAYER]


def test_a_partition_the_run_left_whole_says_nothing(capsys):
    before = _document('')
    after = _document('hello there', sentences=[(0, 11)], align=[(0, 11, 0.0, 1.5)])
    client = _FakeClient([before, after])
    _run(client)
    assert 'invariant violated' not in capsys.readouterr().out
