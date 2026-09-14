"""Tests for the tokenization workflow's document rewrite.

The 500 lines that every tokenize service runs had no test of their own. Run::

    cd plaid-client-py && python -m pytest tests/ -q
"""

import contextlib
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.workflows.tokenization import (  # noqa: E402
    TokenProcessor, TokenSpan, helpers, tokenizer_model,
)


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


class _Batch:
    """What ``batched()`` yields: the client's resources bound to this batch,
    so a write made on it queues until ``submit``. Everything the batch does
    not have itself is the client's."""

    def __init__(self, client):
        self.client = client
        self.queued = []
        self.results = []
        self.documents = client._Documents(self)
        self.tokens = client._Tokens(self)

    def __getattr__(self, name):
        return getattr(self.client, name)

    def _record(self, call):
        self.queued.append(call)

    def submit(self):
        queued, self.queued = self.queued, []
        self.client.calls.extend(queued)
        self.client.batches.append(queued)
        self.results = [{'body': {'id': f'new-{i}'}} for i in range(len(queued))]
        return self.results

    def abort(self):
        self.queued = []


class _FakeClient:
    """Enough of PlaidClient to drive TokenProcessor: a document to read back,
    and a log of every write it is asked to make. A write made on the CLIENT
    goes out at once whatever batches are open; one made on a batch queues
    until it submits, and an aborted batch writes nothing."""

    def __init__(self, document):
        self.document = document
        self.calls = []
        self.locked_documents = []
        self.batches = []
        self.documents = self._Documents(self)
        self.tokens = self._Tokens(self)

    def _record(self, call):
        self.calls.append(call)

    def batch(self):
        return _Batch(self)

    @contextlib.contextmanager
    def batched(self):
        batch = _Batch(self)
        try:
            yield batch
        except BaseException:
            batch.abort()
            raise
        batch.submit()

    class _Documents:
        def __init__(self, owner):
            self._owner = owner

        def get(self, document_id, include_body=None):
            return self._owner.document

        @contextlib.contextmanager
        def locked(self, document_id):
            self._owner.locked_documents.append(document_id)
            self._owner._record(('lock', document_id))
            try:
                yield
            finally:
                self._owner._record(('unlock', document_id))

    class _Tokens:
        def __init__(self, owner):
            self._owner = owner

        def bulk_create(self, ops):
            self._owner._record(('bulk_create', list(ops)))

        def bulk_delete(self, ids):
            self._owner._record(('bulk_delete', list(ids)))

        def delete(self, token_id):
            self._owner._record(('delete', token_id))


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


# --- the converters a service author builds on -------------------------------
# helpers is in the package's __all__, so these are public surface. Nothing in
# this repo calls four of them, which is exactly why they need a test: a break
# would otherwise first be noticed by somebody writing their own service.

class _SpacyToken:
    def __init__(self, text, idx, is_space=False):
        self.text = text
        self.idx = idx
        self.is_space = is_space
        self.pos_ = 'NOUN'
        self.lemma_ = text.lower()
        self.is_alpha = text.isalpha()
        self.is_punct = not text.isalnum()


class _SpacySent:
    def __init__(self, text, start_char, end_char):
        self.text = text
        self.start_char = start_char
        self.end_char = end_char


class _SpacyDoc:
    def __init__(self, sents, tokens):
        self.sents = sents
        self._tokens = tokens

    def __iter__(self):
        return iter(self._tokens)


def test_spans_from_spacy_doc_keeps_character_positions_and_skips_whitespace():
    text = 'Dogs bark. Cats nap.'
    doc = _SpacyDoc(
        [_SpacySent('Dogs bark.', 0, 10), _SpacySent('Cats nap.', 11, 20)],
        [_SpacyToken('Dogs', 0), _SpacyToken(' ', 4, is_space=True),
         _SpacyToken('bark', 5), _SpacyToken('.', 9), _SpacyToken('Cats', 11)])
    sentences, words = helpers.spans_from_spacy_doc(doc)
    assert [(s.start, s.end) for s in sentences] == [(0, 10), (11, 20)]
    assert [(w.text, w.start, w.end) for w in words] == [
        ('Dogs', 0, 4), ('bark', 5, 9), ('.', 9, 10), ('Cats', 11, 15)]
    assert words[0].metadata['lemma'] == 'dogs' and words[0].metadata['pos'] == 'NOUN'


class _Encoding:
    def __init__(self, offset_mapping, input_ids):
        self.offset_mapping = offset_mapping
        self.input_ids = input_ids
        self.attention_mask = [1] * len(input_ids)


