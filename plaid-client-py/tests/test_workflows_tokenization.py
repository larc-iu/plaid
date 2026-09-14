"""Tests for the tokenization workflow's document rewrite.

The 500 lines that every tokenize service runs had no test of their own. Run::

    cd plaid-client-py && python -m pytest tests/ -q
"""

import contextlib
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.workflows.tokenization import TokenProcessor, TokenSpan  # noqa: E402


class _Helper:
    """A response helper that remembers every terminal report, so a test can
    see a request reported twice."""

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
    """Enough of PlaidClient to drive TokenProcessor: a document to read back,
    and a log of every write it is asked to make."""

    def __init__(self, document):
        self.document = document
        self.calls = []
        self.locked_documents = []
        self.batches = []
        self.documents = self._Documents(self)
        self.tokens = self._Tokens(self)

    @contextlib.contextmanager
    def batched(self):
        opened = len(self.calls)
        self.batches.append(None)
        yield self
        self.batches[-1] = self.calls[opened:]

    class _Documents:
        def __init__(self, client):
            self._client = client

        def get(self, document_id, include_body=None):
            return self._client.document

        @contextlib.contextmanager
        def locked(self, document_id):
            self._client.locked_documents.append(document_id)
            self._client.calls.append(('lock', document_id))
            try:
                yield
            finally:
                self._client.calls.append(('unlock', document_id))

    class _Tokens:
        def __init__(self, client):
            self._client = client

        def bulk_create(self, ops):
            self._client.calls.append(('bulk_create', list(ops)))

        def bulk_delete(self, ids):
            self._client.calls.append(('bulk_delete', list(ids)))

        def delete(self, token_id):
            self._client.calls.append(('delete', token_id))


def _document(body, *, sentences=(), words=(), sentence_spans=(), sentence_links=()):
    """A document body shaped the way ``documents.get(include_body=True)``
    returns one: one text layer, a word layer, a sentence layer."""
    return {
        'text_layers': [{
            'id': 'text-layer',
            'text': {'id': 'text-1', 'body': body},
            'token_layers': [
                {'id': 'word-layer', 'name': 'Words',
                 'tokens': [{'id': f'w{i}', 'begin': b, 'end': e}
                            for i, (b, e) in enumerate(words)]},
                {'id': 'sentence-layer', 'name': 'Sentences',
                 'tokens': [{'id': f's{i}', 'begin': b, 'end': e}
                            for i, (b, e) in enumerate(sentences)],
                 'span_layers': [{'id': 'note-layer', 'name': 'Note',
                                  'spans': list(sentence_spans)}],
                 'vocabs': [{'id': 'v1', 'vocab_links': list(sentence_links)}]},
            ],
        }],
    }


def _spans(text):
    return [TokenSpan(text=text, start=0, end=len(text))]


def test_a_refused_run_raises_instead_of_reporting_over_its_caller():
    # The sentence reset would cascade away a human-made annotation. The
    # refusal must reach the caller as an exception: reporting it here and
    # returning zero counts let the caller's own `complete` land on top of the
    # error, so the requester was told the run both failed and succeeded.
    human_span = {'id': 'sp1', 'tokens': ['s0'], 'value': 'a note', 'metadata': {}}
    doc = _document('Hello there.', sentences=[(0, 12)], words=[],
                    sentence_spans=[human_span])
    client = _FakeClient(doc)
    helper = _Helper()
    with pytest.raises(ValueError) as caught:
        TokenProcessor().process_tokens(
            client, 'd1', _spans('Hello there.'),
            [TokenSpan(text='Hello', start=0, end=5)],
            'word-layer', 'sentence-layer', helper,
            text_layer_id='text-layer')
    assert 'human-made or human-verified' in str(caught.value)
    assert helper.errors == [] and helper.done == []
    # Nothing was written, and the lock it took was given back.
    assert [c for c in client.calls if c[0] in ('bulk_create', 'bulk_delete', 'delete')] == []
    assert client.calls[0] == ('lock', 'd1') and client.calls[-1] == ('unlock', 'd1')


def test_a_machine_annotation_is_not_in_the_way():
    machine = {'id': 'sp1', 'tokens': ['s0'], 'value': 'guess',
               'metadata': {'prov': 'inferred', 'provSource': 'service:x'}}
    doc = _document('Hello there.', sentences=[(0, 12)], words=[],
                    sentence_spans=[machine])
    client = _FakeClient(doc)
    counts = TokenProcessor().process_tokens(
        client, 'd1', _spans('Hello there.'),
        [TokenSpan(text='Hello', start=0, end=5)],
        'word-layer', 'sentence-layer', _Helper(),
        text_layer_id='text-layer')
    assert counts['sentences_created'] == 1


def test_an_empty_document_is_refused_in_words_not_in_zeroes():
    client = _FakeClient(_document('   ', sentences=[], words=[]))
    with pytest.raises(ValueError) as caught:
        TokenProcessor().process_tokens(client, 'd1', [], [], 'word-layer',
                                        'sentence-layer', _Helper(),
                                        text_layer_id='text-layer')
    assert 'no text' in str(caught.value)


def test_a_missing_word_layer_is_refused():
    client = _FakeClient(_document('Hello.', sentences=[(0, 6)]))
    with pytest.raises(ValueError):
        TokenProcessor().process_tokens(client, 'd1', _spans('Hello.'),
                                        [TokenSpan(text='Hello', start=0, end=5)],
                                        'no-such-layer', 'sentence-layer', _Helper(),
                                        text_layer_id='text-layer')


def test_split_tokens_are_deleted_in_one_op_however_many_there_are():
    # Two existing sentences, so the partition is left alone and the words that
    # straddle the boundary are deleted individually. One op per token put an
    # unbounded number of sub-ops in a single batch (the server caps it at
    # 1000) and made the whole batch fail on any id that had already gone.
    body = 'ab cd ef gh'
    crossing = [(0, 5), (3, 8), (6, 11)]
    doc = _document(body, sentences=[(0, 6), (6, 11)], words=crossing)
    client = _FakeClient(doc)
    TokenProcessor().process_tokens(
        client, 'd1', _spans(body),
        [TokenSpan(text='ab', start=0, end=2)],
        'word-layer', 'sentence-layer', _Helper(),
        text_layer_id='text-layer')
    deletes = [c for c in client.calls if c[0] == 'delete']
    bulk = [c for c in client.calls if c[0] == 'bulk_delete']
    assert deletes == []
    # Only the token that really straddles the boundary goes. w2 sits inside
    # the second sentence and merely contains a piece w1 was cut into, which
    # used to be read as "w2 was split too".
    assert bulk == [('bulk_delete', ['w1'])]


def test_a_document_edited_since_it_was_read_is_not_tokenized():
    # The text was read, and tokenized, before the lock was taken. An edit in
    # between moved every offset, so the run is refused rather than cutting the
    # text in the places the old string had.
    doc = _document('Hello there.', sentences=[(0, 12)], words=[])
    doc['version'] = 59
    client = _FakeClient(doc)
    helper = _Helper()
    with pytest.raises(ValueError) as caught:
        TokenProcessor().process_tokens(
            client, 'd1', _spans('Hello there.'),
            [TokenSpan(text='Hello', start=0, end=5)],
            'word-layer', 'sentence-layer', helper,
            text_layer_id='text-layer', expect_version=58)
    assert 'changed while this run was working' in str(caught.value)
    assert helper.errors == [] and helper.done == []
    assert [c for c in client.calls if c[0] in ('bulk_create', 'bulk_delete')] == []


def test_the_same_document_is_tokenized():
    doc = _document('Hello there.', sentences=[(0, 12)], words=[])
    doc['version'] = 58
    client = _FakeClient(doc)
    counts = TokenProcessor().process_tokens(
        client, 'd1', _spans('Hello there.'),
        [TokenSpan(text='Hello', start=0, end=5)],
        'word-layer', 'sentence-layer', _Helper(),
        text_layer_id='text-layer', expect_version=58)
    assert counts['sentences_created'] == 1