class _HfTokenizer:
    """Shaped like a fast HuggingFace tokenizer: callable, with an offset
    mapping whose special tokens are zero-width."""

    def __init__(self, offsets, ids, pieces=()):
        self._offsets = offsets
        self._ids = ids
        self._pieces = list(pieces)

    def __call__(self, text, return_offsets_mapping=True):
        return _Encoding(self._offsets, self._ids)

    def tokenize(self, text):
        return self._pieces


def test_spans_from_transformers_tokenizer_reads_the_offset_mapping():
    text = 'unhappy dog'
    tok = _HfTokenizer([(0, 0), (0, 2), (2, 7), (8, 11), (0, 0)],
                       [101, 5, 6, 7, 102])
    spans = helpers.spans_from_transformers_tokenizer(text, tok)
    # The zero-width special tokens at either end are not spans.
    assert [(s.text, s.start, s.end) for s in spans] == [
        ('un', 0, 2), ('happy', 2, 7), ('dog', 8, 11)]
    assert spans[0].metadata['token_id'] == 5


def test_a_tokenizer_without_offsets_falls_back_to_finding_the_strings():
    text = 'unhappy dog'
    tok = _HfTokenizer([], [], pieces=['un', 'happy', 'dog'])
    spans = helpers.spans_from_transformers_tokenizer(text, tok, return_offsets_mapping=False)
    assert [(s.text, s.start, s.end) for s in spans] == [
        ('un', 0, 2), ('happy', 2, 7), ('dog', 8, 11)]


def test_spans_from_whitespace_splits_sentences_on_newlines_and_words_on_space():
    text = 'one two\n\nthree four\nfive'
    sentences, words = helpers.spans_from_whitespace(text)
    assert [s.text for s in sentences] == ['one two', 'three four', 'five']
    assert [(w.text, w.start) for w in words] == [
        ('one', 0), ('two', 4), ('three', 9), ('four', 15), ('five', 20)]
    # Text with no newline at all is one sentence covering all of it.
    only, _ = helpers.spans_from_whitespace('just this')
    assert [(s.start, s.end) for s in only] == [(0, 9)]


def test_spans_from_tokens_walks_forward_and_drops_what_it_cannot_place():
    text = 'the cat sat on the mat'
    spans = helpers.spans_from_tokens(text, ['the', 'cat', ' ', 'sat', 'zebra', 'the'])
    assert [(s.text, s.start) for s in spans] == [
        ('the', 0), ('cat', 4), ('sat', 8), ('the', 15)]
    # The second "the" is the later one: positions only ever move forward, so a
    # repeated token cannot land back on the first occurrence.
    assert spans[-1].start > spans[0].start


def test_spans_from_nltk_spans_drops_empty_and_whitespace_only_ranges():
    text = 'ab  cd'
    spans = tokenizer_model.spans_from_nltk_spans(text, [(0, 2), (2, 4), (4, 6), (6, 6)])
    assert [(s.text, s.start, s.end) for s in spans] == [('ab', 0, 2), ('cd', 4, 6)]


class _FakePunkt:
    """A Punkt model stands for its span_tokenize, which is all the converter
    asks it for. The Treebank word tokenizer beneath it is the real one."""

    def __init__(self, spans):
        self._spans = spans

    def span_tokenize(self, text):
        return list(self._spans)


def test_spans_from_nltk_punkt_makes_the_sentences_tile_the_whole_text():
    # The helper's word tokenizer is nltk's; the package does not depend on it.
    pytest.importorskip('nltk')
    # The sentence layer is partitioning, so the converter that feeds it must
    # leave no gap: the first sentence is pulled back to 0, each one runs to
    # where the next begins, and the last runs to the end of the text.
    text = '  Dogs bark. Cats nap.  '
    sentences, words = helpers.spans_from_nltk_punkt(text, _FakePunkt([(2, 12), (13, 22)]))
    assert [(s.start, s.end) for s in sentences] == [(0, 13), (13, len(text))]
    assert sentences[0].end == sentences[1].start
    assert [w.text for w in words] == ['Dogs', 'bark', '.', 'Cats', 'nap', '.']
    # Word positions are absolute, not relative to their sentence.
    assert all(text[w.start:w.end] == w.text for w in words)


def test_text_punkt_finds_no_sentence_in_is_one_sentence():
    # The helper's word tokenizer is nltk's; the package does not depend on it.
    pytest.importorskip('nltk')
    text = 'no boundaries here'
    sentences, words = helpers.spans_from_nltk_punkt(text, _FakePunkt([]))
    assert [(s.start, s.end) for s in sentences] == [(0, len(text))]
    assert [w.text for w in words] == ['no', 'boundaries', 'here']
